package authorization

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	ipacruntime "studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/ipaclease"
)

type runtimeStub struct {
	mu        sync.Mutex
	scopes    ipacruntime.EffectiveScopes
	scopesErr error
	checks    []ipacruntime.CheckRequest
	requested ipacruntime.EffectiveScopesRequest
	calls     int
	load      func(context.Context, ipacruntime.EffectiveScopesRequest) (ipacruntime.EffectiveScopes, error)
}

func (s *runtimeStub) Check(_ context.Context, r ipacruntime.CheckRequest) (ipacruntime.Decision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checks = append(s.checks, r)
	return ipacruntime.Decision{}, errors.New("redundant runtime Check must not be used")
}
func (s *runtimeStub) EffectiveScopes(ctx context.Context, r ipacruntime.EffectiveScopesRequest) (ipacruntime.EffectiveScopes, error) {
	s.mu.Lock()
	s.calls++
	s.requested = r
	scopes, err, load := s.scopes, s.scopesErr, s.load
	s.mu.Unlock()
	if load != nil {
		return load(ctx, r)
	}
	return scopes, err
}
func (s *runtimeStub) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}
func trustedRuntime() *runtimeStub {
	return &runtimeStub{scopes: ipacruntime.EffectiveScopes{SubjectStatus: "ACTIVE", ApplicationStatus: "ACTIVE", CurrentSessionVersion: 3, CacheTTLSeconds: 300, Scopes: []ipacruntime.EffectiveScope{{ProjectID: "ipac-project", EnvironmentID: "ipac-env", CapabilityCodes: []string{TVAccess}}}}}
}

type sessionStub struct {
	mu      sync.Mutex
	revoked string
	count   int
	err     error
}

func (s *sessionStub) RevokeSession(_ context.Context, sid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revoked = sid
	s.count++
	return s.err
}
func (s *sessionStub) AuthenticateSession(_ context.Context, uid, sid string) (httpapi.Identity, error) {
	p := testPrincipal()
	if uid != p.UserID || sid != p.SessionID {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "invalid")
	}
	return p, s.err
}
func testPrincipal() httpapi.Identity {
	return httpapi.Identity{UserID: "usr_1", SessionID: "ses_local", IPACIssuer: "https://ipac.example.test", IPACSubjectID: "subject_1", IPACSessionID: "session_ipac", IPACSessionVersion: 3}
}
func status(t *testing.T, err error, want int) {
	t.Helper()
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Status != want {
		t.Fatalf("wanted %d got %v", want, err)
	}
}

func TestTrustedEffectiveGrantIsCachedWithoutRuntimeCheck(t *testing.T) {
	client := trustedRuntime()
	service := New(client, "cli_test", &sessionStub{})
	if err := service.Check(context.Background(), testPrincipal(), TVAccess); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(client.requested, ipacruntime.EffectiveScopesRequest{SubjectID: "subject_1", SessionVersion: 3, CapabilityCodes: []string{TVAccess}}) || len(client.checks) != 0 {
		t.Fatal("authorization must use only the trusted principal and effective grants")
	}
	// Upstream changes are observed at the lease boundary, not on every API.
	client.scopes.Scopes = nil
	if err := service.Check(context.Background(), testPrincipal(), TVAccess); err != nil || client.callCount() != 1 {
		t.Fatalf("subsequent call did not use the bounded lease: %v calls=%d", err, client.callCount())
	}
	status(t, New(client, "cli_test", nil).Check(context.Background(), testPrincipal(), TVAccess), 403)
	status(t, New(nil, "", nil).Check(context.Background(), testPrincipal(), TVAccess), 503)
	status(t, service.Check(context.Background(), httpapi.Identity{UserID: "usr_1"}, TVAccess), 401)
	status(t, service.Check(context.Background(), testPrincipal(), "unknown.permission"), 403)
}

func TestEffectiveScopeEvidenceCannotGrantMissingOrInvalidAccess(t *testing.T) {
	cases := []struct {
		name   string
		change func(*runtimeStub)
		want   int
	}{
		{"revoked tool", func(c *runtimeStub) { c.scopes.Scopes = nil }, 403},
		{"other capability only", func(c *runtimeStub) { c.scopes.Scopes[0].CapabilityCodes = []string{"unknown.permission"} }, 403},
		{"capability must match exactly", func(c *runtimeStub) {
			c.scopes.Scopes[0].CapabilityCodes = []string{"TV.ACCESS", "tv.access.extra", " tv.access"}
		}, 403},
		{"blank trusted project", func(c *runtimeStub) { c.scopes.Scopes[0].ProjectID = " " }, 503},
		{"blank trusted environment", func(c *runtimeStub) { c.scopes.Scopes[0].EnvironmentID = "" }, 503},
		{"invalid additional grant", func(c *runtimeStub) {
			c.scopes.Scopes = append(c.scopes.Scopes, ipacruntime.EffectiveScope{ProjectID: "", EnvironmentID: "env", CapabilityCodes: []string{TVAccess}})
		}, 503},
		{"subject disabled", func(c *runtimeStub) { c.scopes.SubjectStatus = "DISABLED" }, 403},
		{"subject missing", func(c *runtimeStub) { c.scopes.SubjectStatus = "NOT_FOUND" }, 403},
		{"subject status absent", func(c *runtimeStub) { c.scopes.SubjectStatus = "" }, 403},
		{"application disabled", func(c *runtimeStub) { c.scopes.ApplicationStatus = "DISABLED" }, 403},
		{"application missing", func(c *runtimeStub) { c.scopes.ApplicationStatus = "NOT_FOUND" }, 403},
		{"application status absent", func(c *runtimeStub) { c.scopes.ApplicationStatus = "" }, 403},
		{"response session stale", func(c *runtimeStub) { c.scopes.CurrentSessionVersion = 4 }, 401},
		{"response session version absent", func(c *runtimeStub) { c.scopes.CurrentSessionVersion = 0 }, 401},
		{"typed stale session", func(c *runtimeStub) { c.scopesErr = ipacruntime.ErrStaleSession }, 401},
		{"upstream offline", func(c *runtimeStub) { c.scopesErr = errors.New("offline") }, 503},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := trustedRuntime()
			tc.change(client)
			sessions := &sessionStub{}
			service := New(client, "cli_test", sessions)
			status(t, service.Check(context.Background(), testPrincipal(), TVAccess), tc.want)
			status(t, service.Check(context.Background(), testPrincipal(), TVAccess), tc.want)
			if client.callCount() != 1 || len(client.checks) != 0 {
				t.Fatal("invalid evidence must fail closed and suppress repeated upstream failures")
			}
			if tc.want == 401 && (sessions.revoked != "ses_local" || sessions.count != 2) {
				t.Fatal("each stale caller must revoke its own local session outside the loader")
			}
		})
	}
}

func TestAnyGrantedScopeCanAuthorizeWholeTool(t *testing.T) {
	client := trustedRuntime()
	client.scopes.Scopes = []ipacruntime.EffectiveScope{
		{ProjectID: "irrelevant", EnvironmentID: "irrelevant", CapabilityCodes: []string{"unknown.permission"}},
		{ProjectID: "another-project", EnvironmentID: "another-env", CapabilityCodes: []string{TVAccess}},
	}
	if err := New(client, "cli_test", nil).Check(context.Background(), testPrincipal(), TVAccess); err != nil || len(client.checks) != 0 {
		t.Fatalf("any effective grant must permit the whole tool without selecting a business partition: %v", err)
	}
}

func TestConcurrentChecksShareOneEffectiveScopesFill(t *testing.T) {
	client := trustedRuntime()
	started, release := make(chan struct{}), make(chan struct{})
	client.load = func(context.Context, ipacruntime.EffectiveScopesRequest) (ipacruntime.EffectiveScopes, error) {
		close(started)
		<-release
		return client.scopes, nil
	}
	service := New(client, "cli_test", nil)
	const callers = 32
	results := make(chan error, callers)
	for i := 0; i < callers; i++ {
		go func() { results <- service.Check(context.Background(), testPrincipal(), TVAccess) }()
	}
	<-started
	close(release)
	for i := 0; i < callers; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if client.callCount() != 1 || len(client.checks) != 0 {
		t.Fatalf("concurrent API calls amplified authorization: scopes=%d checks=%d", client.callCount(), len(client.checks))
	}
}

func TestPermissionLeaseExpiryObservesRevocationAndDoesNotServeStaleOnFailure(t *testing.T) {
	for _, offline := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoked", true: "unavailable"}[offline], func(t *testing.T) {
			client := trustedRuntime()
			service := New(client, "cli_test", nil)
			service.leases = ipaclease.New[leaseKey, bool](30 * time.Millisecond)
			if err := service.Check(context.Background(), testPrincipal(), TVAccess); err != nil {
				t.Fatal(err)
			}
			client.scopes.Scopes = nil
			want := 403
			if offline {
				client.scopesErr, want = errors.New("offline"), 503
			}
			time.Sleep(40 * time.Millisecond)
			status(t, service.Check(context.Background(), testPrincipal(), TVAccess), want)
			status(t, service.Check(context.Background(), testPrincipal(), TVAccess), want)
			if client.callCount() != 2 {
				t.Fatal("expired positive grant was reused or repeated failures were not suppressed")
			}
		})
	}
}

func TestPermissionLeaseKeysIsolateTrustedIdentity(t *testing.T) {
	changes := []struct {
		name   string
		change func(*Service, *httpapi.Identity)
	}{
		{"application", func(s *Service, _ *httpapi.Identity) { s.applicationID = "other-app" }},
		{"issuer", func(_ *Service, p *httpapi.Identity) { p.IPACIssuer = "https://other.example.test" }},
		{"subject", func(_ *Service, p *httpapi.Identity) { p.IPACSubjectID = "other-subject" }},
		{"upstream session", func(_ *Service, p *httpapi.Identity) { p.IPACSessionID = "other-upstream-session" }},
		{"session version", func(_ *Service, p *httpapi.Identity) { p.IPACSessionVersion++ }},
		{"local session", func(_ *Service, p *httpapi.Identity) { p.SessionID = "other-local-session" }},
		{"local user", func(_ *Service, p *httpapi.Identity) { p.UserID = "other-user" }},
	}
	for _, tc := range changes {
		t.Run(tc.name, func(t *testing.T) {
			client := trustedRuntime()
			service := New(client, "cli_test", nil)
			p := testPrincipal()
			if err := service.Check(context.Background(), p, TVAccess); err != nil {
				t.Fatal(err)
			}
			tc.change(service, &p)
			client.scopes.Scopes = nil
			client.scopes.CurrentSessionVersion = ipacruntime.Uint64String(p.IPACSessionVersion)
			status(t, service.Check(context.Background(), p, TVAccess), 403)
			if client.callCount() != 2 {
				t.Fatal("an earlier principal's positive lease crossed identity boundaries")
			}
		})
	}
}

func TestPermissionLeaseHonorsSDKAndLocalExpiryBounds(t *testing.T) {
	for _, ttl := range []int32{-1, 0, 1, 300, 600} {
		client := trustedRuntime()
		client.scopes.CacheTTLSeconds = ttl
		before := time.Now()
		allowed, expires, err := New(client, "cli_test", nil).loadGrant(context.Background(), testPrincipal())
		if err != nil || !allowed {
			t.Fatal(err)
		}
		want := ipaclease.Lifetime
		if ttl > 0 && ttl < 300 {
			want = time.Duration(ttl) * time.Second
		}
		if expires.Before(before.Add(want)) || expires.After(time.Now().Add(want)) {
			t.Fatalf("TTL %d exceeded its allowed bound: %v", ttl, expires.Sub(before))
		}
	}
	client := trustedRuntime()
	service := New(client, "cli_test", nil)
	p := testPrincipal()
	p.SessionExpiresAt = time.Now().Add(30 * time.Millisecond)
	if err := service.Check(context.Background(), p, TVAccess); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	status(t, service.Check(context.Background(), p, TVAccess), 401)
	if client.callCount() != 1 {
		t.Fatal("an expired local session should fail before an upstream request")
	}
}

func TestCanceledWaiterCannotRevokeLocalSessionFromSharedStaleFill(t *testing.T) {
	client := trustedRuntime()
	started, release := make(chan struct{}), make(chan struct{})
	client.load = func(context.Context, ipacruntime.EffectiveScopesRequest) (ipacruntime.EffectiveScopes, error) {
		close(started)
		<-release
		return ipacruntime.EffectiveScopes{}, ipacruntime.ErrStaleSession
	}
	sessions := &sessionStub{}
	service := New(client, "cli_test", sessions)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- service.Check(ctx, testPrincipal(), TVAccess) }()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled caller returned %v", err)
	}
	close(release)
	status(t, service.Check(context.Background(), testPrincipal(), TVAccess), 401)
	if sessions.count != 1 || sessions.revoked != "ses_local" || client.callCount() != 1 {
		t.Fatal("shared verification revoked a canceled waiter or did not serve the active waiter")
	}
}

func TestSignedSessionMustResolveTrustedPrincipal(t *testing.T) {
	service := New(nil, "cli_test", &sessionStub{})
	_, err := service.SignedIdentity(context.Background(), "usr_1", "")
	status(t, err, 401)
	_, err = service.SignedIdentity(context.Background(), "usr_1", "ses_wrong")
	status(t, err, 401)
	identity, err := service.SignedIdentity(context.Background(), "usr_1", "ses_local")
	if err != nil || identity.IPACSubjectID != "subject_1" {
		t.Fatal("signed session must resolve trusted principal")
	}
}
