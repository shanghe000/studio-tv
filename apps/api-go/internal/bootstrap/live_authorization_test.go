package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
)

type liveIdentityStub struct {
	identityStub
	headers []string
}

func (s *liveIdentityStub) Authenticate(ctx context.Context, r *http.Request) (httpapi.Identity, error) {
	s.headers = append(s.headers, r.Header.Get("Authorization"))
	if err := ctx.Err(); err != nil {
		return httpapi.Identity{}, err
	}
	return s.identityStub.Authenticate(ctx, r)
}

// The HTTP composition root reauthenticates the frozen Bearer and local session
// on every gate call while permission evidence shares its bounded lease.
func TestLiveAuthorizationRechecksFrozenBearerAndCurrentTVAccess(t *testing.T) {
	identity, runtime := &liveIdentityStub{}, &runtimeStub{allowed: true}
	closed := 0
	deps := testDependencies(identity, &closed)
	deps.authorize = func(_ config.Config, sessions authorization.SessionVerifier) (*authorization.Service, error) {
		return authorization.New(runtime, "test-client", sessions), nil
	}
	called := false
	app, err := initialize(context.Background(), testConfig(t), deps, func(r chi.Router, _ *pgxpool.Pool) error {
		r.Get("/api/v2/test-live-gate", func(w http.ResponseWriter, r *http.Request) {
			called = true
			gate := httpapi.LiveAuthorizationFrom(r).Revalidate
			if gate == nil {
				t.Fatal("trusted live authorization gate missing")
			}
			r.Header.Set("Authorization", "Bearer caller-replaced-token")
			who, err := gate(r.Context())
			if err != nil || !reflect.DeepEqual(who, trustedIdentity()) {
				t.Fatalf("frozen Bearer was not reauthenticated: identity=%+v err=%v", who, err)
			}
			runtime.allowed = false
			_, err = gate(r.Context())
			if err != nil || len(runtime.requests) != 1 || len(runtime.checks) != 0 {
				t.Fatalf("gate failed to reuse its bounded permission lease: %v", err)
			}
			// A fresh service observes the new upstream denial. Expiry is exercised
			// separately with signed media against real PostgreSQL persistence.
			err = authorization.New(runtime, "test-client", identity).Check(r.Context(), trustedIdentity(), authorization.TVAccess)
			var denied *httpapi.Error
			if !errors.As(err, &denied) || denied.Status != 403 {
				t.Fatalf("permission revocation not observed: %v", err)
			}
			identity.err = httpapi.Fail(401, "UNAUTHENTICATED", "revoked")
			_, err = gate(r.Context())
			if !errors.As(err, &denied) || denied.Status != 401 || len(runtime.requests) != 2 || len(runtime.checks) != 0 {
				t.Fatalf("local authentication revocation not checked before scope: err=%v scopes=%d", err, len(runtime.requests))
			}
			canceled, cancel := context.WithCancel(r.Context())
			cancel()
			if _, err := gate(canceled); !errors.Is(err, context.Canceled) {
				t.Fatalf("gate ignored operation cancellation: %v", err)
			}
			w.WriteHeader(http.StatusNoContent)
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	r := httptest.NewRequest(http.MethodGet, "/api/v2/test-live-gate", nil)
	r.Header.Set("Authorization", "Bearer test-access")
	w := httptest.NewRecorder()
	app.Handler().ServeHTTP(w, r)
	if !called || w.Code != http.StatusNoContent || len(identity.headers) != 5 {
		t.Fatalf("live gate not exercised: called=%v status=%d authentications=%d", called, w.Code, len(identity.headers))
	}
	for _, header := range identity.headers {
		if header != "Bearer test-access" {
			t.Fatalf("mutable request replaced frozen authentication proof: %s", header)
		}
	}
}
