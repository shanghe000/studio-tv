package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
	"studiotv.local/service/api/internal/testdb"
)

type collaborationSessions struct{}

func (*collaborationSessions) AuthenticateSession(_ context.Context, uid, sid string) (httpapi.Identity, error) {
	if !strings.Contains(" usr_a usr_b usr_c usr_d ", " "+uid+" ") || sid != "test-"+uid {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture session mismatch")
	}
	return integrationPrincipal(uid), nil
}
func (*collaborationSessions) RevokeSession(context.Context, string) error { return nil }

func TestPostgresCoreSharedProjectAndRevokedSignedUpload(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO users(id,email,display_name) VALUES('usr_a','a@example.test','Owner'),('usr_b','b@example.test','Editor'),('usr_c','c@example.test','Viewer'),('usr_d','d@example.test','Stranger');
 INSERT INTO projects(id,owner_id,name) VALUES('prj_shared','usr_a','Shared'),('prj_private','usr_a','Private');
 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('prj_shared','usr_b','EDITOR','usr_a'),('prj_shared','usr_c','VIEWER','usr_a');`); e != nil {
		t.Fatal(e)
	}
	cfg := testConfig(t)
	if probe := os.Getenv("FFPROBE_PATH"); probe != "" {
		cfg.FFprobePath = probe
	}
	data, e := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(data)
	checksum := hex.EncodeToString(sum[:])
	if _, e = db.Exec(ctx, `INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key) VALUES('ast_shared','usr_a','prj_shared','shared.png','IMAGE','image/png',$1,$2,'READY','ast_shared'),('ast_private','usr_a','prj_private','private.png','IMAGE','image/png',$1,$2,'READY','ast_private')`, len(data), checksum); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(cfg.StorageRoot, "ast_shared"), data, 0600); e != nil {
		t.Fatal(e)
	}
	authenticate := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		uid := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !strings.Contains(" usr_a usr_b usr_c usr_d ", " "+uid+" ") {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture")
		}
		return integrationPrincipal(uid), nil
	})
	router, e := NewWithAuthorization(cfg, db, authenticate, authorization.New(&integrationRuntime{}, "cli_test", &collaborationSessions{}))
	if e != nil {
		t.Fatal(e)
	}
	call := func(method, path, uid string, body any, headers map[string]string, want int) *httptest.ResponseRecorder {
		t.Helper()
		var raw []byte
		if b, ok := body.([]byte); ok {
			raw = b
		} else if body != nil {
			raw = encode(body)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		if uid != "" {
			r.Header.Set("Authorization", "Bearer "+uid)
		}
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s status=%d expected=%d body=%s", method, w.Code, want, w.Body.String())
		}
		return w
	}
	result := func(w *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var envelope map[string]any
		if e := json.Unmarshal(w.Body.Bytes(), &envelope); e != nil {
			t.Fatal(e)
		}
		return envelope["data"].(map[string]any)
	}
	for _, uid := range []string{"usr_a", "usr_b", "usr_c"} {
		p := result(call("GET", "/api/v1/projects/prj_shared", uid, nil, nil, 200))
		if p["ownerId"] != "usr_a" {
			t.Fatal("canonical owner changed")
		}
	}
	call("GET", "/api/v1/projects/prj_shared", "usr_d", nil, nil, 404)
	call("GET", "/api/v1/projects/prj_private", "usr_b", nil, nil, 404)
	call("PATCH", "/api/v1/projects/prj_shared", "usr_b", map[string]any{"name": "Edited"}, nil, 200)
	call("PATCH", "/api/v1/projects/prj_shared", "usr_c", map[string]any{"name": "Rejected"}, nil, 403)
	call("DELETE", "/api/v1/projects/prj_shared", "usr_b", nil, nil, 403)
	call("GET", "/api/v1/assets/ast_private", "usr_b", nil, nil, 404)
	graph := map[string]any{"schemaVersion": "1", "nodes": []any{map[string]any{"id": "node_private", "type": "image", "position": map[string]any{"x": 0, "y": 0}, "data": map[string]any{"assetId": "ast_private"}}}, "edges": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "zoom": 1}}
	call("PUT", "/api/v1/projects/prj_shared/snapshot", "usr_b", map[string]any{"graph": graph}, map[string]string{"If-Match": "\"1\""}, 422)
	call("PUT", "/api/v1/projects/prj_shared/snapshot", "usr_c", map[string]any{"graph": graph}, map[string]string{"If-Match": "\"1\""}, 403)
	shared := result(call("GET", "/api/v1/assets/ast_shared", "usr_b", nil, nil, 200))
	mediaURL, _ := url.Parse(shared["previewUrl"].(string))
	claims, e := security.New(cfg).Verify(mediaURL.Query().Get("token"), "asset-read")
	if e != nil || claims["sub"] != "usr_b" || claims["sid"] != "test-usr_b" {
		t.Fatal("shared read token did not bind the real actor/session")
	}
	call("HEAD", mediaURL.RequestURI(), "", nil, nil, 200)
	uploadBody := map[string]any{"projectId": "prj_shared", "fileName": "member.png", "mimeType": "image/png", "byteSize": len(data), "checksumSha256": checksum}
	key := uuid.NewString()
	upload := result(call("POST", "/api/v1/asset-uploads", "usr_b", uploadBody, map[string]string{"Idempotency-Key": key}, 201))
	var storageOwner, creator, uploadOwner string
	if e = db.QueryRow(ctx, `SELECT a.owner_id,a.created_by,u.owner_id FROM assets a JOIN asset_uploads u ON u.asset_id=a.id WHERE u.id=$1`, upload["id"]).Scan(&storageOwner, &creator, &uploadOwner); e != nil || storageOwner != "usr_a" || creator != "usr_b" || uploadOwner != "usr_b" {
		t.Fatalf("shared upload identity mismatch owner=%s creator=%s uploader=%s err=%v", storageOwner, creator, uploadOwner, e)
	}
	uploadURL, _ := url.Parse(upload["url"].(string))
	grant, e := security.New(cfg).Verify(uploadURL.Query().Get("token"), "asset-upload")
	if e != nil || grant["sub"] != "usr_b" || grant["sid"] != "test-usr_b" {
		t.Fatal("upload token did not bind uploader session")
	}
	call("POST", "/api/v1/asset-uploads", "usr_c", uploadBody, map[string]string{"Idempotency-Key": uuid.NewString()}, 403)
	stored := call("PUT", uploadURL.RequestURI(), "", data, map[string]string{"Content-Type": "image/png", "X-Checksum-Sha256": checksum}, 200)
	if _, err := exec.LookPath(cfg.FFprobePath); err == nil {
		complete := result(call("POST", "/api/v1/asset-uploads/"+upload["id"].(string)+"/complete", "usr_b", map[string]any{"etag": stored.Header().Get("ETag")}, map[string]string{"Idempotency-Key": uuid.NewString()}, 202))
		if complete["state"] != "READY" {
			t.Fatal("member upload completion did not publish READY bytes")
		}
	} else {
		t.Log("member media decoder happy path not run: ffprobe unavailable; signed revoke/PUT/checksum paths remain covered")
	}
	if _, e = db.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='prj_shared' AND user_id='usr_b'`); e != nil {
		t.Fatal(e)
	}
	call("HEAD", mediaURL.RequestURI(), "", nil, nil, 404)
	call("PUT", uploadURL.RequestURI(), "", data, map[string]string{"Content-Type": "image/png", "X-Checksum-Sha256": checksum}, 404)
	call("POST", "/api/v1/asset-uploads", "usr_b", uploadBody, map[string]string{"Idempotency-Key": key}, 404)
	call("POST", "/api/v1/asset-uploads/"+upload["id"].(string)+"/renew", "usr_b", nil, map[string]string{"Idempotency-Key": uuid.NewString()}, 404)
	call("POST", "/api/v1/asset-uploads/"+upload["id"].(string)+"/complete", "usr_b", map[string]any{"etag": "\"fixture\""}, map[string]string{"Idempotency-Key": uuid.NewString()}, 404)
}
