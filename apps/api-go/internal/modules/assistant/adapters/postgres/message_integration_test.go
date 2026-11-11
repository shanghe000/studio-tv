package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

const persistedUserText = `{"content":[{"type":"TEXT","text":"持久 <fox> & user question"}]}`

func appendHeaders(key string, revision int) map[string]string {
	return map[string]string{"Idempotency-Key": key, "If-Match": fmt.Sprintf(`"%d"`, revision)}
}

// A real transaction is forced to fail after SQL mutations, without adding DDL
// or relying on a mock to claim PostgreSQL atomicity.
type failingMessageUOW struct {
	application.UnitOfWork
	stage string
}
type failingMessageRepositories struct {
	application.Repositories
	stage string
}

func (u failingMessageUOW) Within(ctx context.Context, fn func(application.Repositories) error) error {
	return u.UnitOfWork.Within(ctx, func(tx application.Repositories) error {
		return fn(failingMessageRepositories{tx, u.stage})
	})
}
func (r failingMessageRepositories) AppendMessage(ctx context.Context, c domain.Conversation, m domain.Message, expected int64) error {
	if err := r.Repositories.AppendMessage(ctx, c, m, expected); err != nil {
		return err
	}
	if r.stage == "append" {
		return domain.ErrUnavailable
	}
	return nil
}
func (r failingMessageRepositories) SaveMessageReceipt(ctx context.Context, owner, op, key string, receipt application.MessageReceipt) error {
	if err := r.Repositories.SaveMessageReceipt(ctx, owner, op, key, receipt); err != nil {
		return err
	}
	if r.stage == "receipt" {
		return domain.ErrUnavailable
	}
	return nil
}

func TestPostgresUserTextAppendConcurrencyRollbackReceiptAndRestore(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('owner-a','append-a@example.test','Append A'),('owner-b','append-b@example.test','Append B');
	 INSERT INTO public.projects(id,owner_id,name) VALUES('project-a','owner-a','Append Canvas')`); err != nil {
		t.Fatal("append fixture insertion failed")
	}
	router := integrationRouter(t, db)
	creationKey := uuid.NewString()
	created := call(router, "POST", "/api/v2/conversations", "owner-a", `{"kind":"GLOBAL","title":"append history"}`, map[string]string{"Idempotency-Key": creationKey})
	assertStatus(t, created, 201)
	id := object(created)["id"].(string)
	path := "/api/v2/conversations/" + id
	key := creationKey // operationCode isolation from CreateConversation.
	var results [8]response
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			k := key
			if index%2 == 1 {
				k = strings.ToUpper(k)
			}
			results[index] = call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(k, 1))
		}(i)
	}
	wg.Wait()
	for _, result := range results {
		assertStatus(t, result, 201)
		if !reflect.DeepEqual(object(results[0]), object(result)) || result.headers.Get("ETag") != `"2"` {
			t.Fatal("concurrent replay changed message or receipt revision")
		}
	}
	first := object(results[0])
	if first["role"] != "USER" || first["seq"] != float64(1) || first["conversationRevision"] != float64(2) {
		t.Fatal("persisted append returned false projection")
	}
	assertStatus(t, call(router, "POST", path+"/messages", "owner-b", persistedUserText, appendHeaders(key, 1)), 404)
	assertStatus(t, call(router, "GET", path, "owner-b", "", nil), 404)
	assertStatus(t, call(router, "POST", path+"/messages", "owner-a", `{"content":[{"type":"TEXT","text":"changed"}]}`, appendHeaders(key, 1)), 409)
	assertStatus(t, call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(key, 2)), 409)
	assertStatus(t, call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 1)), 412)

	for i := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			results[index] = call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 2))
		}(i)
	}
	wg.Wait()
	success := 0
	for _, result := range results {
		if result.status == 201 {
			success++
			if object(result)["seq"] != float64(2) {
				t.Fatal("concurrent winner sequence wrong")
			}
		} else {
			assertStatus(t, result, 412)
		}
	}
	if success != 1 {
		t.Fatal("same ETag with new keys appended more than once")
	}
	third := call(router, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 3))
	assertStatus(t, third, 201)
	if object(third)["seq"] != float64(3) || third.headers.Get("ETag") != `"4"` {
		t.Fatal("serial append sequence/revision wrong")
	}
	assertState := func(revision, next int64, count, receipts int) {
		t.Helper()
		var actualRevision, actualNext int64
		var actualMessages, actualReceipts int
		err := db.QueryRow(ctx, `SELECT c.revision,c.next_message_sequence,
		 (SELECT count(*) FROM assistant.messages m WHERE m.conversation_id=c.id AND m.owner_id=c.owner_id),
		 (SELECT count(*) FROM public.idempotency_keys k WHERE k.owner_id=c.owner_id AND k.operation=$2 AND k.response_body->>'conversationId'=c.id)
		 FROM assistant.conversations c WHERE c.id=$1 AND c.owner_id='owner-a'`, id, application.AppendMessageOperation).Scan(&actualRevision, &actualNext, &actualMessages, &actualReceipts)
		if err != nil || actualRevision != revision || actualNext != next || actualMessages != count || actualReceipts != receipts {
			t.Fatal("actual PostgreSQL root/message/receipt state differs")
		}
	}
	assertState(4, 4, 3, 3)

	uow, err := postgres.New(db)
	if err != nil {
		t.Fatal(err)
	}
	failureKey := uuid.NewString()
	command := application.AppendMessageCommand{Content: json.RawMessage(`[{"type":"TEXT","text":"rollback retry"}]`), IdempotencyKey: failureKey, ExpectedRevision: 4}
	for _, stage := range []string{"append", "receipt"} {
		svc, e := application.New(failingMessageUOW{uow, stage})
		if e != nil {
			t.Fatal(e)
		}
		if _, e = svc.AppendMessage(ctx, domain.VerifiedActor{OwnerID: "owner-a"}, id, command); !errors.Is(e, domain.ErrUnavailable) {
			t.Fatalf("fault injection did not abort %s transaction", stage)
		}
		assertState(4, 4, 3, 3)
	}
	retried := call(router, "POST", path+"/messages", "owner-a", `{"content":[{"type":"TEXT","text":"rollback retry"}]}`, appendHeaders(failureKey, 4))
	assertStatus(t, retried, 201)
	if object(retried)["seq"] != float64(4) {
		t.Fatal("failed transaction consumed sequence or key")
	}
	assertState(5, 5, 4, 4)

	// Rebuild all module runtime objects and authenticate a new local session.
	restored := integrationRouter(t, db)
	detail := call(restored, "GET", path, "owner-a", "", nil)
	assertStatus(t, detail, 200)
	if detail.headers.Get("ETag") != `"5"` || object(detail)["revision"] != float64(5) {
		t.Fatal("restored detail lost current revision")
	}
	history := call(restored, "GET", path+"/messages", "owner-a", "", nil)
	assertStatus(t, history, 200)
	if object(history)["total"] != float64(4) {
		t.Fatal("restored history lost persisted messages")
	}
	for i, raw := range object(history)["records"].([]any) {
		message := raw.(map[string]any)
		if message["seq"] != float64(i+1) || message["role"] != "USER" {
			t.Fatal("history contains a false assistant response or sequence gap")
		}
	}
	replay := call(restored, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(key, 1))
	assertStatus(t, replay, 201)
	if !reflect.DeepEqual(first, object(replay)) || replay.headers.Get("ETag") != `"2"` {
		t.Fatal("restart/later writes altered immutable receipt")
	}
	assertStatus(t, call(restored, "POST", path+"/runs", "owner-a", `{}`, nil), 501)
	assertState(5, 5, 4, 4)

	canvas := call(restored, "POST", "/api/v2/conversations", "owner-a", `{"kind":"CANVAS","projectId":"project-a","title":"Canvas append"}`, map[string]string{"Idempotency-Key": uuid.NewString()})
	assertStatus(t, canvas, 201)
	canvasPath := "/api/v2/conversations/" + object(canvas)["id"].(string)
	assertStatus(t, call(restored, "POST", canvasPath+"/messages", "owner-a", persistedUserText, appendHeaders(key, 1)), 409)
	canvasKey := uuid.NewString()
	assertStatus(t, call(restored, "POST", canvasPath+"/messages", "owner-a", persistedUserText, appendHeaders(canvasKey, 1)), 201)
	if _, err = db.Exec(ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='project-a' AND owner_id='owner-a'`); err != nil {
		t.Fatal("parent fixture soft delete failed")
	}
	assertStatus(t, call(restored, "GET", canvasPath, "owner-a", "", nil), 404)
	assertStatus(t, call(restored, "POST", canvasPath+"/messages", "owner-a", persistedUserText, appendHeaders(canvasKey, 1)), 404)
	assertStatus(t, call(restored, "POST", canvasPath+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 2)), 404)
	assertStatus(t, call(restored, "GET", path, "owner-a", "", nil), 200)

	// Even a stored receipt altered to point at another owner's message cannot
	// authorize that row; the replay queries message/root ownership again.
	other := call(restored, "POST", "/api/v2/conversations", "owner-b", `{"kind":"GLOBAL","title":"other owner"}`, map[string]string{"Idempotency-Key": uuid.NewString()})
	assertStatus(t, other, 201)
	otherMessage := call(restored, "POST", "/api/v2/conversations/"+object(other)["id"].(string)+"/messages", "owner-b", persistedUserText, appendHeaders(uuid.NewString(), 1))
	assertStatus(t, otherMessage, 201)
	var receiptBody []byte
	if err = db.QueryRow(ctx, `SELECT response_body FROM public.idempotency_keys WHERE owner_id='owner-a' AND operation=$1 AND key=$2`, application.AppendMessageOperation, key).Scan(&receiptBody); err != nil {
		t.Fatal("receipt fixture read failed")
	}
	if _, err = db.Exec(ctx, `UPDATE public.idempotency_keys SET response_body=jsonb_set(response_body,'{id}',to_jsonb($3::text)) WHERE owner_id='owner-a' AND operation=$1 AND key=$2`, application.AppendMessageOperation, key, object(otherMessage)["id"]); err != nil {
		t.Fatal("receipt fixture modification failed")
	}
	assertStatus(t, call(restored, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(key, 1)), 404)
	if _, err = db.Exec(ctx, `UPDATE public.idempotency_keys SET response_body=$3 WHERE owner_id='owner-a' AND operation=$1 AND key=$2`, application.AppendMessageOperation, key, receiptBody); err != nil {
		t.Fatal("receipt fixture restoration failed")
	}
	assertStatus(t, call(restored, "DELETE", path, "owner-a", "", map[string]string{"If-Match": `"5"`}), 200)
	assertStatus(t, call(restored, "GET", path, "owner-a", "", nil), 404)
	assertStatus(t, call(restored, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(key, 1)), 404)
	assertStatus(t, call(restored, "POST", path+"/messages", "owner-a", persistedUserText, appendHeaders(uuid.NewString(), 6)), 404)
	assertState(6, 5, 4, 4)
}
