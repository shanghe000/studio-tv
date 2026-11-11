package http_test

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/httpapi"
	resourceHTTP "studiotv.local/service/api/internal/modules/resources/adapters/http"
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"strings"
	"testing"
)

type store struct {
	application.Store
	owner string
	calls int
}

func (s *store) List(_ context.Context, a domain.Actor, f domain.Family, q domain.Query) (domain.Page, error) {
	s.calls++
	s.owner = a.OwnerID
	return domain.NewPage(q, []domain.Resource{{ID: "stored", Scope: "USER", Input: domain.Input{Name: "x", CategoryIDs: []string{}, Content: json.RawMessage(`{"prefixPrompt":"actual"}`)}, Revision: 2}}, 1), nil
}
func (s *store) Get(_ context.Context, a domain.Actor, f domain.Family, id string) (domain.Resource, error) {
	s.calls++
	if a.OwnerID != "a" {
		return domain.Resource{}, domain.ErrNotFound
	}
	return domain.Resource{ID: id, Scope: "USER", Input: domain.Input{Name: "x", CategoryIDs: []string{}, Content: json.RawMessage(`{"prefixPrompt":"actual"}`)}, Revision: 2}, nil
}
func (s *store) Save(_ context.Context, a domain.Actor, f domain.Family, id string, i domain.Input, m application.Mutation) (domain.Resource, error) {
	s.calls++
	if m.Expected == 1 {
		return domain.Resource{}, &domain.VersionConflict{Current: 2}
	}
	return domain.Resource{ID: "stored", Scope: "USER", Input: i, Revision: 2}, nil
}
func TestHTTPBoundaryExplicitFamiliesAndNoCatchall(t *testing.T) {
	repo := &store{}
	svc, _ := application.New(repo)
	r := chi.NewRouter()
	if e := resourceHTTP.RegisterRoutes(r, svc, func(cap string, h httpapi.Handler) http.HandlerFunc {
		if cap != "tv.access" {
			t.Fatal(cap)
		}
		return httpapi.Wrap(h)
	}); e != nil {
		t.Fatal(e)
	}
	req := func(method, p, owner, body string, headers map[string]string, status int) *httptest.ResponseRecorder {
		t.Helper()
		q := httptest.NewRequest(method, p, strings.NewReader(body))
		q.Header.Set("Content-Type", "application/json")
		q.Header.Set("X-Owner-Id", "b")
		if owner != "" {
			q = httpapi.WithIdentity(q, httpapi.Identity{UserID: owner})
		}
		for k, v := range headers {
			q.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, q)
		if w.Code != status {
			t.Fatalf("%s %s wanted%d got%d %s", method, p, status, w.Code, w.Body.String())
		}
		return w
	}
	req("GET", "/api/v2/prompts", "", "", nil, 401)
	w := req("GET", "/api/v2/prompts?size=1", "a", "", nil, 200)
	if repo.owner != "a" || !strings.Contains(w.Body.String(), "actual") {
		t.Fatal("untrusted owner or synthetic content")
	}
	req("GET", "/api/v2/prompts?size=101", "a", "", nil, 400)
	req("GET", "/api/v2/voices?gender=INVALID", "a", "", nil, 400)
	req("GET", "/api/v2/prompts?ownerId=b", "a", "", nil, 400)
	req("GET", "/api/v2/prompts/stored", "b", "", nil, 404)
	w = req("GET", "/api/v2/prompts/stored", "a", "", nil, 200)
	if w.Header().Get("ETag") != `"2"` {
		t.Fatal("missing revision")
	}
	req("POST", "/api/v2/prompts", "a", `{"name":"x","categoryIds":[],"content":{"prefixPrompt":"p"},"ownerId":"b"}`, map[string]string{"Idempotency-Key": uuid.NewString()}, 400)
	body := `{"name":"x","categoryIds":[],"content":{"prefixPrompt":"p"}}`
	req("POST", "/api/v2/prompts", "a", body, nil, 400)
	req("PUT", "/api/v2/prompts/stored", "a", body, nil, 428)
	req("PUT", "/api/v2/prompts/stored", "a", body, map[string]string{"If-Match": `"1"`}, 412)
	req("GET", "/api/v2/unknown/path", "a", "", nil, 404)
	req("POST", "/api/v2/apps", "a", body, nil, 405)
}
func TestRegistrationFailsClosed(t *testing.T) {
	if resourceHTTP.RegisterRoutes(chi.NewRouter(), nil, nil) == nil {
		t.Fatal("missing protect")
	}
}
