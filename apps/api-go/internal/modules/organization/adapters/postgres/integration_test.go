package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	organizationHTTP "studiotv.local/service/api/internal/modules/organization/adapters/http"
	"studiotv.local/service/api/internal/modules/organization/adapters/postgres"
	"studiotv.local/service/api/internal/modules/organization/application"
	"studiotv.local/service/api/internal/modules/organization/domain"
	"studiotv.local/service/api/internal/testdb"
	"strings"
	"sync"
	"testing"
	"time"
)

func setup(t *testing.T) (*pgxpool.Pool, context.Context, *application.Service, domain.Actor, domain.Actor) {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatalf("organization migration failed: %v", e)
	}
	a, b := domain.Actor{OwnerID: "org_a_" + uuid.NewString()}, domain.Actor{OwnerID: "org_b_" + uuid.NewString()}
	if _, e := db.Exec(ctx, "INSERT INTO public.users(id,email,display_name) VALUES($1,$1||'@example.test','A'),($2,$2||'@example.test','B')", a.OwnerID, b.OwnerID); e != nil {
		t.Fatal("users seed", e)
	}
	for _, actor := range []domain.Actor{a, b} {
		if _, e := db.Exec(ctx, "INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,'ordinary')", "project_"+actor.OwnerID, actor.OwnerID); e != nil {
			t.Fatal("project seed", e)
		}
	}
	if _, e := db.Exec(ctx, "INSERT INTO public.projects(id,owner_id,name,internal_kind) VALUES($1,$2,'vault','ASSET_VAULT')", "vault_"+a.OwnerID, a.OwnerID); e != nil {
		t.Fatal("vault seed", e)
	}
	return db, ctx, service(t, db), a, b
}
func service(t *testing.T, db *pgxpool.Pool) *application.Service {
	t.Helper()
	r, e := postgres.New(db)
	if e != nil {
		t.Fatal(e)
	}
	s, e := application.New(r)
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func cmd(t *testing.T, expected int64, key string, body any) application.Mutation {
	t.Helper()
	if key == "" {
		key = uuid.NewString()
	}
	m, e := application.Command(expected, key, body)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func create(t *testing.T, ctx context.Context, s *application.Service, a domain.Actor, name string, parent *string) domain.Folder {
	t.Helper()
	i := domain.FolderInput{Name: name, ParentID: parent}
	f, e := s.CreateFolder(ctx, a, i, cmd(t, 0, "", i))
	if e != nil {
		t.Fatal("folder create", e)
	}
	return f
}
func ptr(s string) *string  { return &s }
func conflict(e error) bool { var c *domain.VersionConflict; return errors.As(e, &c) }
func TestPostgresOrganizationConcurrentReceiptsMovesAndCoreInvalidation(t *testing.T) {
	db, ctx, s, a, b := setup(t)
	input := domain.FolderInput{Name: "concurrent % folder"}
	key := uuid.NewString()
	m := cmd(t, 0, key, input)
	var result [8]domain.Folder
	var errs [8]error
	var wg sync.WaitGroup
	for i := range result {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			command := m
			if i%2 == 1 {
				command.Key = strings.ToUpper(key)
			}
			result[i], errs[i] = s.CreateFolder(ctx, a, input, command)
		}(i)
	}
	wg.Wait()
	for i := range result {
		if errs[i] != nil || result[i].ID != result[0].ID {
			t.Fatal("concurrent folder receipt", i, errs[i])
		}
	}
	var count int
	if e := db.QueryRow(ctx, "SELECT count(*) FROM organization.project_folders WHERE owner_id=$1", a.OwnerID).Scan(&count); e != nil || count != 1 {
		t.Fatal("duplicate roots", e, count)
	}
	if e := db.QueryRow(ctx, "SELECT count(*) FROM public.idempotency_keys WHERE owner_id=$1 AND operation='organization:folder:create'", a.OwnerID).Scan(&count); e != nil || count != 1 {
		t.Fatal("duplicate receipt")
	}
	restarted := service(t, db)
	replayed, e := restarted.CreateFolder(ctx, a, input, m)
	if e != nil || replayed.ID != result[0].ID {
		t.Fatal("restart receipt", e)
	}
	changed := domain.FolderInput{Name: "changed"}
	if _, e = s.CreateFolder(ctx, a, changed, cmd(t, 0, key, changed)); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("different request reused key", e)
	}
	f1 := result[0]
	f2 := create(t, ctx, s, a, "second", nil)
	if _, e = s.Folder(ctx, b, f1.ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign folder visible")
	}
	projectID := "project_" + a.OwnerID
	var moves [2]domain.Membership
	var moveErrs [2]error
	for i, id := range []string{f1.ID, f2.ID} {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			moves[i], moveErrs[i] = s.Move(ctx, a, projectID, &id, cmd(t, 1, "", map[string]any{"folderId": id}))
		}(i, id)
	}
	wg.Wait()
	success, conflicts := 0, 0
	var current domain.Membership
	for i, e := range moveErrs {
		if e == nil {
			success++
			current = moves[i]
		} else if conflict(e) {
			conflicts++
		} else {
			t.Fatal("move error", e)
		}
	}
	if success != 1 || conflicts != 1 || current.Revision != 2 {
		t.Fatal("same project revision had two writers", success, conflicts)
	}
	if _, e = s.Move(ctx, b, projectID, nil, cmd(t, 2, "", nil)); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign project moved", e)
	}
	foreignFolder := create(t, ctx, s, b, "foreign", nil)
	if _, e = s.Move(ctx, a, projectID, &foreignFolder.ID, cmd(t, 2, "", nil)); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign target accepted", e)
	}
	fBefore, e := s.Folder(ctx, a, *current.FolderID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, "UPDATE public.projects SET name='real core rename',revision=revision+1,updated_at=now() WHERE id=$1", projectID); e != nil {
		t.Fatal("core update", e)
	}
	fAfter, e := s.Folder(ctx, a, *current.FolderID)
	if e != nil || fAfter.Revision <= fBefore.Revision {
		t.Fatal("core mutation did not invalidate folder", e)
	}
	if _, e = s.DeleteFolder(ctx, a, fBefore.ID, cmd(t, fBefore.Revision, "", nil)); !conflict(e) {
		t.Fatal("stale folder delete accepted", e)
	}
	for iteration := 0; iteration < 8; iteration++ {
		f, e := s.Folder(ctx, a, fAfter.ID)
		if e != nil {
			t.Fatal(e)
		}
		var renameErr, coreErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, renameErr = s.RenameFolder(ctx, a, f.ID, "race", cmd(t, f.Revision, "", map[string]string{"name": "race"}))
		}()
		go func() {
			defer wg.Done()
			_, coreErr = db.Exec(ctx, "UPDATE public.projects SET revision=revision+1,updated_at=now() WHERE id=$1", projectID)
		}()
		wg.Wait()
		if coreErr != nil || renameErr != nil && !conflict(renameErr) {
			t.Fatal("core/folder lock order failed", coreErr, renameErr)
		}
	}
	create(t, ctx, s, a, "literal_%_needle", nil)
	create(t, ctx, s, a, "literal_x_needle", nil)
	page, e := s.Folders(ctx, a, domain.Query{Page: 1, Size: 1, Keyword: "_%_", Scope: "FOLDER"})
	if e != nil || page.Total != 1 || len(page.Records) != 1 || page.Records[0].Folder.Name != "literal_%_needle" {
		t.Fatal("literal search did not escape wildcard", e, page.Total)
	}
	page, e = s.Entries(ctx, a, domain.Query{Page: 100000, Size: 100, Scope: "CANVAS"})
	if e != nil || page.Total != 1 || len(page.Records) != 0 {
		t.Fatal("empty page total", e, page.Total)
	}
}
func TestPostgresOrganizationNestedDeletionConstraintsAndSizePagination(t *testing.T) {
	db, ctx, s, a, b := setup(t)
	root := create(t, ctx, s, a, "root", nil)
	child := create(t, ctx, s, a, "child", &root.ID)
	grandchild := create(t, ctx, s, a, "grandchild", &child.ID)
	if grandchild.Level != 3 || grandchild.AllowCreateSubFolder {
		t.Fatal("depth config")
	}
	if _, e := s.CreateFolder(ctx, a, domain.FolderInput{Name: "too deep", ParentID: &grandchild.ID}, cmd(t, 0, "", nil)); !errors.Is(e, domain.ErrInvalid) {
		t.Fatal("fourth level accepted", e)
	}
	assertSQL := func(sql string, args ...any) {
		t.Helper()
		_, e := db.Exec(ctx, sql, args...)
		var p *pgconn.PgError
		if !errors.As(e, &p) || p.Code != "23514" {
			t.Fatal("SQL owner/depth constraint", e)
		}
	}
	assertSQL("UPDATE organization.project_folders SET parent_id=$2,revision=revision+1 WHERE id=$1", root.ID, grandchild.ID)
	assertSQL("INSERT INTO organization.project_memberships(project_id,owner_id,folder_id) VALUES($1,$2,$3)", "vault_"+a.OwnerID, a.OwnerID, root.ID)
	assertSQL("INSERT INTO organization.project_memberships(project_id,owner_id,folder_id) VALUES($1,$2,$3)", "project_"+b.OwnerID, a.OwnerID, root.ID)
	p, e := s.CreateProject(ctx, a, "large snapshot", &grandchild.ID, cmd(t, 0, "", nil))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES($1,$2,$3,'real.png','IMAGE','image/png',12345,$4,'READY')`, "asset_"+a.OwnerID, a.OwnerID, p.ID, strings.Repeat("0", 64)); e != nil {
		t.Fatal("real size seed", e)
	}
	small, e := s.CreateProject(ctx, a, "small snapshot", nil, cmd(t, 0, "", nil))
	if e != nil {
		t.Fatal(e)
	}
	page, e := s.Entries(ctx, a, domain.Query{Page: 1, Size: 1, Scope: "CANVAS", Sort: "SIZE_DESC"})
	if e != nil || page.Total != 3 || len(page.Records) != 1 || page.Records[0].Project.ID != p.ID || page.Records[0].ByteSize < 12345 {
		t.Fatal("size before pagination", e, page)
	}
	page, e = s.Entries(ctx, a, domain.Query{Page: 1, Size: 20, ParentID: &root.ID, Scope: "FOLDER"})
	if e != nil || page.Total != 1 || page.Records[0].Folder.ID != child.ID {
		t.Fatal("folder filter", e)
	}
	projectID := "project_" + a.OwnerID
	move, e := s.Move(ctx, a, projectID, &root.ID, cmd(t, 1, "", nil))
	if e != nil {
		t.Fatal(e)
	}
	moveKey := uuid.NewString()
	moveCommand := cmd(t, move.Revision, moveKey, map[string]any{"folderId": nil})
	moved, e := s.Move(ctx, a, projectID, nil, moveCommand)
	if e != nil {
		t.Fatal(e)
	}
	again, e := service(t, db).Move(ctx, a, projectID, nil, moveCommand)
	if e != nil || again.Revision != moved.Revision {
		t.Fatal("move receipt", e)
	}
	if _, e = s.Move(ctx, a, projectID, &root.ID, cmd(t, moved.Revision, "", nil)); e != nil {
		t.Fatal(e)
	}
	tree, e := s.Tree(ctx, a, small.ID)
	if e != nil || len(tree.Records) != 1 || tree.Records[0].Total != 3 {
		t.Fatal("actual target tree", e)
	}
	if _, e = s.Tree(ctx, b, small.ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign tree")
	}
	before, e := s.Folder(ctx, a, root.ID)
	if e != nil || before.Total != 2 {
		t.Fatal("descendant count", e, before)
	}
	deleteKey := uuid.NewString()
	command := cmd(t, before.Revision, deleteKey, nil)
	deleted, e := s.DeleteFolder(ctx, a, root.ID, command)
	if e != nil || len(deleted.DeletedFolderIDs) != 3 || len(deleted.DeletedProjectIDs) != 2 || deleted.Revision <= before.Revision {
		t.Fatal("recursive atomic deletion", e, deleted)
	}
	replay, e := service(t, db).DeleteFolder(ctx, a, root.ID, command)
	if e != nil || replay.Revision != deleted.Revision {
		t.Fatal("delete receipt", e)
	}
	for _, id := range []string{root.ID, child.ID, grandchild.ID} {
		if _, e = s.Folder(ctx, a, id); !errors.Is(e, domain.ErrNotFound) {
			t.Fatal("deleted folder visible", id, e)
		}
	}
	for _, id := range deleted.DeletedProjectIDs {
		if _, e = s.Membership(ctx, a, id); !errors.Is(e, domain.ErrNotFound) {
			t.Fatal("deleted project visible")
		}
	}
	var untouched int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM public.projects WHERE deleted_at IS NULL AND id=ANY($1::text[])", []string{small.ID, "vault_" + a.OwnerID, "project_" + b.OwnerID}).Scan(&untouched); e != nil || untouched != 3 {
		t.Fatal("cascade affected outsiders", e, untouched)
	}
	assertSQL("UPDATE organization.project_folders SET deleted_at=NULL,revision=revision+1 WHERE id=$1", root.ID)
	assertSQL("INSERT INTO organization.project_memberships(project_id,owner_id,folder_id) VALUES($1,$2,$3)", small.ID, a.OwnerID, root.ID)
	if e = database.Migrate(ctx, db); e != nil {
		t.Fatal("migration rerun", e)
	}
}
func TestPostgresOrganizationRealTaskInboxReadDeleteOwnershipAndHTTP(t *testing.T) {
	db, ctx, s, a, b := setup(t)
	page, e := s.Notifications(ctx, a, "", 1, 20)
	if e != nil || page.Total != 0 || page.Items == nil {
		t.Fatal("truthful empty inbox", e)
	}
	taskID := "task_" + uuid.NewString()
	if _, e = db.Exec(ctx, "INSERT INTO execution.tasks(id,owner_id,project_id,kind,state,request_hash,idempotency_key,payload) VALUES($1,$2,$3,'CANVAS','RUNNING',$4,$5,'{}')", taskID, a.OwnerID, "project_"+a.OwnerID, strings.Repeat("0", 64), uuid.NewString()); e != nil {
		t.Fatal("actual task seed", e)
	}
	if _, e = db.Exec(ctx, "UPDATE execution.tasks SET state='SUCCEEDED',revision=revision+1,updated_at=now() WHERE id=$1", taskID); e != nil {
		t.Fatal("actual terminal event", e)
	}
	if _, e = db.Exec(ctx, "UPDATE execution.tasks SET state='SUCCEEDED',revision=revision+1 WHERE id=$1", taskID); e != nil {
		t.Fatal(e)
	}
	page, e = service(t, db).Notifications(ctx, a, "GENERATION", 1, 20)
	if e != nil || page.Total != 1 || !strings.Contains(page.Items[0].Body["en"], taskID) || page.Items[0].Read {
		t.Fatal("real task notification", e, page)
	}
	id := page.Items[0].ID
	foreign := "n_foreign_" + uuid.NewString()
	if _, e = db.Exec(ctx, `INSERT INTO organization.notifications(id,owner_id,type,title,body,source_kind,source_ref) VALUES($1,$2,'OFFICIAL_MESSAGE','{"en":"owned announcement"}','{"en":"persisted"}','TEST',$1)`, foreign, b.OwnerID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Read(ctx, a, []string{id, foreign}, cmd(t, 0, "", nil)); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("mixed owner read", e)
	}
	counts, e := s.Unread(ctx, a)
	if e != nil || counts.Generations != 1 || counts.Total != 1 {
		t.Fatal("failed read was partial")
	}
	readKey := uuid.NewString()
	readCmd := cmd(t, 0, readKey, []string{id})
	counts, e = s.Read(ctx, a, []string{id}, readCmd)
	if e != nil || counts.Total != 0 {
		t.Fatal("persisted read", e)
	}
	replay, e := service(t, db).Read(ctx, a, []string{id}, readCmd)
	if e != nil || replay != counts {
		t.Fatal("read receipt", e)
	}
	n, e := s.Notification(ctx, a, id)
	if e != nil || !n.Read || n.Revision != 2 {
		t.Fatal("read revision", e)
	}
	if _, e = s.DeleteNotification(ctx, a, id, cmd(t, 1, "", nil)); !conflict(e) {
		t.Fatal("stale notification delete", e)
	}
	deleteCommand := cmd(t, n.Revision, "", nil)
	deleted, e := s.DeleteNotification(ctx, a, id, deleteCommand)
	if e != nil || deleted.Revision != 3 {
		t.Fatal("delete notification", e)
	}
	if _, e = service(t, db).DeleteNotification(ctx, a, id, deleteCommand); e != nil {
		t.Fatal("delete replay", e)
	}
	if _, e = s.Notification(ctx, a, id); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("deleted notification visible")
	}
	if _, e = s.DeleteNotifications(ctx, a, []string{foreign}, cmd(t, 0, "", nil)); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign delete")
	}
	batch, e := s.DeleteNotifications(ctx, b, []string{foreign}, cmd(t, 0, "", nil))
	if e != nil || len(batch.DeletedIDs) != 1 || batch.Counts.Total != 0 {
		t.Fatal("batch delete", e)
	}
	router := chi.NewRouter()
	if e = organizationHTTP.RegisterRoutes(router, s, func(cap string, next httpapi.Handler) http.HandlerFunc {
		if cap != "tv.access" {
			t.Fatal("capability")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: a.OwnerID}))
		})
	}); e != nil {
		t.Fatal(e)
	}
	req := httptest.NewRequest("GET", "/api/v1/notifications", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var envelope struct {
		Data domain.NotificationPage `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || envelope.Data.Total != 0 || envelope.Data.Items == nil {
		t.Fatal("real HTTP empty inbox", w.Body)
	}
	req = httptest.NewRequest("POST", "/api/v2/project-folders", strings.NewReader(`{"name":"HTTP persistent"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", uuid.NewString())
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 || w.Header().Get("ETag") == "" {
		t.Fatal("real HTTP folder create", w.Body)
	}
	var actual struct {
		Data domain.Folder `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &actual) != nil {
		t.Fatal("HTTP response")
	}
	if _, e = s.Folder(ctx, a, actual.Data.ID); e != nil {
		t.Fatal("HTTP folder not persisted", e)
	}
}
