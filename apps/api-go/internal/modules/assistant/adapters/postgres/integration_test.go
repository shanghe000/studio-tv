package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	assistantHTTP "studiotv.local/service/api/internal/modules/assistant/adapters/http"
	"studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	"studiotv.local/service/api/internal/modules/assistant/application"
)

// Requires an explicitly supplied TEST_DATABASE_URL naming a test database and
// a disposable test role with CREATEDB. Every run creates/drops its own database;
// no production URL/default DATABASE_URL or existing user table is accessed.
func isolatedDatabase(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not supplied; real PostgreSQL integration NOT RUN")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || !strings.Contains(strings.ToLower(cfg.ConnConfig.Database), "test") {
		t.Fatal("TEST_DATABASE_URL must explicitly name a test database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("test PostgreSQL connection configuration failed")
	}
	t.Cleanup(admin.Close)
	name := "studio_assistant_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+identifier); err != nil {
		t.Fatal("cannot create isolated test database; TEST_DATABASE_URL role needs CREATEDB")
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+identifier+" WITH (FORCE)"); err != nil {
			t.Error("isolated test database cleanup failed")
		}
	})
	testCfg := cfg.Copy()
	testCfg.ConnConfig.Database = name
	testCfg.ConnConfig.RuntimeParams["search_path"] = "public"
	testCfg.MaxConns = 12
	db, err := pgxpool.NewWithConfig(ctx, testCfg)
	if err != nil {
		t.Fatal("isolated PostgreSQL connection failed")
	}
	t.Cleanup(db.Close)
	if err = database.Migrate(ctx, db); err != nil {
		t.Fatal("001..004 migration failed in isolated database")
	}
	return db, ctx
}

type response struct {
	status      int
	data        map[string]any
	headers     http.Header
	decodeError bool
}

func call(router http.Handler, method, path, user, body string, headers map[string]string) response {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+user)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	var data map[string]any
	err := json.NewDecoder(w.Body).Decode(&data)
	return response{w.Code, data, w.Header(), err != nil}
}
func assertStatus(t *testing.T, r response, status int) {
	t.Helper()
	if r.status != status || r.decodeError {
		t.Fatalf("expected HTTP %d, got %d (JSON decode failed=%t)", status, r.status, r.decodeError)
	}
}
func object(r response) map[string]any { return r.data["data"].(map[string]any) }

func integrationRouter(t *testing.T, db *pgxpool.Pool) http.Handler {
	t.Helper()
	uow, err := postgres.New(db)
	if err != nil {
		t.Fatal(err)
	}
	service, err := application.New(uow)
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Use(httpapi.Base(nil))
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		switch r.Header.Get("Authorization") {
		case "Bearer owner-a":
			return httpapi.Identity{UserID: "owner-a", SessionID: uuid.NewString()}, nil
		case "Bearer owner-b":
			return httpapi.Identity{UserID: "owner-b", SessionID: uuid.NewString()}, nil
		}
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "test actor unavailable")
	})
	if err = assistantHTTP.RegisterRoutes(r, service, func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("missing authorization capability")
		}
		return httpapi.RequireAuth(auth, next)
	}); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestPostgresGlobalHistoryRestoreWithoutProjectDependency(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	// There are deliberately no projects when homepage roots are created.
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('owner-a','global-a@example.test','Global A'),('owner-b','global-b@example.test','Global B')`); err != nil {
		t.Fatal("global fixture insertion failed")
	}
	router := integrationRouter(t, db)
	body := `{"kind":"GLOBAL","title":"首页持久历史"}`
	key := uuid.NewString()
	var results [8]response
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			results[index] = call(router, "POST", "/api/v2/conversations", "owner-a", body, map[string]string{"Idempotency-Key": key})
		}(i)
	}
	wg.Wait()
	for _, result := range results {
		assertStatus(t, result, 201)
	}
	id := object(results[0])["id"].(string)
	for _, result := range results {
		data := object(result)
		if data["id"] != id || data["kind"] != "GLOBAL" || data["projectId"] != nil || data["hfProjectId"] != nil {
			t.Fatal("global concurrent identity/binding mismatch")
		}
	}
	var projects, roots int
	if err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM public.projects),(SELECT count(*) FROM assistant.conversations WHERE owner_id='owner-a')`).Scan(&projects, &roots); err != nil || projects != 0 || roots != 1 {
		t.Fatal("global creation required a project or duplicated root")
	}
	other := call(router, "POST", "/api/v2/conversations", "owner-b", body, map[string]string{"Idempotency-Key": key})
	assertStatus(t, other, 201)
	if object(other)["id"] == id {
		t.Fatal("global root shared across owners")
	}
	assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-a", `{"kind":"GLOBAL","title":"changed"}`, map[string]string{"Idempotency-Key": key}), 409)
	assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-a", `{"kind":"GLOBAL","projectId":null,"hfProjectId":null,"title":"首页持久历史"}`, map[string]string{"Idempotency-Key": key}), 409)
	assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-a", `{"kind":"GLOBAL","projectId":"missing","title":"x"}`, map[string]string{"Idempotency-Key": uuid.NewString()}), 400)
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal("global history transaction failed")
	}
	if _, err = tx.Exec(ctx, `UPDATE assistant.conversations SET next_message_sequence=3,revision=2 WHERE id=$1`, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal("global sequence allocation failed")
	}
	if _, err = tx.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES
	 ('global-message-1',$1,'owner-a',1,'USER','[{"type":"TEXT","text":"首页问题"}]'),
	 ('global-message-2',$1,'owner-a',2,'ASSISTANT','[{"type":"TEXT","text":"持久回答"}]')`, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal("global history seed failed")
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal("global history commit failed")
	}
	// A new UoW, application, HTTP router and per-request local login session
	// retain the stable owner-scoped history. No login session is a binding key.
	restored := integrationRouter(t, db)
	assertStatus(t, call(restored, "POST", "/api/v2/conversations", "owner-a", body, map[string]string{"Idempotency-Key": key}), 201)
	history := call(restored, "GET", "/api/v2/conversations/"+id+"/messages?size=1", "owner-a", "", nil)
	assertStatus(t, history, 200)
	if object(history)["total"] != float64(2) || object(history)["hasNext"] != true || object(history)["records"].([]any)[0].(map[string]any)["seq"] != float64(1) {
		t.Fatal("restored global history differs")
	}
	assertStatus(t, call(restored, "GET", "/api/v2/conversations/"+id+"/messages", "owner-b", "", nil), 404)
	assertStatus(t, call(restored, "DELETE", "/api/v2/conversations/"+id, "owner-b", "", map[string]string{"If-Match": `"2"`}), 404)
	if _, err = db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name) VALUES('canvas-global-test','owner-a','Canvas')`); err != nil {
		t.Fatal("Canvas test root insertion failed")
	}
	canvas := call(restored, "POST", "/api/v2/conversations", "owner-a", `{"kind":"CANVAS","projectId":"canvas-global-test","title":"Canvas"}`, map[string]string{"Idempotency-Key": uuid.NewString()})
	assertStatus(t, canvas, 201)
	canvasID := object(canvas)["id"].(string)
	for kind, total := range map[string]float64{"": 2, "GLOBAL": 1, "CANVAS": 1} {
		path := "/api/v2/conversations"
		if kind != "" {
			path += "?kind=" + kind
		}
		listed := call(restored, "GET", path, "owner-a", "", nil)
		assertStatus(t, listed, 200)
		if object(listed)["total"] != total {
			t.Fatalf("kind %q returned wrong total", kind)
		}
	}
	if _, err = db.Exec(ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='canvas-global-test'`); err != nil {
		t.Fatal("Canvas test soft-delete failed")
	}
	assertStatus(t, call(restored, "GET", "/api/v2/conversations/"+canvasID+"/messages", "owner-a", "", nil), 404)
	assertStatus(t, call(restored, "GET", "/api/v2/conversations/"+id+"/messages", "owner-a", "", nil), 200)
	assertStatus(t, call(restored, "POST", "/api/v2/conversations", "owner-a", body, map[string]string{"Idempotency-Key": key}), 201)
	listed := call(restored, "GET", "/api/v2/conversations", "owner-a", "", nil)
	assertStatus(t, listed, 200)
	if object(listed)["total"] != float64(1) {
		t.Fatal("project deletion affected homepage history")
	}
	assertStatus(t, call(restored, "GET", "/api/v2/conversations?kind=HF", "owner-a", "", nil), 200)
	assertStatus(t, call(restored, "POST", "/api/v2/conversations/"+id+"/runs", "owner-a", `{}`, nil), 501)
	expectState := func(query, state string, args ...any) {
		t.Helper()
		_, e := db.Exec(ctx, query, args...)
		var pgerr *pgconn.PgError
		if !errors.As(e, &pgerr) || pgerr.Code != state {
			t.Fatalf("expected global constraint SQLSTATE %s", state)
		}
	}
	expectState(`INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id) VALUES('invalid-global-binding','owner-a','GLOBAL','canvas-global-test')`, "23514")
	expectState(`INSERT INTO assistant.conversations(id,owner_id,business) VALUES('invalid-canvas-binding','owner-a','CANVAS')`, "23514")
	expectState(`INSERT INTO assistant.conversations(id,owner_id,business) VALUES('invalid-hf','owner-a','INVALID')`, "23514")
	expectState(`INSERT INTO assistant.conversations(id,owner_id,business) VALUES('invalid-global-owner','missing-owner','GLOBAL')`, "23503")
	expectState(`UPDATE assistant.conversations SET business='CANVAS',canvas_project_id='canvas-global-test' WHERE id=$1`, "23514", id)
	expectState(`INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES('global-cross-owner',$1,'owner-b',3,'USER','[]')`, "23503", id)
	expectState(`INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES('global-duplicate-sequence',$1,'owner-a',1,'USER','[]')`, "23505", id)
	if _, err = db.Exec(ctx, `UPDATE assistant.conversations SET router_key='test-router',router_session_ref='global-session' WHERE id=$1`, id); err != nil {
		t.Fatal("global paired Router binding failed")
	}
	expectState(`UPDATE assistant.conversations SET router_key='test-router',router_session_ref='global-session' WHERE id=$1`, "23505", object(other)["id"])
	deleted := call(restored, "DELETE", "/api/v2/conversations/"+id, "owner-a", "", map[string]string{"If-Match": `"2"`})
	assertStatus(t, deleted, 200)
	if deleted.headers.Get("ETag") != `"3"` {
		t.Fatal("global deletion revision mismatch")
	}
	assertStatus(t, call(restored, "GET", "/api/v2/conversations/"+id+"/messages", "owner-a", "", nil), 404)
	assertStatus(t, call(restored, "POST", "/api/v2/conversations", "owner-a", body, map[string]string{"Idempotency-Key": key}), 404)
	var retained int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM assistant.messages WHERE conversation_id=$1`, id).Scan(&retained); err != nil || retained != 2 {
		t.Fatal("global soft delete erased history")
	}
}

func TestPostgresAssistantPersistenceIsolationAndConstraints(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('owner-a','assistant-a@example.test','Test A'),('owner-b','assistant-b@example.test','Test B');
	 INSERT INTO public.projects(id,owner_id,name) VALUES('project-a','owner-a','Test A'),('project-b','owner-b','Test B')`); err != nil {
		t.Fatal("test fixture insertion failed")
	}
	router := integrationRouter(t, db)
	body := `{"kind":"CANVAS","projectId":"project-a","title":"Persistence <fox> & 狐"}`
	key := uuid.NewString()
	var concurrent [8]response
	var wg sync.WaitGroup
	for i := range concurrent {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			k := key
			if index%2 == 1 {
				k = strings.ToUpper(k)
			}
			concurrent[index] = call(router, "POST", "/api/v2/conversations", "owner-a", body, map[string]string{"Idempotency-Key": k})
		}(i)
	}
	wg.Wait()
	for _, result := range concurrent {
		assertStatus(t, result, 201)
	}
	id := object(concurrent[0])["id"].(string)
	for _, result := range concurrent {
		if object(result)["id"] != id {
			t.Fatal("concurrent same UUID created duplicate roots")
		}
	}
	var roots, keys int
	if err := db.QueryRow(ctx, "SELECT count(*) FROM assistant.conversations").Scan(&roots); err != nil || roots != 1 {
		t.Fatal("concurrent root count mismatch")
	}
	if err := db.QueryRow(ctx, "SELECT count(*) FROM public.idempotency_keys WHERE operation=$1", application.CreateOperation).Scan(&keys); err != nil || keys != 1 {
		t.Fatal("concurrent receipt count mismatch")
	}
	assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-a", `{"kind":"CANVAS","projectId":"project-a","title":"different"}`, map[string]string{"Idempotency-Key": key}), 409)
	assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-b", body, map[string]string{"Idempotency-Key": uuid.NewString()}), 404)
	assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-b", `{"kind":"CANVAS","projectId":"project-b","title":"Owner B"}`, map[string]string{"Idempotency-Key": key}), 201)
	// New application/runtime instances read the same persisted root/receipt.
	restarted := integrationRouter(t, db)
	assertStatus(t, call(restarted, "POST", "/api/v2/conversations", "owner-a", body, map[string]string{"Idempotency-Key": key}), 201)
	listed := call(restarted, "GET", "/api/v2/conversations?projectId=project-a&size=1&keyword=%20fox%20", "owner-a", "", nil)
	assertStatus(t, listed, 200)
	if object(listed)["total"] != float64(1) || len(object(listed)["records"].([]any)) != 1 {
		t.Fatal("persisted page/keyword projection mismatch")
	}
	empty := call(restarted, "GET", "/api/v2/conversations?page=100000&size=100", "owner-a", "", nil)
	assertStatus(t, empty, 200)
	if object(empty)["total"] != float64(1) || len(object(empty)["records"].([]any)) != 0 {
		t.Fatal("empty page lost total")
	}
	assertStatus(t, call(restarted, "GET", "/api/v2/conversations?projectId=project-a", "owner-b", "", nil), 404)
	assertStatus(t, call(restarted, "GET", "/api/v2/conversations/"+id+"/messages", "owner-b", "", nil), 404)

	// Seed historical multipart/assistant read fixtures through a transaction.
	// Live HTTP USER TEXT appends are covered separately and never start a run.
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal("message seed transaction failed")
	}
	if _, err = tx.Exec(ctx, `UPDATE assistant.conversations SET next_message_sequence=3,revision=2 WHERE id=$1`, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal("message sequence allocation failed")
	}
	if _, err = tx.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES
	 ('message-1',$1,'owner-a',1,'USER','[{"type":"TEXT","text":"100% literal"},{"type":"STRUCTURED","schemaCode":"test.v1","value":{"n":9007199254740993}}]'),
	 ('message-2',$1,'owner-a',2,'ASSISTANT','[{"type":"TEXT","text":"second fox"}]')`, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal("message insertion failed")
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal("message seed commit failed")
	}
	messages := call(restarted, "GET", "/api/v2/conversations/"+id+"/messages?size=1", "owner-a", "", nil)
	assertStatus(t, messages, 200)
	if object(messages)["total"] != float64(2) || object(messages)["hasNext"] != true || object(messages)["records"].([]any)[0].(map[string]any)["seq"] != float64(1) {
		t.Fatal("message sequence pagination mismatch")
	}
	literal := call(restarted, "GET", "/api/v2/conversations/"+id+"/messages?keyword=%25", "owner-a", "", nil)
	assertStatus(t, literal, 200)
	if object(literal)["total"] != float64(1) {
		t.Fatal("keyword wildcard was not escaped")
	}
	noResults := call(restarted, "GET", "/api/v2/conversations/"+id+"/messages?keyword=absent", "owner-a", "", nil)
	assertStatus(t, noResults, 200)
	if object(noResults)["total"] != float64(0) || len(object(noResults)["records"].([]any)) != 0 {
		t.Fatal("empty message page mismatch")
	}
	assertStatus(t, call(restarted, "POST", "/api/v2/conversations/"+id+"/runs", "owner-a", `{}`, nil), 501)

	expectSQLState := func(query, state string, args ...any) {
		t.Helper()
		_, err := db.Exec(ctx, query, args...)
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != state {
			t.Fatalf("expected storage constraint SQLSTATE %s", state)
		}
	}
	expectSQLState(`INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id) VALUES('invalid-project','owner-b','CANVAS','missing-project')`, "23503")
	expectSQLState(`INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES('cross-message',$1,'owner-b',3,'USER','[]')`, "23503", id)
	expectSQLState(`INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES('duplicate-seq',$1,'owner-a',1,'USER','[]')`, "23505", id)
	for _, bad := range []string{`{}`, `null`, `[{"type":"TEXT","text":null}]`, `[{"type":"TEXT","text":"x","extra":1}]`, `[{"type":"TASK_RESULT","taskId":"fake"}]`} {
		expectSQLState(`INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES('invalid-parts',$1,'owner-a',3,'USER',$2)`, "23514", id, bad)
	}
	expectSQLState(`UPDATE assistant.conversations SET owner_id='owner-b' WHERE id=$1`, "23514", id)
	expectSQLState(`UPDATE assistant.conversations SET next_message_sequence=1 WHERE id=$1`, "23514", id)
	expectSQLState(`UPDATE assistant.conversations SET router_key='test-router' WHERE id=$1`, "23514", id)
	if _, err = db.Exec(ctx, `UPDATE assistant.conversations SET router_key='test-router',router_session_ref='test-session' WHERE id=$1`, id); err != nil {
		t.Fatal("paired Router references rejected")
	}
	expectSQLState(`INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id,router_key,router_session_ref) VALUES('duplicate-router','owner-b','CANVAS','project-b','test-router','test-session')`, "23505")
	expectSQLState(`INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id,hf_project_id) VALUES('fake-hf','owner-a','CANVAS','project-a','hf-fake')`, "23514")
	assertStatus(t, call(restarted, "DELETE", "/api/v2/conversations/"+id, "owner-b", "", map[string]string{"If-Match": `"2"`}), 404)
	assertStatus(t, call(restarted, "DELETE", "/api/v2/conversations/"+id, "owner-a", "", map[string]string{"If-Match": `"1"`}), 412)
	deleted := call(restarted, "DELETE", "/api/v2/conversations/"+id, "owner-a", "", map[string]string{"If-Match": `"2"`})
	assertStatus(t, deleted, 200)
	if deleted.headers.Get("ETag") != `"3"` {
		t.Fatal("delete revision mismatch")
	}
	assertStatus(t, call(restarted, "GET", "/api/v2/conversations/"+id+"/messages", "owner-a", "", nil), 404)
	assertStatus(t, call(restarted, "POST", "/api/v2/conversations", "owner-a", body, map[string]string{"Idempotency-Key": key}), 404)
	expectSQLState(`UPDATE assistant.conversations SET deleted_at=NULL WHERE id=$1`, "23514", id)
	var history int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM assistant.messages WHERE conversation_id=$1", id).Scan(&history); err != nil || history != 2 {
		t.Fatal("soft delete physically removed messages")
	}
	// Project deletion hides an existing otherwise-active conversation and
	// blocks replays, without turning an HF ID into a Canvas root.
	newBody := `{"kind":"CANVAS","projectId":"project-a","title":"Project deletion"}`
	newKey := uuid.NewString()
	created := call(restarted, "POST", "/api/v2/conversations", "owner-a", newBody, map[string]string{"Idempotency-Key": newKey})
	assertStatus(t, created, 201)
	newID := object(created)["id"].(string)
	if _, err = db.Exec(ctx, "UPDATE public.projects SET deleted_at=now() WHERE id='project-a'"); err != nil {
		t.Fatal("test project soft delete failed")
	}
	assertStatus(t, call(restarted, "GET", "/api/v2/conversations/"+newID+"/messages", "owner-a", "", nil), 404)
	assertStatus(t, call(restarted, "POST", "/api/v2/conversations", "owner-a", newBody, map[string]string{"Idempotency-Key": newKey}), 404)
	final := call(restarted, "GET", "/api/v2/conversations", "owner-a", "", nil)
	assertStatus(t, final, 200)
	if object(final)["total"] != float64(0) {
		t.Fatal("project-deleted history leaked in owner list")
	}
}
