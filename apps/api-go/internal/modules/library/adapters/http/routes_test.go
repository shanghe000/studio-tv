package http_test

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"net/http"
	"net/http/httptest"
	"os"
	"studiotv.local/service/api/internal/httpapi"
	libraryHTTP "studiotv.local/service/api/internal/modules/library/adapters/http"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/testkit"
	"strings"
	"testing"
)

type harness struct {
	t             *testing.T
	r             http.Handler
	f             *testkit.Fixture
	schemas       map[string]*jsonschema.Schema
	deny, offline bool
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	f := testkit.New()
	f.Assets["image-a"] = testkit.Asset{Owner: "a", Kind: "IMAGE", State: "READY"}
	f.Assets["image-b"] = testkit.Asset{Owner: "b", Kind: "IMAGE", State: "READY"}
	h := &harness{t: t, f: f}
	svc, _ := application.New(f)
	r := chi.NewRouter()
	r.Use(httpapi.Base(nil))
	r.NotFound(httpapi.Wrap(func(http.ResponseWriter, *http.Request) error { return httpapi.Fail(404, "NOT_FOUND", "unknown route") }))
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		switch r.Header.Get("Authorization") {
		case "Bearer a":
			return httpapi.Identity{UserID: "a"}, nil
		case "Bearer b":
			return httpapi.Identity{UserID: "b"}, nil
		default:
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "test login required")
		}
	})
	protect := func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("missing tv.access")
		}
		return httpapi.RequireAuth(auth, func(w http.ResponseWriter, r *http.Request) error {
			if h.offline {
				return httpapi.Retry(503, "AUTHORIZATION_UNAVAILABLE", "offline")
			}
			if h.deny {
				return httpapi.Fail(403, "FORBIDDEN", "denied")
			}
			return next(w, r)
		})
	}
	if e := libraryHTTP.RegisterRoutes(r, svc, protect); e != nil {
		t.Fatal(e)
	}
	h.r = r
	raw, e := os.ReadFile("../../../../../../../contracts/library-extension.json")
	if e != nil {
		t.Fatal(e)
	}
	var doc any
	if e = json.Unmarshal(raw, &doc); e != nil {
		t.Fatal(e)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if e = compiler.AddResource("https://rhtv.local/library-extension.json", doc); e != nil {
		t.Fatal(e)
	}
	h.schemas = map[string]*jsonschema.Schema{}
	for _, name := range []string{"LibraryItemResponse", "LibraryItemPageResponse", "AcknowledgementResponse", "LibraryImagesResponse", "Error"} {
		h.schemas[name], e = compiler.Compile("https://rhtv.local/library-extension.json#/components/schemas/" + name)
		if e != nil {
			t.Fatal(e)
		}
	}
	return h
}
func (h *harness) request(method, path, owner, body string, headers map[string]string, status int, schema string) (*httptest.ResponseRecorder, map[string]any) {
	h.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if owner != "" {
		r.Header.Set("Authorization", "Bearer "+owner)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, r)
	if w.Code != status {
		h.t.Fatalf("%s %s expected%d got%d: %s", method, path, status, w.Code, w.Body.String())
	}
	var bodyMap map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &bodyMap); e != nil {
		h.t.Fatal(e)
	}
	if e := h.schemas[schema].Validate(bodyMap); e != nil {
		h.t.Fatalf("%s contract: %v", schema, e)
	}
	if bodyMap["requestId"] != w.Header().Get("X-Request-Id") || w.Header().Get("Cache-Control") != "no-store" {
		h.t.Fatal("shared envelope headers missing")
	}
	return w, bodyMap
}
func (h *harness) create(owner, title, kind, asset, key string) string {
	h.t.Helper()
	ids := []string{}
	if asset != "" {
		ids = append(ids, asset)
	}
	body, _ := json.Marshal(map[string]any{"title": title, "description": "stored description", "kind": kind, "assetIds": ids})
	_, result := h.request("POST", "/api/v2/library/items", owner, string(body), map[string]string{"Idempotency-Key": key}, 201, "LibraryItemResponse")
	return result["data"].(map[string]any)["id"].(string)
}
func TestHTTPPrivateLibraryCrudPaginationAndETags(t *testing.T) {
	h := newHarness(t)
	_, empty := h.request("GET", "/api/v2/library/items", "a", "", nil, 200, "LibraryItemPageResponse")
	data := empty["data"].(map[string]any)
	if data["total"] != float64(0) || data["pages"] != float64(0) || len(data["records"].([]any)) != 0 {
		t.Fatal("empty library invented data")
	}
	key := uuid.NewString()
	id := h.create("a", "狐 role", "ROLE", "image-a", key)
	if replay := h.create("a", "狐 role", "ROLE", "image-a", strings.ToUpper(key)); replay != id {
		t.Fatal("replay identity changed")
	}
	h.create("a", "狐 scene", "SCENE", "", uuid.NewString())
	h.create("b", "foreign", "ROLE", "image-b", key)
	_, listed := h.request("GET", "/api/v2/library/items?size=1&keyword=%20%E7%8B%90%20", "a", "", map[string]string{"X-Owner-Id": "b", "X-Workspace-Id": "spoofed"}, 200, "LibraryItemPageResponse")
	data = listed["data"].(map[string]any)
	if data["total"] != float64(2) || data["pages"] != float64(2) || data["hasNext"] != true || len(data["records"].([]any)) != 1 {
		t.Fatal("page total wrong")
	}
	_, filtered := h.request("GET", "/api/v2/library/items?kind=SCENE&page=100000", "a", "", nil, 200, "LibraryItemPageResponse")
	data = filtered["data"].(map[string]any)
	if data["total"] != float64(1) || data["pages"] != float64(1) || len(data["records"].([]any)) != 0 {
		t.Fatal("out of range lost count")
	}
	h.request("GET", "/api/v2/library/items/"+id, "b", "", nil, 404, "Error")
	w, _ := h.request("GET", "/api/v2/library/items/"+id, "a", "", nil, 200, "LibraryItemResponse")
	if w.Header().Get("ETag") != `"1"` {
		t.Fatal("detail missing revision")
	}
	body := `{"title":"edited","description":"","kind":"ROLE","assetIds":["image-a"],"mainAssetId":"image-a"}`
	h.request("PATCH", "/api/v2/library/items/"+id, "a", body, nil, 428, "Error")
	w, _ = h.request("PATCH", "/api/v2/library/items/"+id, "a", body, map[string]string{"If-Match": `"1"`}, 200, "LibraryItemResponse")
	if w.Header().Get("ETag") != `"2"` {
		t.Fatal("update revision missing")
	}
	h.request("PATCH", "/api/v2/library/items/"+id, "a", body, map[string]string{"If-Match": `"1"`}, 412, "Error")
	h.request("DELETE", "/api/v2/library/items/"+id, "b", "", map[string]string{"If-Match": `"2"`}, 404, "Error")
	h.request("DELETE", "/api/v2/library/items/"+id, "a", "", map[string]string{"If-Match": `"2"`}, 200, "AcknowledgementResponse")
	h.request("GET", "/api/v2/library/items/"+id, "a", "", nil, 404, "Error")
	h.request("POST", "/api/v2/library/items", "a", `{"title":"狐 role","description":"stored description","kind":"ROLE","assetIds":["image-a"]}`, map[string]string{"Idempotency-Key": key}, 404, "Error")
	if len(h.f.Roots) != 3 || len(h.f.Roots[id].AssetIDs) != 1 {
		t.Fatal("soft delete erased refs")
	}
}
func TestHTTPValidationAssetsAndReservedOperations(t *testing.T) {
	h := newHarness(t)
	valid := `{"title":"x","description":"","kind":"ROLE","assetIds":[]}`
	for _, body := range []string{`null`, `{}`, `{"title":"x","description":"","kind":"ROLE","assetIds":null}`, `{"title":"x","description":"","kind":"ROLE","assetIds":[],"ownerId":"b"}`, `{"title":"x","description":"","kind":"ROLE","assetIds":["image-a","image-a"]}`, `{"title":"x","description":"","kind":"ROLE","assetIds":[],"mainAssetId":"image-a"}`, `{"title":"x","description":"","kind":"PUBLIC","assetIds":[]}`} {
		h.request("POST", "/api/v2/library/items", "a", body, map[string]string{"Idempotency-Key": uuid.NewString()}, 400, "Error")
	}
	h.request("POST", "/api/v2/library/items", "a", valid, nil, 400, "Error")
	h.request("POST", "/api/v2/library/items", "a", `{"title":"x","description":"","kind":"ROLE","assetIds":["image-b"]}`, map[string]string{"Idempotency-Key": uuid.NewString()}, 404, "Error")
	for _, query := range []string{"size=101", "size=0", "page=01", "page=0", "page=1&page=2", "kind=ROLE&kind=SCENE", "kind=IMAGE", "ownerId=b", "keyword=" + strings.Repeat("x", 301)} {
		h.request("GET", "/api/v2/library/items?"+query, "a", "", nil, 400, "Error")
	}
	id := h.create("a", "owned", "ROLE", "", uuid.NewString())
	for _, etag := range []string{`W/"1"`, `*`, `"0"`, `"01"`, `"1", "2"`, `"999999999999999999999999"`} {
		h.request("DELETE", "/api/v2/library/items/"+id, "a", "", map[string]string{"If-Match": etag}, 400, "Error")
	}
	h.request("PATCH", "/api/v2/library/items/"+id, "a", `{"title":"renamed","description":"","kind":"SCENE","assetIds":[]}`, map[string]string{"If-Match": `"1"`}, 400, "Error")
	h.request("GET", "/api/v2/library/items/"+id+"/images", "a", "", nil, 200, "LibraryImagesResponse")
	h.request("GET", "/api/v2/library/items/"+id+"/images", "b", "", nil, 404, "Error")
	h.request("GET", "/api/v2/library/folders", "a", "", nil, 404, "Error")
	h.request("GET", "/api/v2/library/not-a-route", "a", "", nil, 404, "Error")
}
func TestHTTPAuthenticationFailsClosed(t *testing.T) {
	h := newHarness(t)
	h.request("GET", "/api/v2/library/items", "", "", map[string]string{"X-Owner-Id": "a"}, 401, "Error")
	h.deny = true
	h.request("GET", "/api/v2/library/items", "a", "", nil, 403, "Error")
	h.deny = false
	h.offline = true
	h.request("GET", "/api/v2/library/items", "a", "", nil, 503, "Error")
	svc, _ := application.New(h.f)
	if libraryHTTP.RegisterRoutes(chi.NewRouter(), svc, nil) == nil {
		t.Fatal("nil protector accepted")
	}
	r := chi.NewRouter()
	r.Use(httpapi.Base(nil))
	if e := libraryHTTP.RegisterRoutes(r, svc, func(_ string, next httpapi.Handler) http.HandlerFunc { return httpapi.Wrap(next) }); e != nil {
		t.Fatal(e)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v2/library/items", nil)
	req.Header.Set("X-Owner-Id", "a")
	r.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("untrusted actor accepted")
	}
}
