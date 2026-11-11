package http_test

import (
	"context"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/httpapi"
	libraryHTTP "studiotv.local/service/api/internal/modules/library/adapters/http"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"strings"
	"testing"
)

type entryRepo struct {
	application.EntryRepository
	owner string
	key   string
	query domain.EntryQuery
}

func (e *entryRepo) State(_ context.Context, a domain.VerifiedActor) (int64, error) {
	e.owner = a.OwnerID
	return 7, nil
}
func (e *entryRepo) Entries(_ context.Context, a domain.VerifiedActor, q domain.EntryQuery) (domain.EntriesPage, error) {
	e.owner = a.OwnerID
	e.query = q
	return domain.EntriesPage{Page: q.Page, Current: q.Page, Size: q.Size, Total: 4, Pages: 4}, nil
}
func (e *entryRepo) CreateFolder(_ context.Context, a domain.VerifiedActor, i domain.FolderInput, m application.EntryMutation) (domain.Folder, error) {
	e.owner = a.OwnerID
	e.key = m.Key
	return domain.Folder{ID: "actual", Name: i.Name, Kind: "MIXED", CategoryCode: i.CategoryCode, Revision: 1, ThumbnailAssetIDs: []string{}}, nil
}
func TestEntryHTTPTrustedOwnerBoundedQueriesAndCreateHeaders(t *testing.T) {
	repo := &entryRepo{}
	s, _ := application.NewEntries(repo)
	r := chi.NewRouter()
	if e := libraryHTTP.RegisterEntryRoutes(r, s, func(cap string, h httpapi.Handler) http.HandlerFunc {
		if cap != "tv.access" {
			t.Fatal(cap)
		}
		return httpapi.Wrap(h)
	}); e != nil {
		t.Fatal(e)
	}
	send := func(method, path, owner, body string, headers map[string]string, status int) {
		t.Helper()
		q := httptest.NewRequest(method, path, strings.NewReader(body))
		q.Header.Set("Content-Type", "application/json")
		q.Header.Set("X-Owner-Id", "foreign")
		if owner != "" {
			q = httpapi.WithIdentity(q, httpapi.Identity{UserID: owner})
		}
		for k, v := range headers {
			q.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, q)
		if w.Code != status {
			t.Fatalf("%s %s got%d %s", method, path, w.Code, w.Body.String())
		}
	}
	send("GET", "/api/v2/library/state", "", "", nil, 401)
	send("GET", "/api/v2/library/state", "owner", "", nil, 200)
	if repo.owner != "owner" {
		t.Fatal("caller owner trusted")
	}
	send("GET", "/api/v2/library/entries?size=101", "owner", "", nil, 400)
	send("GET", "/api/v2/library/entries?ownerId=foreign", "owner", "", nil, 400)
	send("GET", "/api/v2/library/entries?page=9&size=1&recursive=true&nodeKind=image-video&nodeTypes=%5B%22IMAGE%22%5D", "owner", "", nil, 200)
	if repo.query.NodeKind != "image-video" || len(repo.query.NodeTypes) != 1 {
		t.Fatal("filters ignored")
	}
	body := `{"name":"new","categoryCode":"USER_OTHER","kind":"MIXED"}`
	send("POST", "/api/v2/library/folders", "owner", body, nil, 400)
	key := uuid.NewString()
	send("POST", "/api/v2/library/folders", "owner", body, map[string]string{"Idempotency-Key": key}, 201)
	if repo.key != key {
		t.Fatal("idempotency key lost")
	}
	send("POST", "/api/v2/library/folders", "owner", `{"name":"x","categoryCode":"USER_OTHER","ownerId":"foreign"}`, map[string]string{"Idempotency-Key": uuid.NewString()}, 400)
}
func TestIndependentGalleryImagesPersistInAggregate(t *testing.T) {
	h := newHarness(t)
	id := h.create("a", "image operations", "ROLE", "", uuid.NewString())
	path := "/api/v2/library/items/" + id
	h.request("POST", path+"/images", "a", `{"assetIds":["image-a"]}`, map[string]string{"If-Match": `"1"`}, 200, "LibraryItemResponse")
	h.request("PUT", path+"/images/main", "a", `{"assetId":"image-a"}`, map[string]string{"If-Match": `"2"`}, 200, "LibraryItemResponse")
	h.request("PUT", path+"/images/order", "a", `{"assetIds":["image-a"]}`, map[string]string{"If-Match": `"2"`}, 412, "Error")
	h.request("POST", path+"/images", "a", `{"assetIds":["image-b"]}`, map[string]string{"If-Match": `"3"`}, 404, "Error")
	h.request("DELETE", path+"/images/image-a", "a", "", map[string]string{"If-Match": `"3"`}, 200, "LibraryItemResponse")
	if len(h.f.Roots[id].AssetIDs) != 0 || h.f.Roots[id].MainAssetID != nil || h.f.Roots[id].Revision != 4 {
		t.Fatal("image delete not persisted")
	}
}
