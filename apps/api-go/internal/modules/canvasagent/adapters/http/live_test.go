package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type liveTestRepository struct {
	calls int
	after int64
	limit int
	err   error
}

func (r *liveTestRepository) OwnedLiveSnapshot(_ context.Context, owner, project string) (domain.LiveSnapshot, error) {
	r.calls++
	if owner != "user-a" || project != "owned" {
		return domain.LiveSnapshot{}, domain.ErrNotFound
	}
	return domain.LiveSnapshot{SchemaVersion: "1", ProjectID: project, GraphRevision: 4, EventCursor: "3", Graph: json.RawMessage(`{"nodes":[],"edges":[]}`), NodeStates: []domain.NodeExecutionState{}, UpdatedAt: time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)}, r.err
}
func (r *liveTestRepository) OwnedProjectEvents(_ context.Context, owner, project string, after int64, limit int) (domain.EventPage, error) {
	r.calls++
	r.after, r.limit = after, limit
	if owner != "user-a" || project != "owned" {
		return domain.EventPage{}, domain.ErrNotFound
	}
	return domain.EventPage{ProjectID: project, Events: []json.RawMessage{}, NextCursor: "3", EventCursor: "3"}, r.err
}

func TestLiveHTTPVerifiedOwnerCursorValidationAndFailClosedStreaming(t *testing.T) {
	repo := &liveTestRepository{}
	service, _ := application.NewLiveService(repo)
	router := chi.NewRouter()
	guards := 0
	protect := func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("live access guard missing")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			guards++
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: r.Header.Get("Test-User")}))
		})
	}
	if err := RegisterLiveRoutes(router, service, protect); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		path, owner, accept, last string
		status                    int
	}{
		{"/api/v2/projects/owned/live-snapshot", "user-a", "", "", 200},
		{"/api/v2/projects/owned/live-snapshot", "user-b", "", "", 404},
		{"/api/v2/projects/owned/live-snapshot?ownerId=user-a", "user-b", "", "", 400},
		{"/api/v2/projects/owned/live-snapshot", "", "", "", 401},
		{"/api/v2/projects/owned/events?after=3&limit=10", "user-a", "application/json", "3", 200},
		{"/api/v2/projects/owned/events", "user-a", "application/json", "9007199254740993", 200},
		{"/api/v2/projects/owned/events?after=3", "user-a", "text/event-stream, application/json", "", 200},
		{"/api/v2/projects/owned/events", "user-a", "text/event-stream", "", 501},
		{"/api/v2/projects/owned/events?after=2", "user-a", "", "3", 400},
		{"/api/v2/projects/owned/events?after=01", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?after=-1", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?after=9223372036854775808", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?after=1&after=2", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?after=", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?limit=0", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?limit=101", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?limit=01", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?limit=3;after=1", "user-a", "", "", 400},
		{"/api/v2/projects/owned/events?ownerId=user-a", "user-b", "", "", 400},
		{"/api/v2/projects/owned/events", "user-b", "", "", 404},
	} {
		before := repo.calls
		req := httptest.NewRequest("GET", test.path, nil)
		req.Header.Set("Test-User", test.owner)
		req.Header.Set("Accept", test.accept)
		if test.last != "" {
			req.Header.Set("Last-Event-ID", test.last)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != test.status {
			t.Fatal(test.path, w.Code, w.Body.String())
		}
		if test.status != 200 && test.status != 404 && repo.calls != before {
			t.Fatal("invalid transport request accessed private project")
		}
		if w.Code == 200 && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("missing private cache policy")
		}
		if test.path == "/api/v2/projects/owned/live-snapshot" && w.Code == 200 && w.Header().Get("ETag") != `"4"` {
			t.Fatal("missing graph revision CAS")
		}
	}
	if guards != 20 {
		t.Fatal("every request must recheck current access")
	}
	for _, check := range []struct {
		err    error
		status int
		code   string
	}{{domain.ErrEventCursorAhead, 409, "EVENT_CURSOR_AHEAD"}, {domain.ErrLiveUnavailable, 503, "PROJECT_EVENTS_UNAVAILABLE"}} {
		repo.err = check.err
		req := httptest.NewRequest("GET", "/api/v2/projects/owned/events", nil)
		req.Header.Set("Test-User", "user-a")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != check.status || body["code"] != check.code || (check.status == 503 && body["retryable"] != true) {
			t.Fatal("event recovery status is misleading", w.Code, w.Body.String())
		}
	}
}
