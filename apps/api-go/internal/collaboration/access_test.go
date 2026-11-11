package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/testdb"
)

func aclDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name,disabled) VALUES('u_owner','owner@example.test','Owner',false),('u_editor','editor@example.test','Editor',false),('u_viewer','viewer@example.test','Viewer',false),('u_other','other@example.test','Other',false),('u_disabled','disabled@example.test','Disabled',true),('u_legacy','legacy@example.test','Legacy',false);
 INSERT INTO public.federated_identities(issuer,subject_id,user_id,provider) SELECT 'fixture',id,id,'feishu' FROM public.users WHERE id<>'u_legacy';
 INSERT INTO public.projects(id,owner_id,name) VALUES('p_shared','u_owner','Shared'),('p_private','u_owner','Private');
 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('p_shared','u_editor','EDITOR','u_owner'),('p_shared','u_viewer','VIEWER','u_owner');`); e != nil {
		t.Fatal(e)
	}
	return db
}
func status(err error) int {
	if err == nil {
		return 200
	}
	var api *httpapi.Error
	if errors.As(err, &api) {
		return api.Status
	}
	return 500
}
func TestProjectRoleMatrixAndReadOnlyTransactions(t *testing.T) {
	db := aclDB(t)
	ctx := context.Background()
	for _, c := range []struct {
		actor, required, role string
		want                  int
	}{{"u_owner", OWNER, OWNER, 200}, {"u_editor", VIEWER, EDITOR, 200}, {"u_editor", EDITOR, EDITOR, 200}, {"u_editor", OWNER, EDITOR, 403}, {"u_viewer", VIEWER, VIEWER, 200}, {"u_viewer", EDITOR, VIEWER, 403}, {"u_other", VIEWER, "", 404}, {"u_disabled", VIEWER, "", 401}} {
		got, e := RequireProject(ctx, db, c.actor, "p_shared", c.required, false)
		if status(e) != c.want || e == nil && (got.ActorID != c.actor || got.StorageOwnerID != "u_owner" || got.Role != c.role) {
			t.Errorf("%s/%s: %+v status=%d", c.actor, c.required, got, status(e))
		}
	}
	tx, e := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = RequireProject(ctx, tx, "u_editor", "p_shared", VIEWER, false); e != nil {
		t.Fatalf("read-only access: %v", e)
	}
	if _, e = db.Exec(ctx, `UPDATE public.users SET disabled=true WHERE id='u_editor'`); e != nil {
		t.Fatal(e)
	}
	var got *string
	if e = db.QueryRow(ctx, `SELECT collaboration.project_role('p_shared','u_editor')`).Scan(&got); e != nil || got != nil {
		t.Fatalf("disabled SQL role=%v err=%v", got, e)
	}
}
func TestTeamGrantCapAndDirectRoleMaximum(t *testing.T) {
	db := aclDB(t)
	ctx := context.Background()
	if _, e := db.Exec(ctx, `INSERT INTO collaboration.teams(id,owner_id,name)VALUES('t_fixture','u_owner','Fixture'); INSERT INTO collaboration.team_members(team_id,user_id,role,created_by) VALUES('t_fixture','u_viewer','VIEWER','u_owner'),('t_fixture','u_other','EDITOR','u_owner'); INSERT INTO collaboration.project_teams(project_id,team_id,role,created_by) VALUES('p_private','t_fixture','EDITOR','u_owner'); INSERT INTO collaboration.project_members(project_id,user_id,role,created_by)VALUES('p_private','u_viewer','EDITOR','u_owner')`); e != nil {
		t.Fatal(e)
	}
	check := func(uid, want string) {
		t.Helper()
		a, e := RequireProject(ctx, db, uid, "p_private", VIEWER, false)
		if e != nil || a.Role != want {
			t.Fatalf("%s got %s err %v", uid, a.Role, e)
		}
	}
	check("u_viewer", EDITOR)
	check("u_other", EDITOR)
	check("u_owner", OWNER)
	if _, e := db.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='p_private'; UPDATE collaboration.project_teams SET role='VIEWER' WHERE project_id='p_private'`); e != nil {
		t.Fatal(e)
	}
	check("u_viewer", VIEWER)
	check("u_other", VIEWER)
	if _, e := db.Exec(ctx, `UPDATE collaboration.teams SET deleted_at=now() WHERE id='t_fixture'`); e != nil {
		t.Fatal(e)
	}
	if _, e := RequireProject(ctx, db, "u_other", "p_private", VIEWER, false); status(e) != 404 {
		t.Fatalf("deleted team grant remains: %v", e)
	}
}
func TestMembershipRevocationCoordinatesWithWriter(t *testing.T) {
	db := aclDB(t)
	ctx := context.Background()
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = RequireProject(ctx, tx, "u_editor", "p_shared", EDITOR, true); e != nil {
		t.Fatal(e)
	}
	// Establish the second tunnel connection before starting the bounded
	// lock wait; connection handshakes are not what this test measures.
	revoke, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	blocked, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	_, e = RequireProject(blocked, revoke, "u_owner", "p_shared", OWNER, true)
	_ = revoke.Rollback(context.Background())
	if e == nil {
		t.Fatal("revocation bypassed project writer lock")
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	revoke, e = db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer revoke.Rollback(ctx)
	if _, e = RequireProject(ctx, revoke, "u_owner", "p_shared", OWNER, true); e != nil {
		t.Fatal(e)
	}
	if _, e = revoke.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='p_shared' AND user_id='u_editor'`); e != nil {
		t.Fatal(e)
	}
	if e = revoke.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = RequireProject(ctx, db, "u_editor", "p_shared", EDITOR, false); status(e) != 404 {
		t.Fatalf("revoked writer accepted: %v", e)
	}
}
func TestProjectAssetScopeUsesExactReferences(t *testing.T) {
	db := aclDB(t)
	ctx := context.Background()
	if _, e := db.Exec(ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES('a_current','u_owner','p_shared','current.png','IMAGE','image/png',1,'checksum','READY'),('a_private','u_owner','p_private','private.png','IMAGE','image/png',1,'checksum','READY'),('a_uploading','u_owner','p_shared','pending.png','IMAGE','image/png',1,'checksum','UPLOADING'); UPDATE public.projects SET graph='{"schemaVersion":"1","nodes":[],"edges":[],"label":"mentions a_private but is not a ref"}' WHERE id='p_shared'`); e != nil {
		t.Fatal(e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_editor", "p_shared", []string{"a_current"}); e != nil {
		t.Fatal(e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_editor", "p_shared", []string{"a_private"}); status(e) != 422 {
		t.Fatalf("owner namespace leak: %v", e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_owner", "p_shared", []string{"a_private"}); e != nil {
		t.Fatalf("legacy owner ref: %v", e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_editor", "p_shared", []string{"a_uploading"}); status(e) != 422 {
		t.Fatalf("unready ref accepted: %v", e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,internal_kind)VALUES('p_vault','u_owner','Private vault','ASSET_VAULT'); INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES('a_vault','u_owner','p_vault','vault.png','IMAGE','image/png',1,'checksum','READY')`); e != nil {
		t.Fatal(e)
	}
	if e := RequireAssetProjectRead(ctx, db, "u_owner", "a_vault"); e != nil {
		t.Fatalf("private owner vault read lost: %v", e)
	}
	if e := RequireAssetProjectRead(ctx, db, "u_editor", "a_vault"); status(e) != 404 {
		t.Fatalf("shared ACL exposed private vault: %v", e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_owner", "p_shared", []string{"a_vault"}); e != nil {
		t.Fatalf("owner vault reference lost: %v", e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_editor", "p_shared", []string{"a_vault"}); status(e) != 422 {
		t.Fatalf("shared editor injected vault: %v", e)
	}
	if e := RequireAssetProjectRead(ctx, db, "u_editor", "a_private"); status(e) != 404 {
		t.Fatalf("arbitrary text granted read: %v", e)
	}
	if _, e := db.Exec(ctx, `UPDATE public.projects SET graph='{"nodes":[{"data":{"assetId":"a_private"}}],"edges":[]}' WHERE id='p_shared'`); e != nil {
		t.Fatal(e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_editor", "p_shared", []string{"a_private"}); e != nil {
		t.Fatal(e)
	}
	if e := RequireAssetProjectRead(ctx, db, "u_viewer", "a_private"); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name)VALUES('p_foreign','u_other','Foreign'); INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES('a_foreign','u_other','p_foreign','foreign.png','IMAGE','image/png',1,'checksum','READY'); UPDATE public.projects SET graph='{"nodes":[{"data":{"assetId":"a_foreign"}}],"edges":[]}' WHERE id='p_shared'`); e != nil {
		t.Fatal(e)
	}
	if e := AuthorizeProjectAssets(ctx, db, "u_editor", "p_shared", []string{"a_foreign"}); status(e) != 422 {
		t.Fatalf("corrupt foreign-owner graph granted use: %v", e)
	}
	if e := RequireAssetProjectRead(ctx, db, "u_viewer", "a_foreign"); status(e) != 404 {
		t.Fatalf("corrupt foreign-owner graph granted read: %v", e)
	}
	if _, e := db.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='p_shared'`); e != nil {
		t.Fatal(e)
	}
	if e := RequireAssetProjectRead(ctx, db, "u_viewer", "a_private"); status(e) != 404 {
		t.Fatalf("revoked graph ref remains: %v", e)
	}
}
func TestGraphAssetReferencesDoNotMatchSubstrings(t *testing.T) {
	refs, e := GraphAssetIDs([]byte(`{"text":"a_private","nested":[{"assetId":"a_exact"},"rhtv-asset:a_uri","rhtv-asset:a_uri"]}`))
	if e != nil || len(refs) != 2 || !refs["a_exact"] || !refs["a_uri"] || refs["a_private"] {
		t.Fatalf("refs=%v err=%v", refs, e)
	}
}
func TestCollaborationHTTPUsesCASAndFederatedTargets(t *testing.T) {
	db := aclDB(t)
	r := chi.NewRouter()
	r.Use(httpapi.RequestContext)
	protect := func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, q *http.Request) error {
			return h(w, httpapi.WithIdentity(q, httpapi.Identity{UserID: q.Header.Get("X-Test-Actor"), SessionID: "fixture"}))
		})
	}
	if e := RegisterRoutes(r, db, protect); e != nil {
		t.Fatal(e)
	}
	call := func(method, path, uid, b, etag string, want int) *httptest.ResponseRecorder {
		t.Helper()
		q := httptest.NewRequest(method, "/api/v2/collaboration"+path, strings.NewReader(b))
		q.Header.Set("X-Test-Actor", uid)
		q.Header.Set("Content-Type", "application/json")
		if etag != "" {
			q.Header.Set("If-Match", etag)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, q)
		if w.Code != want {
			t.Fatalf("%s %s status=%d body=%s", method, path, w.Code, w.Body.String())
		}
		return w
	}
	list := call("GET", "/projects/p_shared/members", "u_owner", "", "", 200)
	et := list.Header().Get("ETag")
	call("PUT", "/projects/p_shared/members", "u_owner", `{"userId":"u_other","role":"VIEWER"}`, "", 428)
	call("PUT", "/projects/p_shared/members", "u_editor", `{"userId":"u_other","role":"VIEWER"}`, et, 403)
	call("PUT", "/projects/p_shared/members", "u_owner", `{"userId":"u_legacy","role":"VIEWER"}`, et, 404)
	updated := call("PUT", "/projects/p_shared/members", "u_owner", `{"userId":"u_other","role":"VIEWER"}`, et, 200)
	call("DELETE", "/projects/p_shared/members/u_other", "u_owner", "", et, 412)
	call("DELETE", "/projects/p_shared/members/u_owner", "u_owner", "", updated.Header().Get("ETag"), 403)
	call("DELETE", "/projects/p_shared/members/u_other", "u_owner", "", updated.Header().Get("ETag"), 200)
	call("GET", "/projects/p_shared/access", "u_other", "", "", 404)
	search := call("GET", "/users?q=Owner", "u_editor", "", "", 200)
	if strings.Contains(search.Body.String(), "email") || strings.Contains(search.Body.String(), "subject") {
		t.Fatal("user search leaked identity internals")
	}
	owned := call("GET", "/projects?scope=owned", "u_editor", "", "", 200)
	if strings.Contains(owned.Body.String(), "p_shared") {
		t.Fatal("shared project mislabeled owned")
	}
	shared := call("GET", "/projects?scope=shared", "u_editor", "", "", 200)
	if !strings.Contains(shared.Body.String(), "p_shared") || strings.Contains(shared.Body.String(), "p_private") {
		t.Fatal("shared list scope leaked private project")
	}
	created := call("POST", "/teams", "u_owner", `{"name":"HTTP team"}`, "", 201)
	var envelope struct {
		Data struct {
			ID string `json:"id"`
		}
	}
	if e := json.Unmarshal(created.Body.Bytes(), &envelope); e != nil || envelope.Data.ID == "" {
		t.Fatal("team creation did not return identity")
	}
	tid := envelope.Data.ID
	teamMembers := call("GET", "/teams/"+tid+"/members", "u_owner", "", "", 200)
	teamUpdated := call("PUT", "/teams/"+tid+"/members", "u_owner", `{"userId":"u_other","role":"VIEWER"}`, teamMembers.Header().Get("ETag"), 200)
	call("PUT", "/teams/"+tid+"/members", "u_other", `{"userId":"u_editor","role":"EDITOR"}`, teamUpdated.Header().Get("ETag"), 403)
	grants := call("GET", "/projects/p_shared/teams", "u_owner", "", "", 200)
	grantUpdated := call("PUT", "/projects/p_shared/teams", "u_owner", `{"teamId":"`+tid+`","role":"EDITOR"}`, grants.Header().Get("ETag"), 200)
	access := call("GET", "/projects/p_shared/access", "u_other", "", "", 200)
	if !strings.Contains(access.Body.String(), `"role":"VIEWER"`) || !strings.Contains(access.Body.String(), `"canEdit":false`) {
		t.Fatal("team viewer exceeded project grant cap")
	}
	call("DELETE", "/projects/p_shared/teams/"+tid, "u_owner", "", grantUpdated.Header().Get("ETag"), 200)
	call("GET", "/projects/p_shared/access", "u_other", "", "", 404)
	call("DELETE", "/teams/"+tid+"/members/u_other", "u_owner", "", teamUpdated.Header().Get("ETag"), 200)
	teamNow := call("GET", "/teams/"+tid, "u_owner", "", "", 200)
	call("PATCH", "/teams/"+tid, "u_owner", `{"name":"Renamed"}`, teamNow.Header().Get("ETag"), 200)
	call("DELETE", "/teams/"+tid, "u_owner", "", teamNow.Header().Get("ETag"), 412)
	teamNow = call("GET", "/teams/"+tid, "u_owner", "", "", 200)
	call("DELETE", "/teams/"+tid, "u_owner", "", teamNow.Header().Get("ETag"), 200)
	call("GET", "/teams/"+tid, "u_owner", "", "", 404)
}
