package http_test

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/httpapi"
	organizationHTTP "studiotv.local/service/api/internal/modules/organization/adapters/http"
	"studiotv.local/service/api/internal/modules/organization/application"
	"studiotv.local/service/api/internal/modules/organization/domain"
	"strings"
	"testing"
)

type store struct {
	application.Store
	calls int
	err   error
	owner string
}

func (s *store) CreateFolder(_ context.Context, a domain.Actor, i domain.FolderInput, _ application.Mutation) (domain.Folder, error) {
	s.calls++
	s.owner = a.OwnerID
	return domain.Folder{ID: "f_1", Name: i.Name, Revision: 1}, s.err
}
func (s *store) RenameFolder(_ context.Context, a domain.Actor, id, name string, _ application.Mutation) (domain.Folder, error) {
	s.calls++
	s.owner = a.OwnerID
	return domain.Folder{ID: id, Name: name, Revision: 2}, s.err
}
func (s *store) DeleteFolder(_ context.Context, a domain.Actor, id string, _ application.Mutation) (domain.Deletion, error) {
	s.calls++
	s.owner = a.OwnerID
	return domain.Deletion{ID: id, Revision: 3, DeletedFolderIDs: []string{id}, DeletedProjectIDs: []string{}}, s.err
}
func (s *store) Move(_ context.Context, a domain.Actor, id string, target *string, _ application.Mutation) (domain.Membership, error) {
	s.calls++
	s.owner = a.OwnerID
	return domain.Membership{ProjectID: id, FolderID: target, Revision: 2}, s.err
}
func (s *store) Notifications(_ context.Context, a domain.Actor, kind string, page, size int) (domain.NotificationPage, error) {
	s.calls++
	s.owner = a.OwnerID
	return domain.NotificationPage{Items: []domain.Notification{{ID: "n_1", Type: kind, Revision: 9, Title: map[string]string{"en": "actual"}, Body: map[string]string{"en": "actual"}}}, Page: page, PageSize: size, Total: 1}, s.err
}
func (s *store) Read(_ context.Context, a domain.Actor, _ []string, _ application.Mutation) (domain.Counts, error) {
	s.calls++
	s.owner = a.OwnerID
	return domain.Counts{}, s.err
}
func router(t *testing.T, s *store, owner string) http.Handler {
	t.Helper()
	svc, e := application.New(s)
	if e != nil {
		t.Fatal(e)
	}
	r := chi.NewRouter()
	e = organizationHTTP.RegisterRoutes(r, svc, func(cap string, next httpapi.Handler) http.HandlerFunc {
		if cap != "tv.access" {
			t.Fatal("incorrect permission")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: owner}))
		})
	})
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func call(r http.Handler, method, path, body, etag, key string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if etag != "" {
		req.Header.Set("If-Match", etag)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}
func TestOrganizationHTTPRejectsAuthorityAndUnsafeMutations(t *testing.T) {
	s := &store{}
	r := router(t, s, "verified_owner")
	key := uuid.NewString()
	for _, test := range []struct {
		method, path, body, etag, key string
		status                        int
	}{
		{"POST", "/api/v2/project-folders", `{"name":"A","ownerId":"other"}`, "", key, 400},
		{"POST", "/api/v2/project-folders", `{"name":"A"}`, "", "invalid", 400},
		{"PATCH", "/api/v2/project-folders/f_1", `{"name":"B"}`, "", key, 428},
		{"PATCH", "/api/v2/project-folders/f_1", `{"name":"B"}`, `W/"1"`, key, 400},
		{"PATCH", "/api/v2/project-folders/f_1", `{"name":"B"}`, `"0"`, key, 400},
		{"PUT", "/api/v2/projects/p_1/folder", `{}`, `"1"`, key, 400},
		{"PUT", "/api/v2/projects/p_1/folder", `{"folderId":4}`, `"1"`, key, 400},
		{"POST", "/api/v1/notifications/read", `{"ids":["n_1","n_1"]}`, "", key, 400},
		{"GET", "/api/v1/notifications?page=1&page=2", "", "", "", 400},
		{"GET", "/api/v1/notifications?ownerId=other", "", "", "", 400},
		{"GET", "/api/v1/notifications?type=UPSTREAM", "", "", "", 400},
	} {
		w := call(r, test.method, test.path, test.body, test.etag, test.key)
		if w.Code != test.status {
			t.Fatalf("%s %s got%d body%s", test.method, test.path, w.Code, w.Body)
		}
	}
	if s.calls != 0 {
		t.Fatal("invalid request reached store")
	}
	if call(router(t, s, ""), "GET", "/api/v1/notifications", "", "", "").Code != 401 {
		t.Fatal("identity optional")
	}
	req := httptest.NewRequest("GET", "/api/v2/project-folders/config", nil)
	req.Header.Set("X-Team-Id", "foreign")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal("team accepted")
	}
	w = call(r, "POST", "/api/v2/project-folders", `{"name":"A"}`, "", key)
	if w.Code != 201 || w.Header().Get("ETag") != `"1"` || s.owner != "verified_owner" {
		t.Fatal("create trusted projection", w.Body)
	}
	if organizationHTTP.RegisterRoutes(chi.NewRouter(), nil, nil) == nil {
		t.Fatal("nil composition accepted")
	}
}
func TestOrganizationHTTPMapsRevisionErrorsAndFrozenInboxShape(t *testing.T) {
	s := &store{err: &domain.VersionConflict{Current: 4}}
	r := router(t, s, "owner")
	w := call(r, "PATCH", "/api/v2/project-folders/f_1", `{"name":"B"}`, `"1"`, uuid.NewString())
	if w.Code != 412 || !strings.Contains(w.Body.String(), `"CURRENT_REVISION"`) || !strings.Contains(w.Body.String(), `"message":"4"`) {
		t.Fatal("conflict lost", w.Body)
	}
	s.err = domain.ErrUnavailable
	w = call(r, "POST", "/api/v1/notifications/read", `{"ids":["n_1"]}`, "", uuid.NewString())
	if w.Code != 503 || w.Header().Get("Retry-After") != "5" {
		t.Fatal("unavailable became success", w.Body)
	}
	s.err = nil
	w = call(r, "GET", "/api/v1/notifications?type=OFFICIAL_MESSAGE", "", "", "")
	var envelope struct {
		Data struct {
			Items []map[string]any `json:"items"`
		} `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || len(envelope.Data.Items) != 1 {
		t.Fatal("list projection", w.Body)
	}
	if _, ok := envelope.Data.Items[0]["revision"]; ok {
		t.Fatal("frozen v1 schema changed")
	}
	w = call(r, "GET", "/api/v2/notifications?type=OFFICIAL_MESSAGE", "", "", "")
	if !strings.Contains(w.Body.String(), `"revision":9`) {
		t.Fatal("v2 revision missing")
	}
	w = call(r, "PUT", "/api/v2/projects/p_1/folder", `{"folderId":null}`, `"1"`, uuid.NewString())
	if w.Code != 200 || w.Header().Get("ETag") != `"2"` || !strings.Contains(w.Body.String(), `"folderId":null`) {
		t.Fatal("root move projection", w.Body)
	}
	if call(r, "GET", "/api/v2/project-folders/not_real_path/unregistered", "", "", "").Code != 404 {
		t.Fatal("catchall success")
	}
}
