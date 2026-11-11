package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"studiotv.local/service/api/internal/auth/oidcrp"
	"studiotv.local/service/api/internal/httpapi"
)

func statusTestServer(t *testing.T, mutate func(*sessionStatus)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/oidc/session-status" {
			t.Errorf("unexpected status endpoint %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		id, secret, ok := r.BasicAuth()
		if !ok || id != "test-client" || secret != "test-only-secret" {
			t.Error("missing backend Basic application credentials")
			w.WriteHeader(401)
			return
		}
		var request sessionStatusRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			w.WriteHeader(400)
			return
		}
		result := sessionStatus{Active: true, AuthenticationProvider: "feishu", AMR: []string{"feishu"}, SubjectID: request.SubjectID, SessionID: request.SessionID, CurrentSessionVersion: runtime.Uint64String(request.SessionVersion), ExpiresAt: time.Now().Add(2 * time.Hour)}
		if mutate != nil {
			mutate(&result)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}))
	t.Cleanup(server.Close)
	return server
}

func statusTestService(base string) *Service {
	return &Service{cfg: Config{IssuerURL: "https://ipac.example", BaseURL: base, ClientID: "test-client", ClientSecret: "test-only-secret"}}
}

func TestSessionStatusChecksLiveIdentitySourceExpiryAndRevocation(t *testing.T) {
	identity := oidcrp.Identity{SubjectID: "person", SessionID: "sid", SessionVersion: 4}
	cases := []struct {
		name   string
		mutate func(*sessionStatus)
		code   string
	}{
		{"feishu", nil, ""},
		{"revoked", func(s *sessionStatus) { s.Active = false }, "IPAC_SESSION_REVOKED"},
		{"subject_mismatch", func(s *sessionStatus) { s.SubjectID = "another" }, "IPAC_SESSION_REVOKED"},
		{"sid_mismatch", func(s *sessionStatus) { s.SessionID = "another" }, "IPAC_SESSION_REVOKED"},
		{"version_changed", func(s *sessionStatus) { s.CurrentSessionVersion = 5 }, "IPAC_SESSION_REVOKED"},
		{"expired", func(s *sessionStatus) { s.ExpiresAt = time.Now().Add(-time.Minute) }, "IPAC_SESSION_REVOKED"},
		{"password_source", func(s *sessionStatus) { s.AuthenticationProvider = "external_password"; s.AMR = []string{"pwd"} }, "FEISHU_IDENTITY_REQUIRED"},
		{"unknown_source", func(s *sessionStatus) { s.AuthenticationProvider = "unknown" }, "FEISHU_IDENTITY_REQUIRED"},
		{"inconsistent_amr", func(s *sessionStatus) { s.AMR = []string{"pwd"} }, "FEISHU_IDENTITY_REQUIRED"},
		{"mixed_amr", func(s *sessionStatus) { s.AMR = []string{"feishu", "pwd"} }, "FEISHU_IDENTITY_REQUIRED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := statusTestServer(t, tc.mutate)
			_, err := statusTestService(server.URL).verifiedSession(context.Background(), identity)
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var api *httpapi.Error
			if !errors.As(err, &api) || api.Code != tc.code {
				t.Fatalf("expected %s, got %v", tc.code, err)
			}
		})
	}
}

func TestSessionStatusFailClosedAndNeverForwardsCredentials(t *testing.T) {
	leaked := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; w.WriteHeader(200) }))
	defer destination.Close()
	for _, behavior := range []string{"unavailable", "invalid", "missing_protocol", "redirect", "auth_failed"} {
		t.Run(behavior, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch behavior {
				case "unavailable":
					w.WriteHeader(503)
				case "auth_failed":
					w.WriteHeader(401)
				case "invalid":
					_, _ = w.Write([]byte("{"))
				case "missing_protocol":
					_, _ = w.Write([]byte("{}"))
				case "redirect":
					http.Redirect(w, r, destination.URL, 302)
				}
			}))
			defer server.Close()
			_, err := statusTestService(server.URL).verifiedSession(context.Background(), oidcrp.Identity{SubjectID: "p", SessionID: "s", SessionVersion: 1})
			var api *httpapi.Error
			if !errors.As(err, &api) || api.Status != 503 {
				t.Fatal("upstream failure did not remain retryable and fail closed", err)
			}
		})
	}
	if leaked {
		t.Fatal("Basic credentials reached a redirected origin")
	}
}

func TestConfiguredWithVerifiedSessionStatusProtocolLease(t *testing.T) {
	var calls atomic.Uint64
	server := statusTestServer(t, func(s *sessionStatus) {
		calls.Add(1)
		s.Active = false
		s.AuthenticationProvider = "unknown"
		s.AMR = []string{}
		s.CurrentSessionVersion = 0
		s.ExpiresAt = time.Time{}
	})
	s := statusTestService(server.URL)
	w := httptest.NewRecorder()
	if err := s.configuration(w, httptest.NewRequest("GET", "/api/v1/auth/config", nil)); err != nil || !strings.Contains(w.Body.String(), `"configured":true`) {
		t.Fatal("valid inactive readiness probe rejected", err, w.Body.String())
	}
	server.Close()
	w = httptest.NewRecorder()
	if err := s.configuration(w, httptest.NewRequest("GET", "/api/v1/auth/config", nil)); err != nil || !strings.Contains(w.Body.String(), `"configured":true`) || calls.Load() != 1 {
		t.Fatal("verified protocol lease was not reused", err, w.Body.String(), calls.Load())
	}
	// The generic lease tests advance their clock through the exact five-minute
	// boundary. Invalidate here to exercise the next live protocol check.
	s.protocolLease().Delete(true)
	w = httptest.NewRecorder()
	if err := s.configuration(w, httptest.NewRequest("GET", "/api/v1/auth/config", nil)); err != nil || !strings.Contains(w.Body.String(), `"configured":false`) || !strings.Contains(w.Body.String(), "IPAC_SESSION_STATUS_UNAVAILABLE") {
		t.Fatal("offline provider advertised as configured", err, w.Body.String())
	}
}

func TestCachedSessionKeysFullIdentityAndForcesLoginRefreshLive(t *testing.T) {
	var calls atomic.Uint64
	var active atomic.Bool
	active.Store(true)
	server := statusTestServer(t, func(state *sessionStatus) {
		calls.Add(1)
		state.Active = active.Load()
	})
	s := statusTestService(server.URL)
	identity := oidcrp.Identity{SubjectID: "person", SessionID: "sid", SessionVersion: 4}
	if _, err := s.verifiedSession(context.Background(), identity); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := s.cachedVerifiedSession(context.Background(), identity); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("fresh login/refresh verification did not seed the ordinary lease", calls.Load())
	}
	for _, other := range []oidcrp.Identity{
		{SubjectID: "another", SessionID: identity.SessionID, SessionVersion: identity.SessionVersion},
		{SubjectID: identity.SubjectID, SessionID: "another", SessionVersion: identity.SessionVersion},
		{SubjectID: identity.SubjectID, SessionID: identity.SessionID, SessionVersion: identity.SessionVersion + 1},
	} {
		if _, err := s.cachedVerifiedSession(context.Background(), other); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 4 {
		t.Fatal("session lease mixed different subject, sid or version", calls.Load())
	}
	// The raw protocol adapter remains uncached for explicit live checks.
	request := sessionStatusRequest{SubjectID: identity.SubjectID, SessionID: identity.SessionID, SessionVersion: identity.SessionVersion}
	for i := 0; i < 2; i++ {
		if _, err := s.status(context.Background(), request); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 6 {
		t.Fatal("raw session status unexpectedly cached", calls.Load())
	}
	active.Store(false)
	if _, err := s.cachedVerifiedSession(context.Background(), identity); err != nil || calls.Load() != 6 {
		t.Fatal("ordinary request did not use its existing bounded lease", err, calls.Load())
	}
	_, err := s.verifiedSession(context.Background(), identity)
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Code != "IPAC_SESSION_REVOKED" || calls.Load() != 7 {
		t.Fatal("login/refresh accepted a cached upstream revocation", err, calls.Load())
	}
	if _, err = s.cachedVerifiedSession(context.Background(), identity); !isSessionRevoked(err) || calls.Load() != 7 {
		t.Fatal("confirmed upstream denial did not replace the earlier positive lease", err, calls.Load())
	}
	active.Store(true)
	if _, err = s.verifiedSession(context.Background(), identity); err != nil || calls.Load() != 8 {
		t.Fatal("forced live verification reused a negative lease", err, calls.Load())
	}
}

func TestCachedSessionCoalescesConcurrentChecks(t *testing.T) {
	var calls atomic.Uint64
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	server := statusTestServer(t, func(*sessionStatus) {
		calls.Add(1)
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
	})
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	s := statusTestService(server.URL)
	identity := oidcrp.Identity{SubjectID: "person", SessionID: "sid", SessionVersion: 4}
	const count = 24
	errors := make(chan error, count)
	for i := 0; i < count; i++ {
		go func() {
			_, err := s.cachedVerifiedSession(context.Background(), identity)
			errors <- err
		}()
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("session verification did not start")
	}
	releaseOnce.Do(func() { close(release) })
	for i := 0; i < count; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("concurrent session checks were not coalesced", calls.Load())
	}
}

func TestCachedSessionRejectsExpiredResponseAfterLeaseInvalidation(t *testing.T) {
	var calls atomic.Uint64
	var expired atomic.Bool
	server := statusTestServer(t, func(state *sessionStatus) {
		calls.Add(1)
		if expired.Load() {
			state.ExpiresAt = time.Now().Add(-time.Second)
		}
	})
	s := statusTestService(server.URL)
	identity := oidcrp.Identity{SubjectID: "person", SessionID: "sid", SessionVersion: 4}
	if _, err := s.cachedVerifiedSession(context.Background(), identity); err != nil {
		t.Fatal(err)
	}
	expired.Store(true)
	s.sessionLease().Delete(sessionStatusRequest{SubjectID: identity.SubjectID, SessionID: identity.SessionID, SessionVersion: identity.SessionVersion})
	_, err := s.cachedVerifiedSession(context.Background(), identity)
	if !isSessionRevoked(err) || calls.Load() != 2 {
		t.Fatal("an expired upstream response extended the old positive lease", err, calls.Load())
	}
}

func TestConfigurationRejectsInactiveProbeWithAnExpiry(t *testing.T) {
	var calls atomic.Uint64
	var valid atomic.Bool
	server := statusTestServer(t, func(state *sessionStatus) {
		calls.Add(1)
		state.Active = false
		state.AuthenticationProvider = "unknown"
		state.AMR = []string{}
		state.CurrentSessionVersion = 0
		// An unknown session must have null expires_at. Keeping an apparently
		// valid lifetime is a protocol mismatch, not a healthy readiness response.
		state.ExpiresAt = time.Now().Add(time.Hour)
		if valid.Load() {
			state.ExpiresAt = time.Time{}
		}
	})
	s := statusTestService(server.URL)
	w := httptest.NewRecorder()
	if err := s.configuration(w, httptest.NewRequest("GET", "/api/v1/auth/config", nil)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(w.Body.String(), `"configured":false`) || !strings.Contains(w.Body.String(), "IPAC_SESSION_STATUS_UNAVAILABLE") {
		t.Fatal("inactive status with a fabricated expiry advertised a configured login", w.Body.String())
	}
	valid.Store(true)
	w = httptest.NewRecorder()
	if err := s.configuration(w, httptest.NewRequest("GET", "/api/v1/auth/config", nil)); err != nil || !strings.Contains(w.Body.String(), `"configured":false`) || calls.Load() != 1 {
		t.Fatal("malformed protocol result was not briefly suppressed as an error", err, w.Body.String(), calls.Load())
	}
	// The generic lease tests advance past its two-second error lifetime.
	s.protocolLease().Delete(true)
	w = httptest.NewRecorder()
	if err := s.configuration(w, httptest.NewRequest("GET", "/api/v1/auth/config", nil)); err != nil || !strings.Contains(w.Body.String(), `"configured":true`) || calls.Load() != 2 {
		t.Fatal("a new healthy probe did not recover after invalidation", err, w.Body.String(), calls.Load())
	}
}
