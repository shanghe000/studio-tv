package core

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/execution/adapters/stylecatalog"
)

func TestEmbeddedStyleMaterializationPostgres(t *testing.T) {
	requireFFTools(t)
	pool, ctx, actor, _, project, cfg := productTestDB(t)
	catalog, err := stylecatalog.New(pool)
	if err != nil {
		t.Fatal(err)
	}
	if err = catalog.Import(ctx); err != nil {
		t.Fatal(err)
	}
	assets, err := NewProductAssetStore(cfg, pool)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	assets.RegisterProductAssetRoutes(router, func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return h(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: actor, SessionID: "style-audit"}))
		})
	})
	key := uuid.NewString()
	submit := func(id string, revision int, path string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"projectId": project, "family": "PROMPT", "resourceId": id, "revision": revision, "path": path})
		req := httptest.NewRequest("POST", "/api/v2/catalog/media/materialize", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	first := submit("cinematic_realism", 1, "/preset/referenceImageUrl")
	if first.Code != 201 {
		t.Fatal(first.Code, first.Body.String())
	}
	var result struct {
		Data struct {
			Asset struct{ ID, ProjectID, State, MimeType string }
		}
	}
	if err = json.Unmarshal(first.Body.Bytes(), &result); err != nil || result.Data.Asset.ID == "" || result.Data.Asset.ProjectID != project || result.Data.Asset.State != "READY" || result.Data.Asset.MimeType != "image/webp" {
		t.Fatalf("invalid asset metadata: id=%q project=%q state=%q mime=%q err=%v", result.Data.Asset.ID, result.Data.Asset.ProjectID, result.Data.Asset.State, result.Data.Asset.MimeType, err)
	}
	var actualOwner string
	if err := pool.QueryRow(ctx, `SELECT owner_id FROM assets WHERE id=$1`, result.Data.Asset.ID).Scan(&actualOwner); err != nil || actualOwner != actor {
		t.Fatal("materialized asset owner mismatch", err)
	}
	second := submit("cinematic_realism", 1, "/preset/referenceImageUrl")
	if second.Code != 201 {
		t.Fatal(second.Code, second.Body.String())
	}
	var again struct {
		Data struct{ Asset struct{ ID string } }
	}
	json.Unmarshal(second.Body.Bytes(), &again)
	if again.Data.Asset.ID != result.Data.Asset.ID {
		t.Fatal("idempotent style materialization duplicated asset")
	}
	for _, tc := range []struct {
		id       string
		revision int
		path     string
		status   int
	}{{"cinematic_realism", 2, "/preset/referenceImageUrl", 404}, {"cinematic_realism", 1, "/not-present", 400}, {"not-a-style", 1, "/preset/referenceImageUrl", 404}} {
		if w := submit(tc.id, tc.revision, tc.path); w.Code != tc.status {
			t.Fatal(tc, w.Code, w.Body.String())
		}
	}
}
