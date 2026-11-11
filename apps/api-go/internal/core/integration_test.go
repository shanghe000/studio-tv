package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	ipacruntime "studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
	"studiotv.local/service/api/internal/testdb"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type integrationRuntime struct {
	denied, unavailable, otherOnly atomic.Bool
	checks                         atomic.Int64
}

// This signed-read fixture starts with an already accepted asset so lease and
// ownership coverage does not depend on the separate upload/media inspector.
func TestPostgresSignedMediaPermissionLeaseExpiryPreservesSessionOwner(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	content, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES
	 ('usr_a','lease-a@example.test','','A'),('usr_b','lease-b@example.test','','B');
	 INSERT INTO projects(id,owner_id,name) VALUES('prj_lease','usr_a','Lease fixture');`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,storage_key)
	 VALUES('ast_lease','usr_a','prj_lease','lease.png','IMAGE','image/png',$1,$2,'READY',1,1,'ast_lease')`, len(content), hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.StorageRoot, "ast_lease"), content, 0600); err != nil {
		t.Fatal(err)
	}
	runtime, sessions := &integrationRuntime{}, &integrationSessions{}
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		if r.Header.Get("Authorization") == "Bearer test-owner-a" {
			return integrationPrincipal("usr_a"), nil
		}
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "test identity unavailable")
	})
	router, err := NewWithAuthorization(cfg, db, auth, authorization.New(runtime, "cli_test", sessions))
	if err != nil {
		t.Fatal(err)
	}
	requestHeaders := func(method, path, bearer string, want int, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Authorization", bearer)
		r.Header.Set("X-Subject-Id", "ipac-usr_b")
		r.Header.Set("X-Workspace-Id", "forged-workspace")
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("signed media fixture returned %d wanted %d: %s", w.Code, want, w.Body.String())
		}
		return w
	}
	request := func(path, bearer string, want int) *httptest.ResponseRecorder {
		return requestHeaders(http.MethodGet, path, bearer, want, nil)
	}
	asset := request("/api/v1/assets/ast_lease", "Bearer test-owner-a", 200)
	var envelope struct {
		Data struct {
			DownloadURL string `json:"downloadUrl"`
		}
	}
	if json.Unmarshal(asset.Body.Bytes(), &envelope) != nil || envelope.Data.DownloadURL == "" {
		t.Fatal("owned asset did not produce a real signed download URL")
	}
	media, err := url.Parse(envelope.Data.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	if w := request(media.RequestURI(), "", 200); !bytes.Equal(w.Body.Bytes(), content) || w.Header().Get("Cache-Control") != "private, no-cache, must-revalidate" {
		t.Fatal("signed owner did not receive the actual private asset bytes")
	}
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		for _, condition := range []string{etag, "W/" + etag, `"other", W/` + etag, "*"} {
			w := requestHeaders(method, media.RequestURI(), "", 304, map[string]string{"If-None-Match": condition})
			if w.Body.Len() != 0 || w.Header().Get("ETag") != etag || w.Header().Get("Cache-Control") != "private, no-cache, must-revalidate" || w.Header().Get("Content-Length") != "" {
				t.Fatal("private conditional response must reuse only the authorized matching representation")
			}
		}
	}
	if w := requestHeaders(http.MethodGet, media.RequestURI(), "", 200, map[string]string{"If-None-Match": `"other"`}); !bytes.Equal(w.Body.Bytes(), content) {
		t.Fatal("different conditional tag did not return the complete asset")
	}
	for _, ifRange := range []string{"", etag} {
		w := requestHeaders(http.MethodGet, media.RequestURI(), "", 206, map[string]string{"Range": "bytes=0-7", "If-Range": ifRange})
		if !bytes.Equal(w.Body.Bytes(), content[:8]) || w.Header().Get("Content-Range") == "" {
			t.Fatal("current range did not preserve exact partial content")
		}
	}
	if w := requestHeaders(http.MethodHead, media.RequestURI(), "", 206, map[string]string{"Range": "bytes=0-7", "If-Range": etag}); w.Body.Len() != 0 || w.Header().Get("Content-Length") != "8" {
		t.Fatal("HEAD range must preserve partial metadata without transferring bytes")
	}
	for _, ifRange := range []string{`"other"`, "W/" + etag, "Wed, 21 Oct 2015 07:28:00 GMT"} {
		w := requestHeaders(http.MethodGet, media.RequestURI(), "", 200, map[string]string{"Range": "bytes=0-7", "If-Range": ifRange})
		if !bytes.Equal(w.Body.Bytes(), content) || w.Header().Get("Content-Range") != "" {
			t.Fatal("stale or weak If-Range did not fall back to complete content")
		}
	}
	if w := requestHeaders(http.MethodGet, media.RequestURI(), "", 416, map[string]string{"Range": "bytes=0-1,3-4"}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unsupported ranges must remain errors without cache permission")
	}
	// A matching cache entry cannot conceal a missing local immutable object.
	file := filepath.Join(cfg.StorageRoot, "ast_lease")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if w := requestHeaders(http.MethodGet, media.RequestURI(), "", 503, map[string]string{"If-None-Match": etag}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing asset returned a reusable cache response")
	}
	if err := os.WriteFile(file, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, content[:8], 0600); err != nil {
		t.Fatal(err)
	}
	if w := requestHeaders(http.MethodGet, media.RequestURI(), "", 503, map[string]string{"If-None-Match": etag}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("truncated immutable object returned a reusable cache response")
	}
	if err := os.WriteFile(file, content, 0600); err != nil {
		t.Fatal(err)
	}
	// A valid local signature for another permitted user cannot select this
	// owner's asset, and the right owner cannot reuse another local session.
	tokens := security.New(cfg)
	otherOwner, err := tokens.Sign(map[string]any{"sub": "usr_b", "aid": "ast_lease", "sid": "test-usr_b"}, "asset-read", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	request("/storage/assets/ast_lease?token="+url.QueryEscape(otherOwner), "", 404)
	if w := requestHeaders(http.MethodGet, "/storage/assets/ast_lease?token="+url.QueryEscape(otherOwner), "", 404, map[string]string{"If-None-Match": "*"}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("foreign asset access bypassed conditional authorization")
	}
	// The same valid signed URL may revalidate only while its project membership
	// still grants read access; the local session and IPAC lease stay valid.
	if _, err := db.Exec(ctx, `INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('prj_lease','usr_b','VIEWER','usr_a')`); err != nil {
		t.Fatal(err)
	}
	requestHeaders(http.MethodGet, "/storage/assets/ast_lease?token="+url.QueryEscape(otherOwner), "", 304, map[string]string{"If-None-Match": etag})
	if _, err := db.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='prj_lease' AND user_id='usr_b'`); err != nil {
		t.Fatal(err)
	}
	if w := requestHeaders(http.MethodGet, "/storage/assets/ast_lease?token="+url.QueryEscape(otherOwner), "", 404, map[string]string{"If-None-Match": etag}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("revoked project membership bypassed conditional authorization")
	}
	wrongSession, err := tokens.Sign(map[string]any{"sub": "usr_a", "aid": "ast_lease", "sid": "test-usr_b"}, "asset-read", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	request("/storage/assets/ast_lease?token="+url.QueryEscape(wrongSession), "", 401)
	if w := requestHeaders(http.MethodGet, "/storage/assets/ast_lease?token="+url.QueryEscape(wrongSession), "", 401, map[string]string{"If-None-Match": "*"}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("invalid signed session bypassed conditional authorization")
	}
	// The extra conditional reads may outlast the one-second fixture lease.
	// Obtain fresh allowed evidence before testing its hard expiry.
	time.Sleep(1100 * time.Millisecond)
	request(media.RequestURI(), "", 200)
	runtime.denied.Store(true)
	request(media.RequestURI(), "", 200)
	time.Sleep(1100 * time.Millisecond)
	if w := request(media.RequestURI(), "", 403); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("expired permission denial can be cached by a browser")
	}
	if w := requestHeaders(http.MethodGet, media.RequestURI(), "", 403, map[string]string{"If-None-Match": etag}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("revoked permission bypassed conditional authorization")
	}
	// Local session verification remains immediate even while upstream evidence
	// is cached; this uses the exact earlier URL, owner, and session.
	sessions.revoked.Store(true)
	request(media.RequestURI(), "", 401)
	if w := requestHeaders(http.MethodHead, media.RequestURI(), "", 401, map[string]string{"If-None-Match": etag}); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("logged out session bypassed conditional authorization")
	}
	if runtime.checks.Load() != 0 {
		t.Fatal("signed media used a redundant runtime Check")
	}
}

func (c *integrationRuntime) Check(_ context.Context, request ipacruntime.CheckRequest) (ipacruntime.Decision, error) {
	c.checks.Add(1)
	if c.unavailable.Load() {
		return ipacruntime.Decision{}, errors.New("IPAC offline")
	}
	validScope := request.Scope.ProjectID == "ipac_project" && (request.Scope.EnvironmentID == "ipac_env" || request.Scope.EnvironmentID == "ipac_other_env")
	return ipacruntime.Decision{Allowed: validScope && !c.denied.Load() && request.CapabilityCode == authorization.TVAccess, SubjectStatus: "ACTIVE", ApplicationStatus: "ACTIVE", CurrentSessionVersion: 1}, nil
}
func (c *integrationRuntime) EffectiveScopes(context.Context, ipacruntime.EffectiveScopesRequest) (ipacruntime.EffectiveScopes, error) {
	if c.unavailable.Load() {
		return ipacruntime.EffectiveScopes{}, errors.New("IPAC offline")
	}
	if c.denied.Load() {
		return ipacruntime.EffectiveScopes{SubjectStatus: "ACTIVE", ApplicationStatus: "ACTIVE", CurrentSessionVersion: 1}, nil
	}
	scopes := []ipacruntime.EffectiveScope{
		{ProjectID: "ipac_project", ProjectCode: "test", ProjectName: "Test project", EnvironmentID: "ipac_env", EnvironmentCode: "dev", EnvironmentName: "Development", CapabilityCodes: authorization.CapabilityCodes},
		{ProjectID: "ipac_project", ProjectCode: "test", ProjectName: "Test project", EnvironmentID: "ipac_other_env", EnvironmentCode: "review", EnvironmentName: "Review", CapabilityCodes: authorization.CapabilityCodes},
	}
	if c.otherOnly.Load() {
		scopes = scopes[1:]
	}
	return ipacruntime.EffectiveScopes{SubjectStatus: "ACTIVE", ApplicationStatus: "ACTIVE", CurrentSessionVersion: 1, CacheTTLSeconds: 1, Scopes: scopes}, nil
}

type integrationSessions struct{ revoked atomic.Bool }

func integrationPrincipal(uid string) httpapi.Identity {
	return httpapi.Identity{UserID: uid, SessionID: "test-" + uid, IPACIssuer: "https://ipac.example.test", IPACSubjectID: "ipac-" + uid, IPACSessionID: "ipac-session-" + uid, IPACSessionVersion: 1}
}
func (s *integrationSessions) AuthenticateSession(_ context.Context, uid, sid string) (httpapi.Identity, error) {
	if s.revoked.Load() || sid != "test-"+uid || uid != "usr_a" && uid != "usr_b" {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "session revoked")
	}
	return integrationPrincipal(uid), nil
}
func (s *integrationSessions) RevokeSession(context.Context, string) error {
	s.revoked.Store(true)
	return nil
}

func TestPostgresCoreIntegration(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var e error
	if e = database.Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, "INSERT INTO users(id,email,password_hash,display_name)VALUES('usr_a','a@example.test','','Owner A'),('usr_b','b@example.test','','Owner B')"); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, `INSERT INTO ipac_workspaces(id,application_id,ipac_project_id,ipac_environment_id,project_code,project_name,environment_code,environment_name,risk_level)VALUES
	('wsp_test','cli_test','ipac_project','ipac_env','test','Test project','dev','Development','NORMAL'),
	('wsp_other','cli_test','ipac_project','ipac_other_env','test','Test project','review','Review','NORMAL')`); e != nil {
		t.Fatal(e)
	}
	runtimeClient, signedSessions := &integrationRuntime{}, &integrationSessions{}
	authorizer := authorization.New(runtimeClient, "cli_test", signedSessions)
	cfg := testConfig(t)
	cfg.FFprobePath = os.Getenv("FFPROBE_PATH")
	if cfg.FFprobePath == "" {
		cfg.FFprobePath = "ffprobe"
	}
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		switch r.Header.Get("Authorization") {
		case "Bearer test-owner-a":
			return integrationPrincipal("usr_a"), nil
		case "Bearer test-owner-b":
			return integrationPrincipal("usr_b"), nil
		}
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "Test identity unavailable")
	})
	router, e := NewWithAuthorization(cfg, db, auth, authorizer)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(router)
	t.Cleanup(func() { server.Close() })
	client := server.Client()
	freshLease := func() {
		t.Helper()
		server.Close()
		next, err := NewWithAuthorization(cfg, db, auth, authorization.New(runtimeClient, "cli_test", signedSessions))
		if err != nil {
			t.Fatal(err)
		}
		server = httptest.NewServer(next)
		client = server.Client()
	}
	type response struct {
		Status  int
		Headers http.Header
		Data    map[string]any
		Bytes   []byte
	}
	request := func(method, path, user string, body any, headers map[string]string) response {
		t.Helper()
		var payload io.Reader
		if raw, ok := body.([]byte); ok {
			payload = bytes.NewReader(raw)
		} else if body != nil {
			payload = bytes.NewReader(encode(body))
		}
		req, e := http.NewRequestWithContext(ctx, method, server.URL+path, payload)
		if e != nil {
			t.Fatal(e)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if user != "" {
			req.Header.Set("Authorization", "Bearer "+user)
		}
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		res, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		raw, e := io.ReadAll(res.Body)
		if e != nil {
			t.Fatal(e)
		}
		var parsed map[string]any
		json.Unmarshal(raw, &parsed)
		return response{res.StatusCode, res.Header, parsed, raw}
	}
	assertStatus := func(res response, status int) {
		t.Helper()
		if res.Status != status {
			t.Fatalf("wanted status %d got %d %s", status, res.Status, res.Bytes)
		}
	}
	assertStatus(request("GET", "/readyz", "", nil, nil), 200)
	assertStatus(request("GET", "/api/v1/projects", "demo-token", nil, nil), 401)
	assertStatus(request("GET", "/api/v1/projects", "test-owner-a", nil, map[string]string{"X-Team-Id": "other-team"}), 403)
	assertStatus(request("GET", "/api/v1/workspaces", "test-owner-a", nil, nil), 404)
	assertStatus(request("GET", "/api/v1/projects", "test-owner-a", nil, nil), 200)
	assertStatus(request("GET", "/api/v1/projects", "test-owner-a", nil, map[string]string{"X-Workspace-Id": "attacker-chosen,scope"}), 200)
	if _, e = db.Exec(ctx, "INSERT INTO projects(id,owner_id,name)VALUES('prj_legacy','usr_a','Historical unassigned')"); e != nil {
		t.Fatal(e)
	}
	assertStatus(request("GET", "/api/v1/projects/prj_legacy", "test-owner-a", nil, nil), 200)
	assertStatus(request("GET", "/api/v1/projects/prj_legacy", "test-owner-b", nil, map[string]string{"X-Workspace-Id": "wsp_test"}), 404)
	list := request("GET", "/api/v1/projects", "test-owner-a", nil, nil)
	assertStatus(list, 200)
	if list.Data["data"].(map[string]any)["total"] != float64(1) {
		t.Fatal("owned historical project was hidden behind obsolete workspace metadata")
	}
	// UUID headers are case insensitive; both requests must share the same advisory lock.
	raceKey := uuid.NewString()
	var concurrent [2]response
	var wg sync.WaitGroup
	for i, key := range []string{raceKey, strings.ToUpper(raceKey)} {
		wg.Add(1)
		go func(index int, key string) {
			defer wg.Done()
			concurrent[index] = request("POST", "/api/v1/projects", "test-owner-a", map[string]any{"name": "Concurrent idempotency"}, map[string]string{"Idempotency-Key": key})
		}(i, key)
	}
	wg.Wait()
	assertStatus(concurrent[0], 201)
	assertStatus(concurrent[1], 201)
	if concurrent[0].Data["data"].(map[string]any)["id"] != concurrent[1].Data["data"].(map[string]any)["id"] {
		t.Fatal("case variant key created two projects")
	}
	key := uuid.NewString()
	created := request("POST", "/api/v1/projects", "test-owner-a", map[string]any{"name": "持久项目 <a> & 中文"}, map[string]string{"Idempotency-Key": key})
	assertStatus(created, 201)
	pid := created.Data["data"].(map[string]any)["id"].(string)
	again := request("POST", "/api/v1/projects", "test-owner-a", map[string]any{"name": "持久项目 <a> & 中文"}, map[string]string{"Idempotency-Key": key})
	assertStatus(again, 201)
	if again.Data["data"].(map[string]any)["id"] != pid {
		t.Fatal("idempotency created another project")
	}
	assertStatus(request("POST", "/api/v1/projects", "test-owner-a", map[string]any{"name": "Changed payload"}, map[string]string{"Idempotency-Key": key}), 409)
	assertStatus(request("POST", "/api/v1/projects", "test-owner-a", map[string]any{"name": "持久项目 <a> & 中文"}, map[string]string{"Idempotency-Key": key, "X-Workspace-Id": "wsp_other"}), 201)
	assertStatus(request("GET", "/api/v1/projects/"+pid, "test-owner-b", nil, nil), 404)
	assertStatus(request("GET", "/api/v1/projects/"+pid, "test-owner-a", nil, map[string]string{"X-Workspace-Id": "wsp_other"}), 200)
	var createdWorkspace *string
	if e = db.QueryRow(ctx, "SELECT workspace_id FROM projects WHERE id=$1", pid).Scan(&createdWorkspace); e != nil || createdWorkspace != nil {
		t.Fatal("new project was bound to an IPAC authorization scope", e)
	}
	// Simulate retained metadata from the retired workspace experiment. It must
	// not partition the owner's data or influence the current authorization scope.
	if _, e = db.Exec(ctx, "INSERT INTO projects(id,owner_id,name,workspace_id)VALUES('prj_old_scope_a','usr_a','Former scope A','wsp_test'),('prj_old_scope_b','usr_a','Former scope B','wsp_other')"); e != nil {
		t.Fatal(e)
	}
	otherWorkspacePID := "prj_old_scope_b"
	runtimeClient.otherOnly.Store(true)
	freshLease()
	allOwned := request("GET", "/api/v1/projects", "test-owner-a", nil, map[string]string{"X-Workspace-Id": "untrusted-space"})
	assertStatus(allOwned, 200)
	if allOwned.Data["data"].(map[string]any)["total"] != float64(5) {
		t.Fatal("effective IPAC scope partitioned owned projects", allOwned.Data)
	}
	for _, id := range []string{"prj_legacy", pid, "prj_old_scope_a", "prj_old_scope_b"} {
		assertStatus(request("GET", "/api/v1/projects/"+id, "test-owner-a", nil, nil), 200)
	}
	assertStatus(request("GET", "/api/v1/projects/prj_old_scope_b", "test-owner-b", nil, map[string]string{"X-Workspace-Id": "wsp_other"}), 404)
	var metadata string
	if e = db.QueryRow(ctx, "SELECT workspace_id FROM projects WHERE id='prj_old_scope_a'").Scan(&metadata); e != nil || metadata != "wsp_test" {
		t.Fatal("retained metadata was rewritten", e)
	}
	runtimeClient.denied.Store(true)
	freshLease()
	forgedHeaders := map[string]string{"X-Workspace-Id": "wsp_test", "X-Subject-Id": "ipac-usr_a", "X-IPAC-Session-Version": "1", "Idempotency-Key": uuid.NewString()}
	assertStatus(request("GET", "/api/v1/projects", "test-owner-a", nil, forgedHeaders), 403)
	assertStatus(request("POST", "/api/v1/projects", "test-owner-a", map[string]any{"name": "Denied"}, forgedHeaders), 403)
	assertStatus(request("GET", "/api/v1/projects", "demo-token", nil, forgedHeaders), 401)
	runtimeClient.denied.Store(false)
	freshLease()
	snap := request("GET", "/api/v1/projects/"+pid+"/snapshot", "test-owner-a", nil, nil)
	assertStatus(snap, 200)
	if snap.Headers.Get("ETag") != "\"1\"" {
		t.Fatal("initial etag mismatch")
	}
	graph := graphFrom(t, `{"schemaVersion":"1","nodes":[{"id":"node_a","type":"text","position":{"x":44,"y":66},"data":{"text":"persists"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	saved := request("PUT", "/api/v1/projects/"+pid+"/snapshot", "test-owner-a", map[string]any{"graph": graph}, map[string]string{"If-Match": "\"1\""})
	assertStatus(saved, 200)
	if saved.Headers.Get("ETag") != "\"2\"" {
		t.Fatal("revision did not increment")
	}
	assertStatus(request("PUT", "/api/v1/projects/"+pid+"/snapshot", "test-owner-a", map[string]any{"graph": graph}, map[string]string{"If-Match": "\"1\""}), 412)
	// Rebuild the HTTP runtime against the same database and filesystem; no state is held in memory.
	router, e = NewWithAuthorization(cfg, db, auth, authorizer)
	if e != nil {
		t.Fatal(e)
	}
	second := httptest.NewServer(router)
	defer second.Close()
	original := server.URL
	server.URL = second.URL
	restored := request("GET", "/api/v1/projects/"+pid+"/snapshot", "test-owner-a", nil, nil)
	assertStatus(restored, 200)
	if restored.Data["data"].(map[string]any)["revision"] != float64(2) {
		t.Fatal("database revision did not persist")
	}
	server.URL = original
	png, e := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(png)
	checksum := hex.EncodeToString(sum[:])
	uploadKey := uuid.NewString()
	uploadBody := map[string]any{"projectId": "prj_old_scope_a", "fileName": "sample.png", "mimeType": "image/png", "byteSize": json.Number("6.8e1"), "checksumSha256": checksum}
	init := request("POST", "/api/v1/asset-uploads", "test-owner-a", uploadBody, map[string]string{"Idempotency-Key": uploadKey})
	assertStatus(init, 201)
	upload := init.Data["data"].(map[string]any)
	for _, equivalent := range []json.Number{"68.0", "68"} {
		uploadBody["byteSize"] = equivalent
		replay := request("POST", "/api/v1/asset-uploads", "test-owner-a", uploadBody, map[string]string{"Idempotency-Key": uploadKey})
		assertStatus(replay, 201)
		if replay.Data["data"].(map[string]any)["assetId"] != upload["assetId"] {
			t.Fatal("equivalent integer notation created another asset")
		}
	}
	signed, e := url.Parse(upload["url"].(string))
	if e != nil {
		t.Fatal(e)
	}
	storagePath := signed.RequestURI()
	putHeaders := map[string]string{}
	for key, value := range upload["headers"].(map[string]any) {
		putHeaders[key] = value.(string)
	}
	assertStatus(request("PUT", storagePath, "", bytes.Repeat([]byte{1}, len(png)), putHeaders), 422)
	put := request("PUT", storagePath, "", png, putHeaders)
	assertStatus(put, 200)
	completeKey := uuid.NewString()
	completePath := "/api/v1/asset-uploads/" + upload["id"].(string) + "/complete"
	ready := request("POST", completePath, "test-owner-a", map[string]any{"etag": put.Headers.Get("ETag")}, map[string]string{"Idempotency-Key": completeKey})
	assertStatus(ready, 202)
	asset := ready.Data["data"].(map[string]any)
	if asset["state"] != "READY" || asset["width"] != float64(1) {
		t.Fatalf("media metadata not verified %#v", asset)
	}
	assertStatus(request("POST", completePath, "test-owner-a", map[string]any{"etag": put.Headers.Get("ETag")}, map[string]string{"Idempotency-Key": completeKey}), 202)
	aid := asset["id"].(string)
	assertStatus(request("GET", "/api/v1/assets/"+aid, "test-owner-b", nil, nil), 404)
	ownedAssets := request("GET", "/api/v1/assets", "test-owner-a", nil, nil)
	assertStatus(ownedAssets, 200)
	if ownedAssets.Data["data"].(map[string]any)["total"] != float64(1) {
		t.Fatal("old workspace metadata hid an owned asset")
	}
	assertStatus(request("GET", "/api/v1/assets?projectId=prj_old_scope_a", "test-owner-a", nil, nil), 200)
	assertStatus(request("GET", "/api/v1/assets?projectId="+pid, "test-owner-a", nil, map[string]string{"X-Workspace-Id": "forged"}), 200)
	assertStatus(request("GET", "/api/v1/assets?projectId="+pid, "test-owner-b", nil, nil), 404)
	media, e := url.Parse(asset["downloadUrl"].(string))
	if e != nil {
		t.Fatal(e)
	}
	partial := request("GET", media.RequestURI(), "", nil, map[string]string{"Range": "bytes=0-7"})
	assertStatus(partial, 206)
	if !bytes.Equal(partial.Bytes, png[:8]) || partial.Headers.Get("Content-Range") == "" {
		t.Fatal("range content mismatch")
	}
	assertStatus(request("HEAD", media.RequestURI(), "", nil, nil), 200)
	// A real uploaded image is protected while a private gallery references it.
	// Soft deleting the gallery releases this product reference, preserving bytes.
	if _, err := db.Exec(ctx, `INSERT INTO library.collections(owner_id) VALUES('usr_a');
	 INSERT INTO library.items(id,owner_id,title,kind) VALUES('gallery_uploaded','usr_a','Uploaded role','ROLE');`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key)
	 SELECT 'asset_gallery_fixture',owner_id,project_id,'gallery.png',kind,mime_type,byte_size,checksum_sha256,state,storage_key FROM assets WHERE id=$1`, aid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO library.item_media_refs(item_id,owner_id,asset_id,sort_order,is_main) VALUES('gallery_uploaded','usr_a','asset_gallery_fixture',0,true)`); err != nil {
		t.Fatal(err)
	}
	blockedGallery := request("DELETE", "/api/v1/assets/asset_gallery_fixture", "test-owner-a", nil, nil)
	assertStatus(blockedGallery, 409)
	if blockedGallery.Data["code"] != "ASSET_IN_USE" {
		t.Fatal("active gallery reference was ignored")
	}
	if _, err := db.Exec(ctx, `UPDATE library.items SET deleted_at=now(),revision=revision+1 WHERE id='gallery_uploaded'`); err != nil {
		t.Fatal(err)
	}
	assertStatus(request("DELETE", "/api/v1/assets/asset_gallery_fixture", "test-owner-a", nil, nil), 200)
	legacySignature, err := security.New(cfg).Sign(map[string]any{"sub": "usr_a", "aid": aid}, "asset-read", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(request("GET", "/storage/assets/"+aid+"?token="+url.QueryEscape(legacySignature), "", nil, nil), 401)
	assertStatus(request("GET", media.RequestURI(), "", nil, map[string]string{"Range": "bytes=999999-"}), 416)
	other := request("POST", "/api/v1/projects", "test-owner-b", map[string]any{"name": "Other owner"}, map[string]string{"Idempotency-Key": uuid.NewString()})
	assertStatus(other, 201)
	otherPID := other.Data["data"].(map[string]any)["id"].(string)
	assetGraph := graphFrom(t, `{"schemaVersion":"1","nodes":[{"id":"node_a","type":"image","position":{"x":0,"y":0},"data":{"url":"rhtv-asset:`+aid+`"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	assertStatus(request("PUT", "/api/v1/projects/prj_old_scope_a/snapshot", "test-owner-a", map[string]any{"graph": assetGraph}, map[string]string{"If-Match": "\"1\""}), 200)
	assertStatus(request("PUT", "/api/v1/projects/"+otherWorkspacePID+"/snapshot", "test-owner-a", map[string]any{"graph": assetGraph}, map[string]string{"If-Match": "\"1\"", "X-Workspace-Id": "wsp_other"}), 200)
	assertStatus(request("PATCH", "/api/v1/projects/"+otherWorkspacePID, "test-owner-a", map[string]any{"coverAssetId": aid}, map[string]string{"X-Workspace-Id": "wsp_other"}), 200)
	assertStatus(request("PUT", "/api/v1/projects/"+otherPID+"/snapshot", "test-owner-b", map[string]any{"graph": assetGraph}, map[string]string{"If-Match": "\"1\""}), 422)
	assertStatus(request("PUT", "/api/v1/projects/"+pid+"/snapshot", "test-owner-a", map[string]any{"graph": assetGraph}, map[string]string{"If-Match": "\"2\""}), 200)
	assertStatus(request("DELETE", "/api/v1/assets/"+aid, "test-owner-a", nil, nil), 409)
	malformed := []byte("notimage")
	badSum := sha256.Sum256(malformed)
	badInit := request("POST", "/api/v1/asset-uploads", "test-owner-a", map[string]any{"projectId": pid, "fileName": "fake.png", "mimeType": "image/png", "byteSize": len(malformed), "checksumSha256": hex.EncodeToString(badSum[:])}, map[string]string{"Idempotency-Key": uuid.NewString()})
	assertStatus(badInit, 201)
	badUpload := badInit.Data["data"].(map[string]any)
	badURL, _ := url.Parse(badUpload["url"].(string))
	badHeaders := map[string]string{}
	for k, v := range badUpload["headers"].(map[string]any) {
		badHeaders[k] = v.(string)
	}
	badPut := request("PUT", badURL.RequestURI(), "", malformed, badHeaders)
	assertStatus(badPut, 200)
	assertStatus(request("POST", "/api/v1/asset-uploads/"+badUpload["id"].(string)+"/complete", "test-owner-a", map[string]any{"etag": badPut.Headers.Get("ETag")}, map[string]string{"Idempotency-Key": uuid.NewString()}), 422)
	rejected := request("GET", "/api/v1/assets/"+badUpload["assetId"].(string), "test-owner-a", nil, nil)
	assertStatus(rejected, 200)
	if rejected.Data["data"].(map[string]any)["state"] != "REJECTED" {
		t.Fatal("invalid media was not durably rejected")
	}
	if partial.Headers.Get("Cache-Control") != "private, no-cache, must-revalidate" {
		t.Fatal("media cache must revalidate before reusing bytes")
	}
	// A fresh one-second SDK lease permits this same signed URL and principal.
	// Revocation becomes visible at hard expiry, without rotating its session.
	freshLease()
	assertStatus(request("GET", media.RequestURI(), "", nil, nil), 200)
	runtimeClient.denied.Store(true)
	assertStatus(request("GET", media.RequestURI(), "", nil, nil), 200)
	time.Sleep(1100 * time.Millisecond)
	deniedMedia := request("GET", media.RequestURI(), "", nil, nil)
	assertStatus(deniedMedia, 403)
	if deniedMedia.Headers.Get("Cache-Control") != "no-store" {
		t.Fatal("authorization denial can be cached")
	}
	assertStatus(request("HEAD", media.RequestURI(), "", nil, nil), 403)
	assertStatus(request("PUT", storagePath, "", png, putHeaders), 403)
	assertStatus(request("GET", "/api/v1/projects", "test-owner-a", nil, nil), 403)
	runtimeClient.denied.Store(false)
	runtimeClient.unavailable.Store(true)
	freshLease()
	assertStatus(request("GET", media.RequestURI(), "", nil, nil), 503)
	assertStatus(request("GET", "/api/v1/projects", "test-owner-a", nil, nil), 503)
	runtimeClient.unavailable.Store(false)
	signedSessions.revoked.Store(true)
	assertStatus(request("GET", media.RequestURI(), "", nil, nil), 401)
	if runtimeClient.checks.Load() != 0 {
		t.Fatal("effective grants caused redundant runtime Check calls")
	}
}
