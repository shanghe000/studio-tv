package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	ipacruntime "studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"studiotv.local/service/api/internal/auth"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	contract, err := filepath.Abs("../../../../contracts/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	return config.Config{
		Host: "127.0.0.1", Port: 3000, Edition: "internal",
		SigningSecret: "test-only-signing-secret-32-bytes-long", Issuer: "rhtv-service", Audience: "rhtv-web",
		PublicBaseURL: "http://localhost:18880", AllowedOrigins: []string{"http://localhost:18880"},
		StorageRoot: filepath.Join(t.TempDir(), "assets"), ContractPath: contract,
		MaxUploadBytes: 536870912, Features: map[string]bool{},
	}
}

func trustedIdentity() httpapi.Identity {
	return httpapi.Identity{UserID: "usr_test", SessionID: "ses_local", IPACIssuer: "https://ipac.example.test", IPACSubjectID: "subject_test", IPACSessionID: "ses_ipac", IPACSessionVersion: 3}
}

type identityStub struct {
	revoked   []string
	resolved  []string
	err       error
	sessionID string
}

func (s *identityStub) principal() httpapi.Identity {
	who := trustedIdentity()
	if s.sessionID != "" {
		who.SessionID = s.sessionID
	}
	return who
}

func (s *identityStub) Authenticate(_ context.Context, r *http.Request) (httpapi.Identity, error) {
	if r.Header.Get("Authorization") != "Bearer test-access" {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "sign in")
	}
	return s.principal(), s.err
}

func (s *identityStub) AuthenticateSession(_ context.Context, uid, sid string) (httpapi.Identity, error) {
	s.resolved = append(s.resolved, uid+"/"+sid)
	return s.principal(), s.err
}

func (s *identityStub) RevokeSession(_ context.Context, sid string) error {
	s.revoked = append(s.revoked, sid)
	return nil
}

func (*identityStub) RegisterRoutes(r chi.Router) {
	r.Get("/api/v1/auth/config", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
}

func testDependencies(identity authentication, closed *int) dependencies {
	return dependencies{
		open:    func(context.Context, string) (*pgxpool.Pool, error) { return nil, nil },
		ping:    func(context.Context, *pgxpool.Pool) error { return nil },
		migrate: func(context.Context, *pgxpool.Pool) error { return nil },
		close:   func(*pgxpool.Pool) { (*closed)++ },
		authenticate: func(config.Config, *pgxpool.Pool, *security.Tokens) (authentication, error) {
			return identity, nil
		},
		authorize: func(_ config.Config, sessions authorization.SessionVerifier) (*authorization.Service, error) {
			return authorization.New(nil, "", sessions), nil
		},
	}
}

func TestInitializationFailureClosesDatabaseAndRedactsErrors(t *testing.T) {
	failure := errors.New("test-sensitive-value")
	tests := []struct {
		name, stage string
		change      func(*testing.T, *config.Config, *dependencies)
		modules     []ModulesRegistrar
		wantClosed  int
	}{
		{"open", "database configuration", func(_ *testing.T, _ *config.Config, d *dependencies) {
			d.open = func(context.Context, string) (*pgxpool.Pool, error) { return nil, failure }
		}, nil, 0},
		{"ping", "database connection", func(_ *testing.T, _ *config.Config, d *dependencies) {
			d.ping = func(context.Context, *pgxpool.Pool) error { return failure }
		}, nil, 1},
		{"migration", "database migration", func(_ *testing.T, _ *config.Config, d *dependencies) {
			d.migrate = func(context.Context, *pgxpool.Pool) error { return failure }
		}, nil, 1},
		{"authentication", "authentication configuration", func(_ *testing.T, _ *config.Config, d *dependencies) {
			d.authenticate = func(config.Config, *pgxpool.Pool, *security.Tokens) (authentication, error) { return nil, failure }
		}, nil, 1},
		{"missing authentication", "authentication configuration", func(_ *testing.T, _ *config.Config, d *dependencies) {
			d.authenticate = func(config.Config, *pgxpool.Pool, *security.Tokens) (authentication, error) { return nil, nil }
		}, nil, 1},
		{"authorization", "authorization configuration", func(_ *testing.T, _ *config.Config, d *dependencies) {
			d.authorize = func(config.Config, authorization.SessionVerifier) (*authorization.Service, error) {
				return nil, failure
			}
		}, nil, 1},
		{"missing authorization", "authorization configuration", func(_ *testing.T, _ *config.Config, d *dependencies) {
			d.authorize = func(config.Config, authorization.SessionVerifier) (*authorization.Service, error) { return nil, nil }
		}, nil, 1},
		{"contract", "HTTP contract or storage initialization", func(t *testing.T, c *config.Config, _ *dependencies) {
			c.ContractPath = filepath.Join(t.TempDir(), "missing-contract.json")
		}, nil, 1},
		{"storage", "HTTP contract or storage initialization", func(t *testing.T, c *config.Config, _ *dependencies) {
			file := filepath.Join(t.TempDir(), "file")
			if err := os.WriteFile(file, []byte("file"), 0600); err != nil {
				t.Fatal(err)
			}
			c.StorageRoot = filepath.Join(file, "assets")
		}, nil, 1},
		{"module", "HTTP module initialization", nil, []ModulesRegistrar{func(chi.Router, *pgxpool.Pool) error { return failure }}, 1},
		{"missing module", "HTTP module initialization", nil, []ModulesRegistrar{nil}, 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, closed := testConfig(t), 0
			deps := testDependencies(&identityStub{}, &closed)
			if test.change != nil {
				test.change(t, &cfg, &deps)
			}
			app, err := initialize(context.Background(), cfg, deps, test.modules...)
			if app != nil || err == nil || err.Error() != test.stage || closed != test.wantClosed {
				t.Fatalf("app=%v err=%v closed=%d, want stage=%s closed=%d", app, err, closed, test.stage, test.wantClosed)
			}
		})
	}
}

func TestPreparedResourcesAndExistingRoutesRemainCompatible(t *testing.T) {
	// The explicit path must not reconstruct authorization from ambient env.
	t.Setenv("IPAC_BASE_URL", "invalid-url")
	t.Setenv("IPAC_APP_ID", "invalid-environment-client")
	t.Setenv("IPAC_APP_SECRET", "test-sensitive-value")
	t.Setenv("IPAC_ALLOW_INSECURE_HTTP", "true")
	cfg, closed := testConfig(t), 0
	app, err := initialize(context.Background(), cfg, testDependencies(&identityStub{}, &closed))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if closed != 0 {
		t.Fatal("database closed before application handoff")
	}
	if _, err := os.Stat(cfg.StorageRoot); err != nil {
		t.Fatal("storage was not prepared", err)
	}
	server, ok := app.server.(*http.Server)
	if !ok || server.Addr != "127.0.0.1:3000" || server.ReadHeaderTimeout != 10*time.Second || server.IdleTimeout != 60*time.Second || server.MaxHeaderBytes != 32*1024 {
		t.Fatal("HTTP server limits changed")
	}
	for _, test := range []struct {
		method, path, bearer, code string
		status                     int
	}{
		{"GET", "/healthz", "", "", 200},
		{"GET", "/api/v1/auth/config", "", "", 200},
		{"GET", "/api/v1/projects", "", "UNAUTHENTICATED", 401},
		{"GET", "/api/v1/projects", "Bearer test-access", "IPAC_AUTHORIZATION_UNAVAILABLE", 503},
		{"GET", "/api/v1/wallet", "", "FEATURE_DISABLED", 403},
		{"POST", "/api/v1/generation-quotes", "Bearer test-access", "FEATURE_DISABLED", 403},
		{"GET", "/api/v2/conversations", "Bearer test-access", "NOT_FOUND", 404},
		{"GET", "/api/v1/not-a-route", "", "NOT_FOUND", 404},
	} {
		r := httptest.NewRequest(test.method, test.path, nil)
		r.Header.Set("Authorization", test.bearer)
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != test.status || test.code != "" && !strings.Contains(w.Body.String(), `"code":"`+test.code+`"`) {
			t.Fatalf("%s %s: %d %s", test.method, test.path, w.Code, w.Body.String())
		}
		if strings.HasPrefix(test.path, "/api/") && (w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Request-Id") == "") {
			t.Fatal("base middleware was lost")
		}
	}
	// Once prepared, core must not read the contract again during assembly.
	resources, err := core.PrepareResources(cfg)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ContractPath = filepath.Join(t.TempDir(), "absent.json")
	if _, err := core.NewWithAuthorization(cfg, nil, &identityStub{}, nil, resources); err != nil {
		t.Fatal("explicit resources were not used", err)
	}
	app.Close()
	app.Close()
	if closed != 1 {
		t.Fatalf("database closed %d times", closed)
	}
}

type runtimeStub struct {
	allowed, stale bool
	err            error
	checks         []ipacruntime.CheckRequest
	requests       []ipacruntime.EffectiveScopesRequest
}

func (s *runtimeStub) EffectiveScopes(_ context.Context, r ipacruntime.EffectiveScopesRequest) (ipacruntime.EffectiveScopes, error) {
	s.requests = append(s.requests, r)
	if r.SubjectID != trustedIdentity().IPACSubjectID || r.SessionVersion != 3 || !reflect.DeepEqual(r.CapabilityCodes, []string{authorization.TVAccess}) {
		return ipacruntime.EffectiveScopes{}, errors.New("untrusted principal")
	}
	if s.stale {
		return ipacruntime.EffectiveScopes{}, ipacruntime.ErrStaleSession
	}
	result := ipacruntime.EffectiveScopes{SubjectStatus: "ACTIVE", ApplicationStatus: "ACTIVE", CurrentSessionVersion: 3, CacheTTLSeconds: 300}
	if s.allowed {
		result.Scopes = []ipacruntime.EffectiveScope{{ProjectID: "trusted-project", EnvironmentID: "trusted-environment", CapabilityCodes: []string{authorization.TVAccess}}}
	}
	return result, s.err
}

func (s *runtimeStub) Check(_ context.Context, r ipacruntime.CheckRequest) (ipacruntime.Decision, error) {
	s.checks = append(s.checks, r)
	return ipacruntime.Decision{Allowed: s.allowed, SubjectStatus: "ACTIVE", ApplicationStatus: "ACTIVE", CurrentSessionVersion: 3}, nil
}

func TestModulesUseExplicitSessionVerifierAndLiveTVAccess(t *testing.T) {
	cfg, closed := testConfig(t), 0
	identity, runtime := &identityStub{}, &runtimeStub{allowed: true}
	deps := testDependencies(identity, &closed)
	var access *authorization.Service
	deps.authorize = func(_ config.Config, sessions authorization.SessionVerifier) (*authorization.Service, error) {
		if sessions != identity {
			t.Fatal("wrong SessionVerifier injected")
		}
		access = authorization.New(runtime, "test-client", sessions)
		return access, nil
	}
	called := 0
	app, err := initialize(context.Background(), cfg, deps, func(r chi.Router, _ *pgxpool.Pool) error {
		r.Get("/api/v2/test-module", func(w http.ResponseWriter, r *http.Request) {
			called++
			_ = httpapi.JSON(w, 200, map[string]string{"owner": httpapi.IdentityFrom(r).UserID})
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	who := trustedIdentity()
	if _, err := access.SignedIdentity(context.Background(), who.UserID, who.SessionID); err != nil || !reflect.DeepEqual(identity.resolved, []string{who.UserID + "/" + who.SessionID}) {
		t.Fatal("signed media did not use the injected session verifier", err)
	}
	request := func(bearer, path string, status int, code string) {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", bearer)
		r.Header.Set("X-Workspace-Id", "forged-workspace")
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != status || !strings.Contains(w.Body.String(), code) {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	request("", "/api/v2/test-module", 401, "UNAUTHENTICATED")
	if len(runtime.requests) != 0 || len(runtime.checks) != 0 || called != 0 {
		t.Fatal("unauthenticated request reached authorization or module")
	}
	request("Bearer test-access", "/api/v2/test-module", 200, `"owner":"usr_test"`)
	if called != 1 || len(runtime.requests) != 1 || len(runtime.checks) != 0 {
		t.Fatal("module did not use trusted effective grants")
	}
	runtime.allowed = false
	// Each failure uses a newly verified local session, forcing fresh evidence
	// without pretending that an upstream mutation invalidates a live lease.
	identity.sessionID = "ses_denied"
	request("Bearer test-access", "/api/v2/test-module", 403, "IPAC_PERMISSION_DENIED")
	request("Bearer test-access", "/api/v1/projects", 403, "IPAC_PERMISSION_DENIED")
	runtime.err = errors.New("upstream offline")
	identity.sessionID = "ses_offline"
	request("Bearer test-access", "/api/v2/test-module", 503, "IPAC_AUTHORIZATION_UNAVAILABLE")
	if len(identity.revoked) != 0 {
		t.Fatal("temporary IPAC failure revoked a healthy session")
	}
	runtime.err, runtime.stale = nil, true
	identity.sessionID = "ses_stale"
	request("Bearer test-access", "/api/v2/test-module", 401, "IPAC_SESSION_STALE")
	if called != 1 || !reflect.DeepEqual(identity.revoked, []string{identity.sessionID}) {
		t.Fatal("revoked access reached a handler or failed to revoke the explicit local session")
	}
}

func TestAuthorizationConstructorUsesExplicitConfig(t *testing.T) {
	t.Setenv("IPAC_BASE_URL", "invalid-environment-url")
	t.Setenv("IPAC_APP_ID", "environment-client")
	t.Setenv("IPAC_APP_SECRET", "test-sensitive-value")
	identity := &identityStub{}
	access, err := newAuthorization(auth.Config{BaseURL: "https://ipac.example.test", ClientID: "explicit-client", ClientSecret: "explicit-test-secret"}, identity)
	if err != nil {
		t.Fatal("explicit authorization config was ignored", err)
	}
	if _, err := access.SignedIdentity(context.Background(), "usr_test", "ses_local"); err != nil || len(identity.resolved) != 1 {
		t.Fatal("explicit SessionVerifier was ignored", err)
	}
	access, err = newAuthorization(auth.Config{}, identity)
	if err != nil {
		t.Fatal(err)
	}
	var api *httpapi.Error
	err = access.Check(context.Background(), trustedIdentity(), authorization.TVAccess)
	if !errors.As(err, &api) || api.Status != 503 {
		t.Fatal("unconfigured authorization did not fail closed", err)
	}
	if _, err := newAuthorization(auth.Config{BaseURL: "https://test-secret@invalid.test", ClientID: "test", ClientSecret: "test-secret"}, identity); err == nil || strings.Contains(err.Error(), "test-secret") {
		t.Fatal("invalid runtime configuration leaked secret or was accepted", err)
	}
}
