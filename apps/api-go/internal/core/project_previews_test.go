package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
	"studiotv.local/service/api/internal/testdb"
)

func TestProjectPreviewBoundsAndCapability(t *testing.T) {
	for _, ids := range [][]string{nil, {}, {"prj_a", "prj_a"}, {"bad/id"}, {strings.Repeat("a", 65)}} {
		if validateProjectPreviewQuery(projectPreviewQuery{ProjectIDs: ids}) == nil {
			t.Fatalf("accepted invalid batch with %d IDs", len(ids))
		}
	}
	ids := make([]string, projectPreviewLimit+1)
	for i := range ids {
		ids[i] = fmt.Sprintf("prj_%d", i)
	}
	if validateProjectPreviewQuery(projectPreviewQuery{ProjectIDs: ids}) == nil || validateProjectPreviewQuery(projectPreviewQuery{ProjectIDs: ids[:100]}) != nil {
		t.Fatal("batch limit must be exactly 100 distinct IDs")
	}
	if capabilityFor(http.MethodPost, "/api/v2/project-previews/query") != authorization.TVAccess {
		t.Fatal("preview route is not protected by product access")
	}
}

func TestProjectPreviewRequestValidation(t *testing.T) {
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		if r.Header.Get("Authorization") != "Bearer test" {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture")
		}
		return integrationPrincipal("usr_a"), nil
	})
	router, err := NewWithAuthorization(testConfig(t), nil, auth, authorization.New(&integrationRuntime{}, "cli_test", &integrationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	tooMany := make([]string, 101)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("prj_%d", i)
	}
	for _, test := range []struct {
		body, contentType, query string
		status                   int
	}{
		{`{`, "application/json", "", 400},
		{`{"projectIds":["prj_a"],"ownerId":"usr_b"}`, "application/json", "", 400},
		{`{"projectIds":["prj_a","prj_a"]}`, "application/json", "", 400},
		{string(encode(map[string]any{"projectIds": tooMany})), "application/json", "", 400},
		{`{"projectIds":["prj_a"]}`, "text/plain", "", 415},
		{`{"projectIds":["prj_a"]}`, "application/json", "?ownerId=usr_b", 400},
		{`{"projectIds":["` + strings.Repeat("a", 9000) + `"]}`, "application/json", "", 413},
	} {
		r := httptest.NewRequest(http.MethodPost, "/api/v2/project-previews/query"+test.query, strings.NewReader(test.body))
		r.Header.Set("Authorization", "Bearer test")
		r.Header.Set("Content-Type", test.contentType)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("validation returned %d expected %d", w.Code, test.status)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v2/project-previews/query", strings.NewReader(`{"projectIds":["prj_a"]}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("batch metadata was not protected before querying storage")
	}
}

func projectPreviewContract(t *testing.T, schemaName string) *jsonschema.Schema {
	t.Helper()
	path := filepath.Join(filepath.Dir(testConfig(t).ContractPath), "project-previews-extension.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	const base = "https://studiotv.example.test/contracts/project-previews-extension.json"
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err = compiler.AddResource(base, document); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile(base + "#/components/schemas/" + schemaName)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func TestProjectPreviewAdditiveContract(t *testing.T) {
	schema := projectPreviewContract(t, "ProjectPreviewQuery")
	if err := schema.Validate(map[string]any{"projectIds": []any{"prj_a", "prj_b"}}); err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{map[string]any{}, map[string]any{"projectIds": []any{}}, map[string]any{"projectIds": []any{"prj_a", "prj_a"}}, map[string]any{"projectIds": []any{"prj_a"}, "graph": true}} {
		if schema.Validate(value) == nil {
			t.Fatal("contract accepted invalid preview query")
		}
	}
	var doc map[string]any
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(testConfig(t).ContractPath), "project-previews-extension.json"))
	if err != nil || json.Unmarshal(raw, &doc) != nil {
		t.Fatal("additive contract unavailable")
	}
	paths := doc["paths"].(map[string]any)
	operation := paths["/api/v2/project-previews/query"].(map[string]any)["post"].(map[string]any)
	if len(paths) != 1 || operation["x-required-capability"] != authorization.TVAccess || operation["x-implementation-status"] != "IMPLEMENTED" {
		t.Fatal("contract route/capability mismatch")
	}
	if _, err = os.Stat(filepath.Join(filepath.Dir(testConfig(t).ContractPath), "project-previews-extension.yaml")); err != nil {
		t.Fatal(err)
	}
}

type previewCountingDB struct {
	DB
	queries int
}

func (d *previewCountingDB) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	d.queries++
	return d.DB.Query(ctx, query, args...)
}
func (d *previewCountingDB) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	d.queries++
	return d.DB.QueryRow(ctx, query, args...)
}

func TestPostgresProjectPreviewsBatchACLProjectionAndSignedRevocation(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,display_name) VALUES('usr_a','preview-a@example.test','A'),('usr_b','preview-b@example.test','B'),('usr_c','preview-c@example.test','C'),('usr_d','preview-d@example.test','D');
 INSERT INTO projects(id,owner_id,name) VALUES('prj_cover','usr_a','Explicit cover'),('prj_fallback','usr_a','Saved fallback'),('prj_empty','usr_a','No cover'),('prj_private','usr_a','Private'),('prj_source','usr_a','Source'),('prj_team','usr_a','Team'),('prj_foreign','usr_d','Foreign');
 INSERT INTO projects(id,owner_id,name,internal_kind) VALUES('prj_internal','usr_a','Vault','ASSET_VAULT');
 INSERT INTO projects(id,owner_id,name,deleted_at) VALUES('prj_deleted','usr_a','Deleted',now());
 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('prj_cover','usr_b','VIEWER','usr_a'),('prj_fallback','usr_b','EDITOR','usr_a'),('prj_empty','usr_b','VIEWER','usr_a');
 INSERT INTO collaboration.teams(id,owner_id,name) VALUES('tem_preview','usr_a','Preview team');
 INSERT INTO collaboration.team_members(team_id,user_id,role,created_by) VALUES('tem_preview','usr_c','EDITOR','usr_a');
 INSERT INTO collaboration.project_teams(project_id,team_id,role,created_by) VALUES('prj_team','tem_preview','VIEWER','usr_a');`); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	content := []byte("actual owned preview bytes")
	sum := sha256.Sum256(content)
	if _, err := db.Exec(ctx, `INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key) VALUES
 ('ast_cover','usr_a','prj_source','cover.png','IMAGE','image/png',$1,$2,'READY','ast_cover'),
 ('ast_fallback','usr_a','prj_source','fallback.png','IMAGE','image/png',$1,$2,'READY','ast_fallback'),
 ('ast_nested','usr_a','prj_source','nested.png','IMAGE','image/png',$1,$2,'READY','ast_nested'),
 ('ast_unready','usr_a','prj_source','pending.png','IMAGE','image/png',$1,$2,'PROCESSING','ast_unready'),
 ('ast_removed','usr_a','prj_source','removed.png','IMAGE','image/png',$1,$2,'READY','ast_removed'),
 ('ast_video','usr_a','prj_source','video.mp4','VIDEO','video/mp4',$1,$2,'READY','ast_video'),
	 ('ast_foreign','usr_d','prj_foreign','foreign.png','IMAGE','image/png',$1,$2,'READY','ast_foreign')`, len(content), hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
 UPDATE assets SET deleted_at=now() WHERE id='ast_removed';
 UPDATE projects SET cover_asset_id='ast_cover' WHERE id='prj_cover';
 UPDATE projects SET cover_asset_id='ast_unready' WHERE id='prj_fallback';
 UPDATE projects SET cover_asset_id='ast_video' WHERE id='prj_empty';`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"ast_cover", "ast_fallback", "ast_nested"} {
		if err := os.WriteFile(filepath.Join(cfg.StorageRoot, id), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	graph := func(nodes ...any) []byte {
		return encode(map[string]any{"schemaVersion": "1", "nodes": nodes, "edges": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "zoom": 1}})
	}
	node := func(id, typ string, data any) any {
		return map[string]any{"id": id, "type": typ, "position": map[string]any{"x": 0, "y": 0}, "data": data}
	}
	graphs := map[string][]byte{
		"prj_cover":    graph(node("image", "rh-image", map[string]any{"outputs": []any{map[string]any{"assetId": "ast_fallback"}}, "prompt": "private prompt must never leave this query"}), node("rhtv_meta_v1", "__rhtv_meta", map[string]any{"url": "rhtv-asset:ast_nested"})),
		"prj_fallback": graph(node("foreign", "rh-image", map[string]any{"assetId": "ast_foreign"}), node("deleted", "image", map[string]any{"url": "rhtv-asset:ast_removed"}), node("pending", "image", map[string]any{"assetId": "ast_unready"}), node("video", "image", map[string]any{"url": "rhtv-asset:ast_video"}), node("nested", "rh-image", map[string]any{"outputs": []any{map[string]any{"value": map[string]any{"url": "rhtv-asset:ast_nested"}}}})),
		"prj_empty":    graph(node("text", "rh-text", map[string]any{"text": "arbitrary ast_fallback substring", "url": "https://remote.example.test/private.png"}), node("prompt_only", "rh-image", map[string]any{"prompt": "rhtv-asset:ast_fallback"})),
	}
	for pid, raw := range graphs {
		if _, err := db.Exec(ctx, `UPDATE projects SET graph=$2::jsonb WHERE id=$1`, pid, raw); err != nil {
			t.Fatal(err)
		}
	}
	// Saved project references/explicit cover remain valid after the source
	// project is soft-deleted; an unrelated private asset never becomes public.
	if _, err := db.Exec(ctx, `UPDATE projects SET deleted_at=now() WHERE id='prj_source'`); err != nil {
		t.Fatal(err)
	}
	counting := &previewCountingDB{DB: db}
	records, err := loadProjectPreviews(ctx, counting, "usr_b", []string{"prj_fallback", "prj_cover", "prj_empty"})
	if err != nil || len(records) != 3 || counting.queries != 1 {
		t.Fatalf("batch must use one real SQL statement: records=%d queries=%d error=%v", len(records), counting.queries, err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO projects(id,owner_id,name) SELECT 'prj_batch_'||n,'usr_a','Batch '||n FROM generate_series(1,100) n`); err != nil {
		t.Fatal(err)
	}
	batchIDs := make([]string, 100)
	for i := range batchIDs {
		batchIDs[i] = fmt.Sprintf("prj_batch_%d", 100-i)
	}
	counting.queries = 0
	maximumBatch, err := loadProjectPreviews(ctx, counting, "usr_a", batchIDs)
	if err != nil || len(maximumBatch) != 100 || counting.queries != 1 {
		t.Fatal("100-project batch must remain one SQL statement")
	}
	for i, item := range maximumBatch {
		if item.Project.ID != batchIDs[i] || item.Project.Role != "OWNER" {
			t.Fatal("maximum batch order/ACL mismatch")
		}
	}
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		uid := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if uid != "usr_a" && uid != "usr_b" && uid != "usr_c" && uid != "usr_d" {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture")
		}
		return integrationPrincipal(uid), nil
	})
	runtime := &integrationRuntime{}
	router, err := NewWithAuthorization(cfg, db, auth, authorization.New(runtime, "cli_test", &collaborationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, uid string, body any, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(encode(body)))
		r.Header.Set("Content-Type", "application/json")
		if uid != "" {
			r.Header.Set("Authorization", "Bearer "+uid)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("preview request returned %d, expected %d", w.Code, want)
		}
		return w
	}
	query := func(uid string, ids []string, want int) *httptest.ResponseRecorder {
		return call(http.MethodPost, "/api/v2/project-previews/query", uid, map[string]any{"projectIds": ids}, want)
	}
	w := query("usr_b", []string{"prj_fallback", "prj_cover", "prj_empty"}, 200)
	var contractResponse any
	if err = json.Unmarshal(w.Body.Bytes(), &contractResponse); err != nil {
		t.Fatal(err)
	}
	if err = projectPreviewContract(t, "ProjectPreviewResponse").Validate(contractResponse); err != nil {
		t.Fatal(err)
	}
	if w.Header().Get("Cache-Control") != "private, no-store" || strings.Contains(w.Body.String(), "private prompt") || strings.Contains(w.Body.String(), `"graph"`) || strings.Contains(w.Body.String(), "ast_foreign") || strings.Contains(w.Body.String(), "storage_key") {
		t.Fatal("preview leaked unprojected state or was cacheable")
	}
	var response struct {
		Data struct {
			Items []projectPreview `json:"items"`
		} `json:"data"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	items := response.Data.Items
	if len(items) != 3 || items[0].Project["id"] != "prj_fallback" || items[0].NodesCount != 5 || items[0].Role != "EDITOR" || items[0].Thumbnail == nil || items[0].Thumbnail.AssetID != "ast_nested" || items[1].NodesCount != 1 || items[1].Role != "VIEWER" || items[1].Thumbnail == nil || items[1].Thumbnail.AssetID != "ast_cover" || items[2].Thumbnail != nil {
		t.Fatal("preview order, image selection, metadata exclusion, count or role mismatch")
	}
	for _, item := range items {
		if item.Project["ownerId"] != "usr_a" || item.Project["role"] != item.Role || item.Project["name"] == nil || item.Project["updatedAt"] == nil {
			t.Fatal("project metadata changed canonical storage owner or role")
		}
	}
	media, err := url.Parse(items[1].Thumbnail.URL)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := security.New(cfg).Verify(media.Query().Get("token"), "asset-read")
	if err != nil || claims["sub"] != "usr_b" || claims["sid"] != "test-usr_b" || claims["aid"] != "ast_cover" {
		t.Fatal("cover signature must bind actual reader and local session")
	}
	if expiry, e := time.Parse(time.RFC3339, items[1].Thumbnail.URLsExpireAt); e != nil || !expiry.After(time.Now()) {
		t.Fatal("thumbnail lacks valid expiry")
	}
	if bytesRead := call(http.MethodGet, media.RequestURI(), "", nil, 200).Body.Bytes(); !bytes.Equal(bytesRead, content) {
		t.Fatal("signed cover did not read the original real bytes")
	}
	query("usr_a", []string{"prj_cover", "prj_private"}, 200)
	query("usr_c", []string{"prj_team"}, 200)
	query("usr_d", []string{"prj_cover"}, 404)
	for _, id := range []string{"prj_private", "prj_deleted", "prj_internal", "prj_missing"} {
		failed := query("usr_b", []string{"prj_cover", id}, 404)
		if strings.Contains(failed.Body.String(), "Explicit cover") {
			t.Fatal("partially authorized batch leaked metadata")
		}
	}
	query("", []string{"prj_cover"}, 401)
	for _, input := range []any{nil, map[string]any{}, map[string]any{"projectIds": []string{}}, map[string]any{"projectIds": []string{"prj_cover", "prj_cover"}}, map[string]any{"projectIds": []string{"prj_cover"}, "graph": true}} {
		call(http.MethodPost, "/api/v2/project-previews/query", "usr_b", input, 400)
	}
	call(http.MethodPost, "/api/v2/project-previews/query?ownerId=usr_a", "usr_b", map[string]any{"projectIds": []string{"prj_cover"}}, 400)
	if _, err = db.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='prj_cover' AND user_id='usr_b'; DELETE FROM collaboration.team_members WHERE team_id='tem_preview' AND user_id='usr_c'`); err != nil {
		t.Fatal(err)
	}
	query("usr_b", []string{"prj_cover"}, 404)
	query("usr_c", []string{"prj_team"}, 404)
	call(http.MethodGet, media.RequestURI(), "", nil, 404)
	if _, err = db.Exec(ctx, `UPDATE users SET disabled=true WHERE id='usr_a'`); err != nil {
		t.Fatal(err)
	}
	query("usr_a", []string{"prj_private"}, 404)
	// A fresh authorization service is used so deliberate upstream changes do
	// not bypass the independently tested short authorization lease.
	runtime.denied.Store(true)
	router, err = NewWithAuthorization(cfg, db, auth, authorization.New(runtime, "cli_test", &collaborationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	query("usr_b", []string{"prj_empty"}, 403)
	runtime.unavailable.Store(true)
	router, err = NewWithAuthorization(cfg, db, auth, authorization.New(runtime, "cli_test", &collaborationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	query("usr_b", []string{"prj_empty"}, 503)
}
