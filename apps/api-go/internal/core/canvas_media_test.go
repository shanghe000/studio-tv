package core

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/httpapi"
)

func TestPostgresCanvasLazyMediaReadsAndEditIsolation(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	cfg := testConfig(t)
	if _, err := f.db.Exec(f.ctx, `INSERT INTO projects(id,owner_id,name) VALUES ('p_other','usr_a','Other')`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(f.ctx, `INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key)
 VALUES ('visible','usr_a',$1,'visible.png','IMAGE','image/png',4,'hash','READY','visible'),('other','usr_a','p_other','private.png','IMAGE','image/png',4,'hash','READY','other')`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.StorageRoot, "visible"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	sessions := &integrationSessions{}
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		if r.Header.Get("Authorization") != "Bearer editor" {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "no session")
		}
		user := integrationPrincipal("usr_b")
		user.SessionExpiresAt = time.Now().Add(time.Hour)
		return user, nil
	})
	router, err := NewWithAuthorization(cfg, f.db, auth, authorization.New(&integrationRuntime{}, "cli_test", sessions))
	if err != nil {
		t.Fatal(err)
	}
	open := httptest.NewRequest("GET", "/api/v1/projects/"+nodeLeaseProject+"/snapshot", nil)
	open.Header.Set("Authorization", "Bearer editor")
	open.Header.Set(canvasMediaHeader, "lazy-v1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, open)
	cookies := w.Result().Cookies()
	if w.Code != 200 || len(cookies) != 1 {
		t.Fatalf("snapshot status=%d cookies=%d", w.Code, len(cookies))
	}
	c := cookies[0]
	scope := w.Header().Get(canvasMediaHeader)
	path := canvasMediaRoot + scope + "/"
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != path || c.MaxAge > 3600 || c.MaxAge <= 0 || len(scope) != 32 {
		t.Fatal("invalid display scope")
	}
	read := func(method, url string, grant *http.Cookie, headers map[string]string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, url, nil)
		if grant != nil {
			r.AddCookie(grant)
		}
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s: %d want %d", url, w.Code, want)
		}
		return w
	}
	read("GET", path+"visible", nil, nil, 401)
	read("GET", path+"visible", c, map[string]string{"Sec-Fetch-Site": "cross-site"}, 403)
	read("GET", canvasMediaRoot+strings.Repeat("0", 32)+"/visible", c, nil, 401)
	if res := read("GET", path+"visible", c, map[string]string{"Range": "bytes=1-2"}, 206); !bytes.Equal(res.Body.Bytes(), []byte("at")) {
		t.Fatal("range contents")
	}
	read("HEAD", path+"visible", c, nil, 200)
	read("GET", path+"other", c, nil, 404)
	read("GET", path+"absent", c, nil, 404)
	// A missing *existing* reference cannot block a node move or text edit; it
	// must still be rejected if copied to a new input/node.
	if _, err = f.db.Exec(f.ctx, `UPDATE projects SET graph=jsonb_set(graph,'{nodes,0,data,history}','["rhtv-asset:absent"]') WHERE id=$1`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	f.writer(t, f.owner, "page_owner", http.MethodPost, 200)
	f.operations(t, f.owner, "page_owner", "edit_around_missing", []canvasOperation{operationPatch("n1", "edit elsewhere")}, 200)
	empty := operationNode("empty")
	empty["data"] = map[string]any{"assetId": ""}
	f.operations(t, f.owner, "page_owner", "empty_placeholder", []canvasOperation{{Type: "node.create", Node: empty}}, 200)
	bad := operationNode("new")
	bad["data"] = map[string]any{"sourceObjects": []any{"rhtv-asset:absent"}}
	f.operations(t, f.owner, "page_owner", "copy_missing", []canvasOperation{{Type: "node.create", Node: bad}}, 422)
	if _, err = f.db.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id=$1 AND user_id='usr_b'`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	read("GET", path+"visible", c, map[string]string{"If-None-Match": `"hash"`}, 404)
	sessions.revoked.Store(true)
	read("GET", path+"visible", c, nil, 401)
}
