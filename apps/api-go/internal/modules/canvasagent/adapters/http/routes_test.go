package http

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	"testing"
)

type testRepository struct{ calls int }

func (r *testRepository) OwnedSnapshot(_ context.Context, owner, project string) (application.Snapshot, error) {
	r.calls++
	if owner != "user-a" || project != "owned" {
		return application.Snapshot{}, domain.ErrNotFound
	}
	return application.Snapshot{Revision: 4, Graph: json.RawMessage(`{"nodes":[],"edges":[]}`)}, nil
}
func TestContextHTTPUsesVerifiedOwner(t *testing.T) {
	repo := &testRepository{}
	service, _ := application.New(repo)
	router := chi.NewRouter()
	protect := func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal(capability)
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			r = httpapi.WithIdentity(r, httpapi.Identity{UserID: r.Header.Get("Test-User")})
			return next(w, r)
		})
	}
	if err := RegisterRoutes(router, service, protect); err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct {
		path, user string
		status     int
	}{{"/api/v2/projects/owned/agent-context", "user-a", 200}, {"/api/v2/projects/owned/agent-context", "user-b", 404}, {"/api/v2/projects/owned/agent-context?ownerId=user-a", "user-b", 400}, {"/api/v2/projects/owned/agent-context", "", 401}} {
		req := httptest.NewRequest("GET", v.path, nil)
		req.Header.Set("Test-User", v.user)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != v.status {
			t.Fatalf("%s: %d %s", v.path, w.Code, w.Body.String())
		}
		if w.Code == 200 && (w.Header().Get("ETag") != "\"4\"" || w.Header().Get("Cache-Control") != "no-store") {
			t.Fatal("missing context version/cache policy")
		}
	}
	if repo.calls != 2 {
		t.Fatal("invalid requests read project", repo.calls)
	}
}
