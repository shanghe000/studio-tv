package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

func lifecycleOwners(t *testing.T, db *pgxpool.Pool, ctx context.Context) {
	t.Helper()
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('owner-a','lifecycle-a@example.test','Lifecycle A'),('owner-b','lifecycle-b@example.test','Lifecycle B');
	 INSERT INTO public.projects(id,owner_id,name) VALUES('project-a','owner-a','Canvas A'),('project-b','owner-b','Canvas B')`); err != nil {
		t.Fatal(err)
	}
}
func lifecycleGlobal(t *testing.T, router http.Handler, owner string) string {
	t.Helper()
	r := call(router, "POST", "/api/v2/conversations", owner, `{"kind":"GLOBAL","title":"Lifecycle history"}`, map[string]string{"Idempotency-Key": uuid.NewString()})
	assertStatus(t, r, 201)
	return object(r)["id"].(string)
}
func lifecycleAssistant(t *testing.T, db *pgxpool.Pool, ctx context.Context, conversation, id string, sequence int) {
	t.Helper()
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE assistant.conversations SET revision=revision+1,next_message_sequence=GREATEST(next_message_sequence,$2+1) WHERE id=$1 AND owner_id='owner-a'`, conversation, sequence); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES($1,$2,'owner-a',$3,'ASSISTANT','[{"type":"TEXT","text":"persisted response"}]')`, id, conversation, sequence); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
func lifecycleTask(t *testing.T, db *pgxpool.Pool, ctx context.Context, id, owner, conversation, state, message string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"task": map[string]any{"messageId": message, "plans": []any{}, "clientToolCalls": []any{}}})
	if _, err := db.Exec(ctx, `INSERT INTO execution.tasks(id,owner_id,conversation_id,kind,state,request_hash,idempotency_key,payload) VALUES($1,$2,$3,'ASSISTANT',$4,$5,$6,$7)`, id, owner, conversation, state, strings.Repeat("a", 64), uuid.NewString(), payload); err != nil {
		t.Fatal(err)
	}
}
func actualDeletedIDs(t *testing.T, r response, want ...string) {
	t.Helper()
	var got []string
	for _, v := range object(r)["deletedMessageIds"].([]any) {
		got = append(got, v.(string))
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("actual deletion scope differs: got %v want %v", got, want)
	}
}

func TestPostgresAssistantTurnDeletionReceiptsImmutableAndRestore(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	lifecycleOwners(t, db, ctx)
	router := integrationRouter(t, db)
	id := lifecycleGlobal(t, router, "owner-a")
	path := "/api/v2/conversations/" + id
	appendKey := uuid.NewString()
	u1 := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(appendKey, 1))
	assertStatus(t, u1, 201)
	first := object(u1)["id"].(string)
	lifecycleAssistant(t, db, ctx, id, "answer-1a", 2)
	lifecycleAssistant(t, db, ctx, id, "answer-1b", 3)
	u2 := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 4))
	assertStatus(t, u2, 201)
	second := object(u2)["id"].(string)
	lifecycleAssistant(t, db, ctx, id, "answer-2", 5)
	u3 := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 6))
	assertStatus(t, u3, 201)
	third := object(u3)["id"].(string)
	lifecycleAssistant(t, db, ctx, id, "answer-3", 7)
	if _, err := db.Exec(ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key) VALUES('audit-asset','owner-a','project-a','audit.png','IMAGE','image/png',10,$1,'READY','test/audit.png')`, strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO assistant.message_assets(message_id,conversation_id,owner_id,asset_id) VALUES($1,$2,'owner-a','audit-asset')`, first, id); err != nil {
		t.Fatal(err)
	}
	// USER single-message deletion removes its actual whole turn.
	deletedSecond := call(router, "DELETE", path+"/messages/"+second, "owner-a", "", appendHeaders(uuid.NewString(), 8))
	assertStatus(t, deletedSecond, 200)
	actualDeletedIDs(t, deletedSecond, second, "answer-2")
	key := uuid.NewString()
	var results [8]response
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			requestKey := key
			if i%2 == 1 {
				requestKey = strings.ToUpper(key)
			}
			results[i] = call(router, "DELETE", path+"/turns/"+first, "owner-a", "", appendHeaders(requestKey, 9))
		}(i)
	}
	wg.Wait()
	for _, result := range results {
		assertStatus(t, result, 200)
		actualDeletedIDs(t, result, first, "answer-1a", "answer-1b")
		if !reflect.DeepEqual(object(results[0]), object(result)) || result.headers.Get("ETag") != `"10"` {
			t.Fatal("concurrent receipt replay changed deletion timestamp, scope or revision")
		}
	}
	assertStatus(t, call(router, "DELETE", path+"/turns/"+first, "owner-a", "", appendHeaders(uuid.NewString(), 10)), 404)
	assertStatus(t, call(router, "DELETE", path+"/turns/"+third, "owner-a", "", appendHeaders(key, 9)), 409)
	assertStatus(t, call(router, "DELETE", path+"/turns/"+first, "owner-a", "", appendHeaders(key, 10)), 409)
	assertStatus(t, call(router, "DELETE", path+"/turns/"+third, "owner-b", "", appendHeaders(key, 10)), 404)
	assertStatus(t, call(router, "DELETE", path+"/turns/answer-3", "owner-a", "", appendHeaders(uuid.NewString(), 10)), 400)
	assertStatus(t, call(router, "DELETE", path+"/messages/answer-3", "owner-a", "", appendHeaders(uuid.NewString(), 9)), 412)
	single := call(router, "DELETE", path+"/messages/answer-3", "owner-a", "", appendHeaders(uuid.NewString(), 10))
	assertStatus(t, single, 200)
	actualDeletedIDs(t, single, "answer-3")
	later := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 11))
	assertStatus(t, later, 201)
	if object(later)["seq"] != float64(8) || later.headers.Get("ETag") != `"12"` {
		t.Fatal("soft deletion reused a historical sequence")
	}
	restored := integrationRouter(t, db)
	replay := call(restored, "DELETE", path+"/turns/"+first, "owner-a", "", appendHeaders(key, 9))
	assertStatus(t, replay, 200)
	if !reflect.DeepEqual(object(results[0]), object(replay)) || replay.headers.Get("ETag") != `"10"` {
		t.Fatal("restart or later messages altered immutable deletion receipt")
	}
	assertStatus(t, call(restored, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(appendKey, 1)), 404)
	history := call(restored, "GET", path+"/messages?size=1", "owner-a", "", nil)
	assertStatus(t, history, 200)
	if object(history)["total"] != float64(2) || object(history)["records"].([]any)[0].(map[string]any)["id"] != third || object(history)["hasNext"] != true {
		t.Fatal("deleted rows affected visible pagination/count")
	}
	var revision, next int64
	var count, deleted, assets, receipts int
	if err := db.QueryRow(ctx, `SELECT c.revision,c.next_message_sequence,
	 (SELECT count(*) FROM assistant.messages WHERE conversation_id=c.id),
	 (SELECT count(*) FROM assistant.messages WHERE conversation_id=c.id AND deleted_at IS NOT NULL),
	 (SELECT count(*) FROM assistant.message_assets WHERE conversation_id=c.id),
	 (SELECT count(*) FROM public.idempotency_keys WHERE owner_id=c.owner_id AND operation=$2 AND key=$3)
	 FROM assistant.conversations c WHERE c.id=$1`, id, application.AppendMessageOperation, appendKey).Scan(&revision, &next, &count, &deleted, &assets, &receipts); err != nil || revision != 12 || next != 9 || count != 8 || deleted != 6 || assets != 1 || receipts != 1 {
		t.Fatalf("deletion erased audit evidence or advanced aggregate incorrectly: %v %d/%d/%d/%d/%d/%d", err, revision, next, count, deleted, assets, receipts)
	}
	for _, sql := range []string{
		`UPDATE assistant.messages SET content='[{"type":"TEXT","text":"rewritten"}]' WHERE id=$1`,
		`UPDATE assistant.messages SET owner_id='owner-b' WHERE id=$1`,
		`UPDATE assistant.messages SET sequence=999 WHERE id=$1`,
		`UPDATE assistant.messages SET deleted_at=NULL WHERE id=$1`,
		`UPDATE assistant.messages SET deleted_at=deleted_at+interval '1 second' WHERE id=$1`,
	} {
		_, err := db.Exec(ctx, sql, first)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("SQL message immutability/deletion regression was not rejected: %v", err)
		}
	}
	// A physical deleted USER remains a turn boundary even if a retained later
	// response is still visible (e.g. imported audit history).
	boundary := lifecycleGlobal(t, router, "owner-a")
	if _, err := db.Exec(ctx, `UPDATE assistant.conversations SET revision=2,next_message_sequence=5 WHERE id=$1`, boundary); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content,deleted_at) VALUES
	 ('boundary-u1',$1,'owner-a',1,'USER','[]',NULL),('boundary-a1',$1,'owner-a',2,'ASSISTANT','[]',NULL),
	 ('boundary-u2',$1,'owner-a',3,'USER','[]',now()),('boundary-a2',$1,'owner-a',4,'ASSISTANT','[]',NULL)`, boundary); err != nil {
		t.Fatal(err)
	}
	bounded := call(router, "DELETE", "/api/v2/conversations/"+boundary+"/turns/boundary-u1", "owner-a", "", appendHeaders(uuid.NewString(), 2))
	assertStatus(t, bounded, 200)
	actualDeletedIDs(t, bounded, "boundary-u1", "boundary-a1")
	remaining := call(router, "GET", "/api/v2/conversations/"+boundary+"/messages", "owner-a", "", nil)
	assertStatus(t, remaining, 200)
	if object(remaining)["total"] != float64(1) || object(remaining)["records"].([]any)[0].(map[string]any)["id"] != "boundary-a2" {
		t.Fatal("deleted physical USER boundary merged later turn responses")
	}
}

func TestPostgresAssistantLifecycleActiveTaskToolsAndParentOwnership(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	lifecycleOwners(t, db, ctx)
	router := integrationRouter(t, db)
	id := lifecycleGlobal(t, router, "owner-a")
	path := "/api/v2/conversations/" + id
	old := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 1))
	assertStatus(t, old, 201)
	lifecycleAssistant(t, db, ctx, id, "prior-answer", 2)
	currentKey := uuid.NewString()
	current := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(currentKey, 3))
	assertStatus(t, current, 201)
	message := object(current)["id"].(string)
	lifecycleTask(t, db, ctx, "actual-active-task", "owner-a", id, "QUEUED", message)
	assertStatus(t, call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 4)), 409)
	assertStatus(t, call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(currentKey, 3)), 201)
	assertStatus(t, call(router, "DELETE", path+"/messages/"+message, "owner-a", "", appendHeaders(uuid.NewString(), 4)), 409)
	none := call(router, "GET", path+"/client-tools/pending", "owner-a", "", nil)
	assertStatus(t, none, 200)
	if !reflect.DeepEqual(object(none), map[string]any{"session_id": id, "status": "none", "call": nil, "resume_command": nil, "active_resume": nil, "host_events": []any{}, "terminal_recovered": false}) {
		t.Fatal("actual task without tools produced fake pending/resume events")
	}
	assertStatus(t, call(router, "GET", path+"/client-tools/pending", "owner-b", "", nil), 404)
	// Busy rejection is atomic, and an older unrelated turn is still removable.
	var revision, next int64
	var messages int
	if err := db.QueryRow(ctx, `SELECT revision,next_message_sequence,(SELECT count(*) FROM assistant.messages WHERE conversation_id=$1) FROM assistant.conversations WHERE id=$1`, id).Scan(&revision, &next, &messages); err != nil || revision != 4 || next != 4 || messages != 3 {
		t.Fatal("active task rejection changed aggregate rows")
	}
	removed := call(router, "DELETE", path+"/turns/"+object(old)["id"].(string), "owner-a", "", appendHeaders(uuid.NewString(), 4))
	assertStatus(t, removed, 200)
	actualDeletedIDs(t, removed, object(old)["id"].(string), "prior-answer")
	if _, err := db.Exec(ctx, `INSERT INTO execution.events(task_id,owner_id,sequence,type,data) VALUES('actual-active-task','owner-a',1,'TASK_UPDATED','{"state":"RUNNING","toolCalls":[]}')`); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, call(router, "GET", path+"/client-tools/pending", "owner-a", "", nil), 200)
	if _, err := db.Exec(ctx, `INSERT INTO execution.events(task_id,owner_id,sequence,type,data) VALUES('actual-active-task','owner-a',2,'CLIENT_TOOL_CALL','{"client_tool_call":{"id":"persisted-tool-call","name":"actual.host.tool"}}')`); err != nil {
		t.Fatal(err)
	}
	unsupported := call(router, "GET", path+"/client-tools/pending", "owner-a", "", nil)
	assertStatus(t, unsupported, 501)
	if unsupported.data["code"] != "CLIENT_TOOLS_UNAVAILABLE" {
		t.Fatal("actual tool evidence was hidden as no pending tools")
	}
	if _, err := db.Exec(ctx, `UPDATE execution.tasks SET state='CANCELED',revision=revision+1 WHERE id='actual-active-task'`); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 5)), 201)
	// A task with no usable message binding fails closed for every deletion.
	malformed := lifecycleGlobal(t, router, "owner-a")
	malformedPath := "/api/v2/conversations/" + malformed
	malformedMessage := call(router, "POST", malformedPath+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 1))
	assertStatus(t, malformedMessage, 201)
	lifecycleTask(t, db, ctx, "unbound-active-task", "owner-a", malformed, "RUNNING", "")
	assertStatus(t, call(router, "DELETE", malformedPath+"/turns/"+object(malformedMessage)["id"].(string), "owner-a", "", appendHeaders(uuid.NewString(), 2)), 409)
	if _, err := db.Exec(ctx, `UPDATE execution.tasks SET payload=jsonb_set(payload,'{task,plans}','[{"state":"WAITING_TOOL"}]') WHERE id='unbound-active-task'`); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, call(router, "GET", malformedPath+"/client-tools/pending", "owner-a", "", nil), 501)

	// Live Canvas and bound HF underlying parents are checked on every read/write,
	// including deletion receipt replay, instead of relying on historical JSON.
	if _, err := db.Exec(ctx, `INSERT INTO resources.studio_projects(id,owner_id,project_id,title) VALUES('hf-parent','owner-a','project-a','HF')`); err != nil {
		t.Fatal(err)
	}
	type parentReceipt struct{ path, message, key string }
	var parents []parentReceipt
	for _, input := range []string{`{"kind":"CANVAS","projectId":"project-a","title":"Canvas"}`, `{"kind":"HF","hfProjectId":"hf-parent","title":"HF"}`} {
		created := call(router, "POST", "/api/v2/conversations", "owner-a", input, map[string]string{"Idempotency-Key": uuid.NewString()})
		assertStatus(t, created, 201)
		parentPath := "/api/v2/conversations/" + object(created)["id"].(string)
		parentMessage := call(router, "POST", parentPath+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 1))
		assertStatus(t, parentMessage, 201)
		deletionKey := uuid.NewString()
		deleted := call(router, "DELETE", parentPath+"/messages/"+object(parentMessage)["id"].(string), "owner-a", "", appendHeaders(deletionKey, 2))
		assertStatus(t, deleted, 200)
		parents = append(parents, parentReceipt{parentPath, object(parentMessage)["id"].(string), deletionKey})
	}
	if _, err := db.Exec(ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='project-a'`); err != nil {
		t.Fatal(err)
	}
	for _, parent := range parents {
		assertStatus(t, call(router, "GET", parent.path+"/client-tools/pending", "owner-a", "", nil), 404)
		assertStatus(t, call(router, "GET", parent.path+"/messages", "owner-a", "", nil), 404)
		assertStatus(t, call(router, "DELETE", parent.path+"/messages/"+parent.message, "owner-a", "", appendHeaders(parent.key, 2)), 404)
	}
}

type failingLifecycleUOW struct {
	application.UnitOfWork
	stage string
}
type failingLifecycleRepository struct {
	application.Repositories
	application.LifecycleRepositories
	stage string
}

func (u failingLifecycleUOW) Within(ctx context.Context, fn func(application.Repositories) error) error {
	return u.UnitOfWork.Within(ctx, func(r application.Repositories) error {
		return fn(failingLifecycleRepository{r, r.(application.LifecycleRepositories), u.stage})
	})
}
func (r failingLifecycleRepository) DeleteMessages(ctx context.Context, root domain.Conversation, target string, turn bool, at time.Time) (domain.MessageDeletion, error) {
	result, err := r.LifecycleRepositories.DeleteMessages(ctx, root, target, turn, at)
	if err == nil && r.stage == "delete" {
		err = domain.ErrUnavailable
	}
	return result, err
}
func (r failingLifecycleRepository) SaveDeletionReceipt(ctx context.Context, owner, operation, key string, receipt application.MessageDeletionReceipt) error {
	if err := r.LifecycleRepositories.SaveDeletionReceipt(ctx, owner, operation, key, receipt); err != nil {
		return err
	}
	if r.stage == "receipt" {
		return domain.ErrUnavailable
	}
	return nil
}

func TestPostgresAssistantLifecycleRollbackAndBoundedDeletion(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	lifecycleOwners(t, db, ctx)
	router := integrationRouter(t, db)
	id := lifecycleGlobal(t, router, "owner-a")
	path := "/api/v2/conversations/" + id
	appended := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 1))
	assertStatus(t, appended, 201)
	message := object(appended)["id"].(string)
	lifecycleAssistant(t, db, ctx, id, "rollback-answer", 2)
	uow, err := postgres.New(db)
	if err != nil {
		t.Fatal(err)
	}
	key := uuid.NewString()
	command := application.MessageDeletionCommand{ExpectedRevision: 3, IdempotencyKey: key}
	for _, stage := range []string{"delete", "receipt"} {
		svc, err := application.New(failingLifecycleUOW{uow, stage})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = svc.DeleteMessage(ctx, domain.VerifiedActor{OwnerID: "owner-a"}, id, message, true, command); !errors.Is(err, domain.ErrUnavailable) {
			t.Fatal("real mutation/receipt fault did not roll back PostgreSQL")
		}
		var revision int64
		var active, receipts int
		if err = db.QueryRow(ctx, `SELECT revision,(SELECT count(*) FROM assistant.messages WHERE conversation_id=$1 AND deleted_at IS NULL),(SELECT count(*) FROM public.idempotency_keys WHERE owner_id='owner-a' AND operation=$2 AND key=$3) FROM assistant.conversations WHERE id=$1`, id, application.DeleteTurnOperation, key).Scan(&revision, &active, &receipts); err != nil || revision != 3 || active != 2 || receipts != 0 {
			t.Fatal("failed delete consumed revision, message or UUID receipt")
		}
	}
	assertStatus(t, call(router, "DELETE", path+"/turns/"+message, "owner-a", "", appendHeaders(key, 3)), 200)
	large := lifecycleGlobal(t, router, "owner-a")
	if _, err := db.Exec(ctx, `UPDATE assistant.conversations SET revision=2,next_message_sequence=$2+2 WHERE id=$1`, large, domain.MaxDeletionMessages); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) SELECT 'large-'||i::text,$1,'owner-a',i,CASE WHEN i=1 THEN 'USER' ELSE 'ASSISTANT' END,'[]'::jsonb FROM generate_series(1,$2+1) i`, large, domain.MaxDeletionMessages); err != nil {
		t.Fatal(err)
	}
	largePath := "/api/v2/conversations/" + large
	largeKey := uuid.NewString()
	rejected := call(router, "DELETE", largePath+"/turns/large-1", "owner-a", "", appendHeaders(largeKey, 2))
	assertStatus(t, rejected, 413)
	if rejected.data["code"] != "TURN_TOO_LARGE" {
		t.Fatal("oversized deletion did not expose actionable bounded failure")
	}
	// Individual ASSISTANT removal makes the exact1000-message turn fit; the
	// previously failed UUID is reusable because no receipt was committed.
	assertStatus(t, call(router, "DELETE", largePath+"/messages/"+fmt.Sprintf("large-%d", domain.MaxDeletionMessages+1), "owner-a", "", appendHeaders(uuid.NewString(), 2)), 200)
	fit := call(router, "DELETE", largePath+"/turns/large-1", "owner-a", "", appendHeaders(largeKey, 3))
	assertStatus(t, fit, 200)
	if len(object(fit)["deletedMessageIds"].([]any)) != domain.MaxDeletionMessages {
		t.Fatal("bounded deletion truncated or silently partially succeeded")
	}
}
