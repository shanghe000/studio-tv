package http

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	"strings"
	"testing"
	"time"
)

type routeStore struct{ application.Store }

func (s routeStore) Get(_ context.Context, owner, id string) (domain.Run, error) {
	if owner != "a" || id != "agr_run" {
		return domain.Run{}, domain.ErrNotFound
	}
	return domain.Run{ID: id, Kind: "AGENT", OwnerID: owner, ParentSessionID: "sid", State: domain.WaitingAuth, CredentialEpoch: "2"}, nil
}
func (s routeStore) Events(_ context.Context, owner, id string, after int64, _ int) (domain.EventPage, error) {
	if _, e := s.Get(context.Background(), owner, id); e != nil {
		return domain.EventPage{}, e
	}
	return domain.EventPage{Items: []domain.Event{}, NextCursor: "0"}, nil
}
func routes(t *testing.T) http.Handler {
	t.Helper()
	service, e := application.New(routeStore{}, nil, nil, application.Config{})
	if e != nil {
		t.Fatal(e)
	}
	r := chi.NewRouter()
	e = RegisterRoutes(r, service, func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("missing live tv.access")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			owner := r.Header.Get("X-Test-Owner")
			sid := r.Header.Get("X-Test-Session")
			if sid == "" {
				sid = "sid"
			}
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: owner, SessionID: sid, AccessIssuedAt: time.Now().Add(-time.Minute), AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}))
		})
	})
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestReadAuthContextDoesNotTransferSessionOrReturnCredentials(t *testing.T) {
	h := routes(t)
	for _, test := range []struct {
		path, owner, sid string
		want             int
	}{{"/api/v2/agent-runs/agr_run/auth-context", "a", "sid", 200}, {"/api/v2/agent-runs/agr_run/auth-context", "a", "new", 409}, {"/api/v2/agent-runs/agr_run", "a", "new", 200}, {"/api/v2/agent-runs/agr_run/auth-context", "b", "sid", 404}} {
		r := httptest.NewRequest("GET", test.path, nil)
		r.Header.Set("X-Test-Owner", test.owner)
		r.Header.Set("X-Test-Session", test.sid)
		r.Header.Set("Authorization", "Bearer PRIVATE")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != test.want || strings.Contains(w.Body.String(), "PRIVATE") || strings.Contains(w.Body.String(), "parentSessionId") {
			t.Fatal(test, w.Code, w.Body.String())
		}
		if test.want == 200 && w.Header().Get("ETag") != `"2"` {
			t.Fatal("credential epoch unavailable")
		}
	}
}
func TestDisabledDiscoveryIsTruthfulAndAuthBodyRejectsToken(t *testing.T) {
	h := routes(t)
	r := httptest.NewRequest("GET", "/api/v2/agent-capabilities", nil)
	r.Header.Set("X-Test-Owner", "a")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var envelope struct {
		Data struct {
			Enabled                bool
			ToolExecutionAvailable bool
			Capabilities           []any
		}
	}
	if json.Unmarshal(w.Body.Bytes(), &envelope) != nil || w.Code != 200 || envelope.Data.Enabled || envelope.Data.ToolExecutionAvailable || len(envelope.Data.Capabilities) != 0 {
		t.Fatal(w.Body.String())
	}
	r = httptest.NewRequest("PUT", "/api/v2/agent-runs/agr_run/auth-context", strings.NewReader(`{"token":"PRIVATE"}`))
	r.Header.Set("X-Test-Owner", "a")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("If-Match", `"2"`)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 || strings.Contains(w.Body.String(), "PRIVATE") {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestEventCursorRejectsAmbiguousOrNoncanonicalValues(t *testing.T) {
	h := routes(t)
	for _, path := range []string{"/api/v2/agent-runs/agr_run/events?after=01", "/api/v2/agent-runs/agr_run/events?after=0&after=1", "/api/v2/agent-runs/agr_run/events?after=-1", "/api/v2/agent-runs/agr_run/events?unknown=1"} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("X-Test-Owner", "a")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal(path, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/api/v2/agent-runs/agr_run/events?after=1", nil)
	r.Header.Set("X-Test-Owner", "a")
	r.Header.Set("Last-Event-ID", "2")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("ambiguous after accepted")
	}
}
