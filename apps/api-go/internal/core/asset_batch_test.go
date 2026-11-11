package core

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	ipacruntime "studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
	"studiotv.local/service/api/internal/testdb"
)

type assetBatchRuntime struct {
	*integrationRuntime
	scopes atomic.Int64
}

func (c *assetBatchRuntime) EffectiveScopes(ctx context.Context, request ipacruntime.EffectiveScopesRequest) (ipacruntime.EffectiveScopes, error) {
	c.scopes.Add(1)
	return c.integrationRuntime.EffectiveScopes(ctx, request)
}

func TestAssetResolveBatchBoundsDeduplicationAndCapability(t *testing.T) {
	for _, ids := range [][]string{nil, {""}, {"bad/id"}, {strings.Repeat("a", 65)}, make([]string, 101)} {
		if _, err := assetResolveBatchIDs(assetResolveBatchRequest{AssetIDs: ids}); err == nil {
			t.Fatal("accepted invalid bounded batch", ids)
		}
	}
	ids := make([]string, 100)
	for index := range ids {
		ids[index] = fmt.Sprintf("ast_%d", index)
	}
	if got, err := assetResolveBatchIDs(assetResolveBatchRequest{AssetIDs: ids}); err != nil || len(got) != 100 {
		t.Fatal("100 valid identifiers rejected", got, err)
	}
	if got, err := assetResolveBatchIDs(assetResolveBatchRequest{AssetIDs: []string{"ast_b", "ast_a", "ast_b"}}); err != nil || strings.Join(got, ",") != "ast_b,ast_a" {
		t.Fatal("deduplication did not retain first occurrence order", got, err)
	}
	if got, err := assetResolveBatchIDs(assetResolveBatchRequest{AssetIDs: []string{}}); err != nil || got == nil || len(got) != 0 {
		t.Fatal("explicit empty batch must return an empty set", got, err)
	}
	if capabilityFor(http.MethodPost, "/api/v2/assets/resolve-batch") != authorization.TVAccess {
		t.Fatal("batch metadata route bypasses tv.access")
	}
}

func TestAssetResolveBatchRequestValidationBeforeDatabaseReads(t *testing.T) {
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture")
		}
		return integrationPrincipal("usr_a"), nil
	})
	router, err := NewWithAuthorization(testConfig(t), nil, auth, authorization.New(&integrationRuntime{}, "cli_test", &integrationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		name, body, contentType, query string
		status                         int
	}{
		{"malformed JSON", `{`, "application/json", "", 400},
		{"missing array", `{}`, "application/json", "", 400},
		{"null array", `{"assetIds":null}`, "application/json", "", 400},
		{"unknown actor", `{"assetIds":[],"actorId":"usr_b"}`, "application/json", "", 400},
		{"wrong id type", `{"assetIds":[1]}`, "application/json", "", 400},
		{"bad identifier", `{"assetIds":["https://private.invalid"]}`, "application/json", "", 400},
		{"non JSON media", `{"assetIds":[]}`, "text/plain", "", 415},
		{"query authority", `{"assetIds":[]}`, "application/json", "?ownerId=usr_b", 400},
		{"oversized body", `{"assetIds":["` + strings.Repeat("a", 17000) + `"]}`, "application/json", "", 413},
		{"empty success", `{"assetIds":[]}`, "application/json", "", 200},
	} {
		t.Run(row.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v2/assets/resolve-batch"+row.query, strings.NewReader(row.body))
			request.Header.Set("Authorization", "Bearer fixture")
			request.Header.Set("Content-Type", row.contentType)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != row.status {
				t.Fatal(response.Code, row.status, response.Body.String())
			}
		})
	}
}

func TestPostgresAssetResolveBatchRechecksEveryAssetAndReturnsNoPartialMetadata(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,display_name) VALUES('usr_a','batch-a@example.test','Owner'),('usr_b','batch-b@example.test','Editor'),('usr_c','batch-c@example.test','Viewer');
 INSERT INTO projects(id,owner_id,name) VALUES('prj_batch_shared','usr_a','Shared'),('prj_batch_private','usr_a','Private'),('prj_batch_own','usr_b','Own');
 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('prj_batch_shared','usr_b','EDITOR','usr_a'),('prj_batch_shared','usr_c','VIEWER','usr_a');
 INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,storage_key)VALUES
 ('ast_batch_shared','usr_a','prj_batch_shared','shared.png','IMAGE','image/png',1024,'aaa','READY',320,200,'ast_batch_shared'),
 ('ast_batch_own','usr_b','prj_batch_own','own.png','IMAGE','image/png',2048,'bbb','READY',640,480,'ast_batch_own'),
 ('ast_batch_private','usr_a','prj_batch_private','PRIVATE_FILE.png','IMAGE','image/png',1024,'ccc','READY',320,200,'ast_batch_private'),
 ('ast_batch_team','usr_a','prj_batch_private','team.png','IMAGE','image/png',1024,'ddd','READY',320,200,'ast_batch_team'),
 ('ast_batch_pending','usr_a','prj_batch_shared','pending.png','IMAGE','image/png',1024,'eee','PROCESSING',320,200,'ast_batch_pending'),
 ('ast_batch_deleted','usr_a','prj_batch_shared','deleted.png','IMAGE','image/png',1024,'fff','READY',320,200,'ast_batch_deleted');
 UPDATE assets SET deleted_at=now() WHERE id='ast_batch_deleted';
 INSERT INTO collaboration.teams(id,owner_id,name)VALUES('team_batch','usr_a','Batch team');
 INSERT INTO collaboration.team_members(team_id,user_id,role,created_by)VALUES('team_batch','usr_b','VIEWER','usr_a');
 INSERT INTO collaboration.team_entries(id,team_id,name,kind,source_kind,source_id,source_version,source_owner_id,content,created_by,updated_by)VALUES('entry_batch','team_batch','Team asset','ASSET','ASSET','ast_batch_team','1','usr_a','{}','usr_a','usr_a');
 INSERT INTO collaboration.team_asset_refs(entry_id,team_id,asset_id,asset_owner_id,sort_order)VALUES('entry_batch','team_batch','ast_batch_team','usr_a',0);`); err != nil {
		t.Fatal(err)
	}
	var authCalls atomic.Int64
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		authCalls.Add(1)
		uid := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if uid != "usr_a" && uid != "usr_b" && uid != "usr_c" {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture")
		}
		return integrationPrincipal(uid), nil
	})
	runtime := &assetBatchRuntime{integrationRuntime: &integrationRuntime{}}
	cfg := testConfig(t)
	router, err := NewWithAuthorization(cfg, db, auth, authorization.New(runtime, "cli_test", &collaborationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	call := func(actor string, ids []string, status int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/v2/assets/resolve-batch", strings.NewReader(string(encode(assetResolveBatchRequest{AssetIDs: ids}))))
		request.Header.Set("Content-Type", "application/json")
		if actor != "" {
			request.Header.Set("Authorization", "Bearer "+actor)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("batch returned %d wanted %d: %s", response.Code, status, response.Body.String())
		}
		if status != 200 && (strings.Contains(response.Body.String(), "previewUrl") || strings.Contains(response.Body.String(), "PRIVATE_FILE") || strings.Contains(response.Body.String(), "?token=")) {
			t.Fatal("failed batch returned partial metadata or signed URLs", response.Body.String())
		}
		return response
	}
	call("", []string{"ast_batch_shared"}, 401)
	runtime.denied.Store(true)
	call("usr_b", []string{"ast_batch_shared"}, 403)
	runtime.denied.Store(false)
	// A denial is intentionally cached by the real authorization service. Use a
	// fresh service for the granted fixture rather than weakening that cache or
	// waiting on its production lifetime.
	router, err = NewWithAuthorization(cfg, db, auth, authorization.New(runtime, "cli_test", &collaborationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	beforeAuth, beforeScopes := authCalls.Load(), runtime.scopes.Load()
	response := call("usr_b", []string{"ast_batch_shared", "ast_batch_own", "ast_batch_shared"}, 200)
	if authCalls.Load()-beforeAuth != 1 || runtime.scopes.Load()-beforeScopes != 1 {
		t.Fatal("one batch repeated upstream session/capability authentication", authCalls.Load()-beforeAuth, runtime.scopes.Load()-beforeScopes)
	}
	var envelope struct {
		Data struct{ Assets []map[string]any }
	}
	if err = json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || len(envelope.Data.Assets) != 2 || envelope.Data.Assets[0]["id"] != "ast_batch_shared" || envelope.Data.Assets[1]["id"] != "ast_batch_own" {
		t.Fatal("batch lost its exact deduplicated set or order", envelope, err)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("live metadata response may be cached")
	}
	for _, asset := range envelope.Data.Assets {
		mediaURL, err := url.Parse(asset["previewUrl"].(string))
		if err != nil {
			t.Fatal(err)
		}
		claims, err := security.New(cfg).Verify(mediaURL.Query().Get("token"), "asset-read")
		if err != nil || claims["sub"] != "usr_b" || claims["sid"] != "test-usr_b" || claims["aid"] != asset["id"] {
			t.Fatal("batch signed URL did not retain the real actor/session", claims, err)
		}
	}
	call("usr_c", []string{"ast_batch_shared"}, 200) // VIEWER may read, never write.
	call("usr_b", []string{"ast_batch_shared", "ast_batch_private"}, 404)
	call("usr_b", []string{"ast_batch_shared", "ast_batch_deleted"}, 404)
	call("usr_b", []string{"ast_batch_shared", "ast_missing"}, 404)
	call("usr_b", []string{"ast_batch_shared", "ast_batch_pending"}, 409)
	call("usr_b", []string{"ast_batch_team"}, 200)
	if _, err := db.Exec(ctx, `DELETE FROM collaboration.team_members WHERE team_id='team_batch' AND user_id='usr_b'`); err != nil {
		t.Fatal(err)
	}
	call("usr_b", []string{"ast_batch_own", "ast_batch_team"}, 404)
	if _, err := db.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='prj_batch_shared' AND user_id='usr_b'`); err != nil {
		t.Fatal(err)
	}
	call("usr_b", []string{"ast_batch_own", "ast_batch_shared"}, 404)
	call("usr_a", []string{"ast_batch_shared"}, 200)
	if _, err := db.Exec(ctx, `UPDATE assets SET deleted_at=now() WHERE id='ast_batch_shared'`); err != nil {
		t.Fatal(err)
	}
	call("usr_a", []string{"ast_batch_shared"}, 404)
}
