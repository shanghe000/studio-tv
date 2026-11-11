package postgres_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	commandHTTP "studiotv.local/service/api/internal/modules/canvasagent/adapters/http"
	"studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

func isolatedCommandDatabase(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not supplied; real canvas command PostgreSQL integration NOT RUN")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || !strings.Contains(strings.ToLower(cfg.ConnConfig.Database), "test") {
		t.Fatal("explicit test database URL required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("test database configuration failed")
	}
	t.Cleanup(admin.Close)
	name := "studio_canvas_command_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+identifier); err != nil {
		t.Fatal("test role needs CREATEDB")
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
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
		t.Fatal("isolated database connection failed")
	}
	t.Cleanup(db.Close)
	if database.Migrate(ctx, db) != nil {
		t.Fatal("canvas command migration failed")
	}
	return db, ctx
}

type commandResponse struct {
	status  int
	data    map[string]any
	headers http.Header
}

func callCommand(router http.Handler, method, path, owner, body string, headers map[string]string) commandResponse {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+owner)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	var data map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &data)
	return commandResponse{w.Code, data, w.Header()}
}
func commandHeaders(key string, revision int64) map[string]string {
	return map[string]string{"Idempotency-Key": key, "If-Match": fmt.Sprintf("\"%d\"", revision)}
}
func commandData(r commandResponse) map[string]any {
	value, _ := r.data["data"].(map[string]any)
	return value
}
func assertCommandStatus(t *testing.T, r commandResponse, status int) {
	t.Helper()
	if r.status != status || r.data == nil {
		t.Fatalf("expected command HTTP %d, got %d", status, r.status)
	}
}
func commandRouter(t *testing.T, uow application.CommandUnitOfWork) http.Handler {
	t.Helper()
	service, err := application.NewCommandService(uow, core.ValidateProductGraph)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(httpapi.Base(nil))
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		owner := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if owner != "owner-a" && owner != "owner-b" {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "test identity unavailable")
		}
		return httpapi.Identity{UserID: owner, SessionID: "test-session"}, nil
	})
	if commandHTTP.RegisterCommandRoutes(router, service, func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("live tv.access protection missing")
		}
		return httpapi.RequireAuth(auth, func(w http.ResponseWriter, r *http.Request) error {
			ctx := collaboration.WithCanvasLeaseRequest(collaboration.ContextWithCanvasProof(r), httpapi.IdentityFrom(r), r.Header.Get(collaboration.CanvasSessionHeader))
			return next(w, r.WithContext(ctx))
		})
	}) != nil {
		t.Fatal("command route registration failed")
	}
	return router
}

const initialCommandGraph = `{"schemaVersion":"1","nodes":[{"id":"rhtv_meta_v1","type":"__rhtv_meta","position":{"x":0,"y":0},"data":{"version":"1","keep":"native meta"}},{"id":"text","type":"rh-text","position":{"x":10,"y":20},"data":{"title":"stored","generatedText":"trusted output","taskId":"trusted-task","status":"SUCCESS","params":{"prompt":"old","seed":7},"__rhtv":{"native":{"style":{"color":"red"}}}}}],"edges":[],"viewport":{"x":9,"y":8,"zoom":1},"unknown":{"native":"preserve"}}`
const createImageCommand = `{"schemaVersion":"1","operations":[{"type":"node.create","node":{"id":"image","nodeType":"rh-image","inputSchemaVersion":"1","position":{"x":100,"y":200},"inputs":{"title":"fox","prompt":"fox portrait"}}},{"type":"node.updateInputs","nodeId":"text","inputSchemaVersion":"1","inputs":{"text":"user draft","prompt":"new prompt"}},{"type":"edge.create","edge":{"id":"edge","source":"text","target":"image","sourceHandle":null,"targetHandle":null}}]}`

func TestPostgresCanvasCommandOwnerCASReplayAndAtomicEvents(t *testing.T) {
	db, ctx := isolatedCommandDatabase(t)
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('owner-a','commands-a@example.test','Commands A'),('owner-b','commands-b@example.test','Commands B')`); err != nil {
		t.Fatal("command owner fixtures failed")
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,graph)VALUES('project_a','owner-a','A',$1),('project_b','owner-b','B',$1),('project_a2','owner-a','A2',$1)`, json.RawMessage(initialCommandGraph)); err != nil {
		t.Fatal("command fixtures failed")
	}
	uow := postgres.NewCommandUnitOfWork(db)
	router := commandRouter(t, uow)
	path := "/api/v2/projects/project_a/canvas-commands"
	key := uuid.NewString()
	var responses [8]commandResponse
	var wg sync.WaitGroup
	for i := range responses {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			k := key
			if index%2 == 1 {
				k = strings.ToUpper(k)
			}
			responses[index] = callCommand(router, "POST", path, "owner-a", createImageCommand, commandHeaders(k, 1))
		}(i)
	}
	wg.Wait()
	first := commandData(responses[0])
	for _, response := range responses {
		assertCommandStatus(t, response, 200)
		if !reflect.DeepEqual(first, commandData(response)) || response.headers.Get("ETag") != "\"2\"" {
			t.Fatal("concurrent exact replay changed its receipt")
		}
	}
	if first["graphRevision"] != float64(2) || first["eventCursor"] != "1" || first["state"] != "COMMITTED" {
		t.Fatal("command receipt has false graph/event revision")
	}
	assertState := func(revision, sequence int64, count int) {
		t.Helper()
		var actualRevision, actualSequence int64
		var receipts, events int
		err := db.QueryRow(ctx, `SELECT revision,event_sequence,(SELECT count(*) FROM canvas.command_receipts WHERE project_id=p.id),(SELECT count(*) FROM canvas.project_events WHERE project_id=p.id) FROM public.projects p WHERE id='project_a'`).Scan(&actualRevision, &actualSequence, &receipts, &events)
		if err != nil || actualRevision != revision || actualSequence != sequence || receipts != count || events != count {
			t.Fatal("graph, receipt and event transaction state differs")
		}
	}
	assertState(2, 1, 1)
	var savedGraph json.RawMessage
	var event json.RawMessage
	if db.QueryRow(ctx, `SELECT graph FROM public.projects WHERE id='project_a'`).Scan(&savedGraph) != nil || db.QueryRow(ctx, `SELECT payload FROM canvas.project_events WHERE project_id='project_a' AND sequence=1`).Scan(&event) != nil {
		t.Fatal("persisted graph/event read failed")
	}
	var graph map[string]any
	_ = json.Unmarshal(savedGraph, &graph)
	nodes := graph["nodes"].([]any)
	data := nodes[1].(map[string]any)["data"].(map[string]any)
	if data["generatedText"] != "trusted output" || data["taskId"] != "trusted-task" || data["status"] != "SUCCESS" || data["__rhtv"] == nil || graph["unknown"] == nil || nodes[0].(map[string]any)["data"].(map[string]any)["keep"] != "native meta" {
		t.Fatal("command overwrote native or server fields")
	}
	var recordedEvent map[string]any
	_ = json.Unmarshal(event, &recordedEvent)
	if recordedEvent["sequence"] != "1" || recordedEvent["type"] != "canvas.changed" || recordedEvent["source"].(map[string]any)["kind"] != "API" || !reflect.DeepEqual(recordedEvent["data"].(map[string]any)["delta"], first["delta"]) {
		t.Fatal("event is not the committed normalized delta")
	}
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-b", createImageCommand, commandHeaders(uuid.NewString(), 1)), 404)
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", createImageCommand, commandHeaders(key, 2)), 409)
	move := `{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"image","position":{"x":300,"y":400}}]}`
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", move, commandHeaders(key, 1)), 409)
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", move, commandHeaders(uuid.NewString(), 1)), 412)
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", move, commandHeaders(uuid.NewString(), 2)), 200)
	assertState(3, 2, 2)
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", createImageCommand, commandHeaders(key, 1)), 200)
	if commandData(callCommand(router, "GET", path+"/"+first["commandId"].(string), "owner-a", "", nil))["graphRevision"] != float64(2) {
		t.Fatal("receipt retrieval returned current head instead of historical revision")
	}
	assertCommandStatus(t, callCommand(router, "GET", path+"/"+first["commandId"].(string), "owner-b", "", nil), 404)
	assertCommandStatus(t, callCommand(router, "POST", "/api/v2/projects/project_a2/canvas-commands", "owner-a", createImageCommand, commandHeaders(key, 1)), 200)
	for _, body := range []string{
		`{"schemaVersion":"1","operations":[{"type":"node.updateInputs","nodeId":"text","inputSchemaVersion":"1","inputs":{"status":"fake"}}]}`,
		`{"schemaVersion":"1","operations":[{"type":"node.create","node":{"id":"fake","nodeType":"rh-text","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{"__rhtv":{"native":{}}}}}]}`,
	} {
		assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", body, commandHeaders(uuid.NewString(), 3)), 400)
	}
	agent := `{"schemaVersion":"1","agentContext":{"runId":"forged","toolCallId":"forged"},"operations":[{"type":"node.move","nodeId":"image","position":{"x":1,"y":2}}]}`
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", agent, commandHeaders(uuid.NewString(), 3)), 501)
	assertState(3, 2, 2)
	// Force failure after project/receipt/event SQL writes. The outer UoW must
	// roll back every record, rather than merely returning an error to HTTP.
	failing := commandRouter(t, failingCommandUOW{uow})
	rollbackMove := `{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"image","position":{"x":500,"y":600}}]}`
	assertCommandStatus(t, callCommand(failing, "POST", path, "owner-a", rollbackMove, commandHeaders(uuid.NewString(), 3)), 503)
	assertState(3, 2, 2)
	deleted := `{"schemaVersion":"1","operations":[{"type":"node.delete","nodeId":"image"}]}`
	result := callCommand(router, "POST", path, "owner-a", deleted, commandHeaders(uuid.NewString(), 3))
	assertCommandStatus(t, result, 200)
	delta := commandData(result)["delta"].(map[string]any)
	if len(delta["edgesRemoved"].([]any)) != 1 || delta["edgesRemoved"].([]any)[0] != "edge" {
		t.Fatal("deleted node edge was not removed in receipt/event")
	}
	assertState(4, 3, 3)
	if _, err := db.Exec(ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='project_a'`); err != nil {
		t.Fatal("project deletion fixture failed")
	}
	assertCommandStatus(t, callCommand(router, "GET", path+"/"+first["commandId"].(string), "owner-a", "", nil), 404)
	assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", createImageCommand, commandHeaders(key, 1)), 404)
}

type failingCommandUOW struct{ application.CommandUnitOfWork }

func (u failingCommandUOW) WithinCommands(ctx context.Context, fn func(application.CommandRepositories) error) error {
	return u.CommandUnitOfWork.WithinCommands(ctx, func(repositories application.CommandRepositories) error {
		return fn(failingCommandRepositories{repositories})
	})
}

type failingCommandRepositories struct {
	application.CommandRepositories
}

func (r failingCommandRepositories) CommitCanvasCommand(ctx context.Context, owner, project string, current application.CommandSnapshot, graph json.RawMessage, key, hash string, receipt domain.CommandReceipt) error {
	if err := r.CommandRepositories.CommitCanvasCommand(ctx, owner, project, current, graph, key, hash, receipt); err != nil {
		return err
	}
	return domain.ErrCommandUnavailable
}

func TestPostgresCanvasCommandAssetAuthorizationAndStrictTransport(t *testing.T) {
	db, ctx := isolatedCommandDatabase(t)
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('owner-a','assets-a@example.test','A'),('owner-b','assets-b@example.test','B')`); err != nil {
		t.Fatal("asset command owner fixtures failed")
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,graph)VALUES('project_a','owner-a','A',$1),('project_b','owner-b','B',$1)`, json.RawMessage(initialCommandGraph)); err != nil {
		t.Fatal("asset command project fixtures failed")
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state)VALUES('asset_b','owner-b','project_b','b.png','IMAGE','image/png',4,'sha','READY'),('asset_pending','owner-a','project_a','pending.png','IMAGE','image/png',4,'sha','UPLOADING'),('asset_ready','owner-a','project_a','ready.png','IMAGE','image/png',4,'sha','READY')`); err != nil {
		t.Fatal("asset command fixtures failed")
	}
	router := commandRouter(t, postgres.NewCommandUnitOfWork(db))
	path := "/api/v2/projects/project_a/canvas-commands"
	move := `{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":30,"y":40}}]}`
	for _, asset := range []string{"asset_b", "asset_pending", "asset_ready"} {
		var graph map[string]any
		_ = json.Unmarshal([]byte(initialCommandGraph), &graph)
		graph["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["assetId"] = asset
		raw, _ := json.Marshal(graph)
		var currentRevision int64
		if err := db.QueryRow(ctx, `UPDATE public.projects SET graph=$1 WHERE id='project_a' RETURNING revision`, raw).Scan(&currentRevision); err != nil {
			t.Fatal("asset graph fixture failed")
		}
		status := 422
		if asset == "asset_ready" {
			status = 200
		}
		assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", move, commandHeaders(uuid.NewString(), currentRevision)), status)
	}
	for _, test := range []struct {
		headers map[string]string
		status  int
	}{
		{map[string]string{"Idempotency-Key": uuid.NewString()}, 428},
		{map[string]string{"Idempotency-Key": uuid.NewString(), "If-Match": "W/\"2\""}, 400},
		{map[string]string{"Idempotency-Key": "invalid", "If-Match": "\"2\""}, 400},
	} {
		assertCommandStatus(t, callCommand(router, "POST", path, "owner-a", move, test.headers), test.status)
	}
	var revision, sequence int64
	var receipts int
	if db.QueryRow(ctx, `SELECT revision,event_sequence,(SELECT count(*) FROM canvas.command_receipts WHERE project_id=p.id) FROM public.projects p WHERE id='project_a'`).Scan(&revision, &sequence, &receipts) != nil || revision != 5 || sequence != 4 || receipts != 1 {
		t.Fatal("rejected asset or transport request changed persistence")
	}
}

func TestPostgresCanvasCommandReceiptMatchesExecutionNormalization(t *testing.T) {
	db, ctx, _ := liveDatabase(t)
	if _, err := db.Exec(ctx, `INSERT INTO execution.tasks(id,owner_id,project_id,kind,state,request_hash,idempotency_key,payload) VALUES('bound-task','owner-a','project_a','CANVAS','RUNNING',$1,$2,'{}'::jsonb)`, strings.Repeat("a", 64), uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO canvas.node_execution_bindings(project_id,owner_id,node_id,task_id,execution_id,node_version,input_versions,input_guard,state,application_state) SELECT project_id,owner_id,node_id,'bound-task','bound-execution',version,'{}'::jsonb,$1,'RUNNING','PENDING' FROM canvas.node_versions WHERE project_id='project_a' AND node_id='text'`, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	router := commandRouter(t, postgres.NewCommandUnitOfWork(db))
	key := uuid.NewString()
	path := "/api/v2/projects/project_a/canvas-commands"
	body := `{"schemaVersion":"1","operations":[{"type":"node.updateInputs","nodeId":"text","inputSchemaVersion":"1","inputs":{"prompt":"changed while generating"}}]}`
	response := callCommand(router, "POST", path, "owner-a", body, commandHeaders(key, 1))
	assertCommandStatus(t, response, 200)
	receipt := commandData(response)
	var saved, event json.RawMessage
	if err := db.QueryRow(ctx, `SELECT graph FROM public.projects WHERE id='project_a'`).Scan(&saved); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT payload FROM canvas.project_events WHERE project_id='project_a' AND sequence=1`).Scan(&event); err != nil {
		t.Fatal(err)
	}
	var graph, entry map[string]any
	_ = json.Unmarshal(saved, &graph)
	_ = json.Unmarshal(event, &entry)
	node := graph["nodes"].([]any)[1].(map[string]any)
	data := node["data"].(map[string]any)
	if data["status"] != "idle" || data["taskId"] != nil {
		t.Fatal("edited node retained old task", data)
	}
	delta := receipt["delta"].(map[string]any)
	upserts := delta["nodesUpsert"].([]any)
	if len(upserts) != 1 || !reflect.DeepEqual(upserts[0], node) || !reflect.DeepEqual(entry["data"].(map[string]any)["delta"], delta) {
		t.Fatal("receipt or event differs from normalized stored graph")
	}
	replay := callCommand(router, "POST", path, "owner-a", body, commandHeaders(key, 1))
	assertCommandStatus(t, replay, 200)
	if !reflect.DeepEqual(commandData(replay), receipt) {
		t.Fatal("replay did not match actual initial receipt")
	}
}
