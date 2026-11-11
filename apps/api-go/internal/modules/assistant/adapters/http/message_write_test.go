package http_test

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/assistant/application"
)

const userTextBody = `{"content":[{"type":"TEXT","text":"保存 <fox> & 狐"}]}`

func messageHeaders(key string, revision int) map[string]string {
	return map[string]string{"Idempotency-Key": key, "If-Match": fmt.Sprintf(`"%d"`, revision)}
}

func TestHTTPUserTextAppendSequenceReceiptIdentityAndRevision(t *testing.T) {
	h := newHarness(t)
	key := uuid.NewString()
	_, created := h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"GLOBAL","title":"home"}`, map[string]string{"Idempotency-Key": key}, 201, "ConversationResponse")
	id := created["data"].(map[string]any)["id"].(string)
	path := "/api/v2/conversations/" + id
	w, detail := h.request("GET", path, "test-a", "", nil, 200, "ConversationResponse")
	if w.Header().Get("ETag") != `"1"` || detail["data"].(map[string]any)["revision"] != json.Number("1") {
		t.Fatal("detail did not expose current ETag")
	}
	w, first := h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(key, 1), 201, "MessageReceiptResponse")
	message := first["data"].(map[string]any)
	if message["role"] != "USER" || message["seq"] != json.Number("1") || message["conversationRevision"] != json.Number("2") || w.Header().Get("ETag") != `"2"` || !strings.HasPrefix(message["id"].(string), "msg_") {
		t.Fatal("write returned wrong server message/revision")
	}
	// Creation and append operations can safely use the same UUID.
	if len(h.f.receipts) != 1 || len(h.f.messageReceipts) != 1 {
		t.Fatal("operation receipt namespaces overlap")
	}
	w, replayed := h.request("POST", path+"/messages", "test-a", `{"content":[{"text":"保存 \u003cfox\u003e & 狐","type":"TEXT"}]}`, messageHeaders(strings.ToUpper(key), 1), 201, "MessageReceiptResponse")
	if !reflect.DeepEqual(message, replayed["data"]) || w.Header().Get("ETag") != `"2"` {
		t.Fatal("canonical replay changed message or receipt revision")
	}
	h.request("POST", path+"/messages", "test-a", `{"content":[{"type":"TEXT","text":"changed"}]}`, messageHeaders(key, 1), 409, "Error")
	h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(key, 2), 409, "Error")
	h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(uuid.NewString(), 1), 412, "Error")
	_, second := h.request("POST", path+"/messages", "test-a", `{"content":[{"type":"TEXT","text":"second"},{"type":"TEXT","text":" \n "}]}`, messageHeaders(uuid.NewString(), 2), 201, "MessageReceiptResponse")
	if second["data"].(map[string]any)["seq"] != json.Number("2") {
		t.Fatal("sequence skipped after replay/failure")
	}
	w, detail = h.request("GET", path, "test-a", "", nil, 200, "ConversationResponse")
	if w.Header().Get("ETag") != `"3"` || detail["data"].(map[string]any)["revision"] != json.Number("3") {
		t.Fatal("current detail revision differs from aggregate")
	}
	w, replayed = h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(key, 1), 201, "MessageReceiptResponse")
	if !reflect.DeepEqual(message, replayed["data"]) || w.Header().Get("ETag") != `"2"` {
		t.Fatal("later writes changed replay receipt")
	}
	otherID := h.create("test-a", "project-a", "another", uuid.NewString())
	h.request("POST", "/api/v2/conversations/"+otherID+"/messages", "test-a", userTextBody, messageHeaders(key, 1), 409, "Error")
	_, history := h.request("GET", path+"/messages", "test-a", "", nil, 200, "MessagePageResponse")
	if history["data"].(map[string]any)["total"] != json.Number("2") || len(h.f.messages[id]) != 2 || h.f.roots[id].NextMessageSequence != 3 {
		t.Fatal("duplicate append or incorrect aggregate sequence")
	}
	h.request("POST", path+"/runs", "test-a", `{}`, nil, 501, "Error")
	if len(h.f.messages[id]) != 2 {
		t.Fatal("message/run created fake assistant output")
	}
}

func TestHTTPMessageWriteOwnersDeletedRootsAndParents(t *testing.T) {
	h := newHarness(t)
	id := h.create("test-a", "project-a", "private", uuid.NewString())
	path := "/api/v2/conversations/" + id
	key := uuid.NewString()
	h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(key, 1), 201, "MessageReceiptResponse")
	h.request("GET", path, "test-b", "", nil, 404, "Error")
	h.request("POST", path+"/messages", "test-b", userTextBody, messageHeaders(key, 1), 404, "Error")
	h.request("POST", path+"/messages", "test-b", userTextBody, messageHeaders(uuid.NewString(), 2), 404, "Error")
	h.f.projects["project-a"] = project{"owner-a", true}
	h.request("GET", path, "test-a", "", nil, 404, "Error")
	h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(key, 1), 404, "Error")
	h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(uuid.NewString(), 2), 404, "Error")
	h.f.projects["project-a"] = project{"owner-a", false}
	h.request("DELETE", path, "test-a", "", map[string]string{"If-Match": `"2"`}, 200, "AcknowledgementResponse")
	h.request("GET", path, "test-a", "", nil, 404, "Error")
	h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(key, 1), 404, "Error")
	h.request("POST", path+"/messages", "test-a", userTextBody, messageHeaders(uuid.NewString(), 3), 404, "Error")
	if len(h.f.messages[id]) != 1 {
		t.Fatal("delete erased history or hidden append wrote a message")
	}
}

func TestHTTPMessageWriteStrictInputHeadersAndBodyLimit(t *testing.T) {
	h := newHarness(t)
	id := h.create("test-a", "project-a", "validation", uuid.NewString())
	path := "/api/v2/conversations/" + id + "/messages"
	for _, body := range []string{`null`, `[]`, `{}`, `{"content":null}`, `{"content":[]}`, `{"content":[null]}`, `{"content":[{"type":"TEXT","text":""}]}`, `{"content":[{"type":"TEXT","text":" \n\t　"}]}`, `{"content":[{"type":"TEXT","text":"ok"},{"type":"TEXT","text":""}]}`, `{"content":[{"type":"TEXT","text":"a\u0000b"}]}`, `{"content":[{"type":"TEXT","text":1}]}`, `{"content":[{"type":"TEXT","text":"x","ownerId":"other"}]}`, `{"content":[{"type":"TEXT","text":"x","role":"ASSISTANT"}]}`, `{"content":[{"type":"TEXT","text":"x","unknown":true}]}`, `{"content":[{"type":"NATIVE","text":"x"}]}`, `{"Content":[{"type":"TEXT","text":"x"}]}`, `{"content":[{"type":"ASSET","assetId":""}]}`} {
		h.request("POST", path, "test-a", body, messageHeaders(uuid.NewString(), 1), 400, "Error")
	}
	for _, field := range []string{"role", "ownerId", "userId", "workspaceId", "id", "seq", "createdAt", "conversationId", "conversationRevision", "nativeThreadId", "routerSessionRef", "usage"} {
		h.request("POST", path, "test-a", strings.TrimSuffix(userTextBody, "}")+`,"`+field+`":"forged"}`, messageHeaders(uuid.NewString(), 1), 400, "Error")
	}
	for _, body := range []string{`{"content":[{"type":"ASSET","assetId":"unverified"}]}`, `{"content":[{"type":"STRUCTURED","schemaCode":"s.v1","value":{"n":1}}]}`, `{"content":[{"type":"TEXT","text":"x"},{"type":"ASSET","assetId":"a"}]}`} {
		h.request("POST", path, "test-a", body, messageHeaders(uuid.NewString(), 1), 501, "Error")
	}
	h.request("POST", path, "test-a", userTextBody, nil, 400, "Error")
	h.request("POST", path, "test-a", userTextBody, map[string]string{"Idempotency-Key": "not-a-uuid", "If-Match": `"1"`}, 400, "Error")
	h.request("POST", path, "", userTextBody, messageHeaders(uuid.NewString(), 1), 401, "Error")
	h.request("POST", path, "test-a", userTextBody, map[string]string{"Idempotency-Key": uuid.NewString()}, 428, "Error")
	for _, value := range []string{`W/"1"`, `*`, `"0"`, `"01"`, `"1", "2"`, `"9223372036854775808"`} {
		h.request("POST", path, "test-a", userTextBody, map[string]string{"Idempotency-Key": uuid.NewString(), "If-Match": value}, 400, "Error")
	}
	h.request("POST", path+"?ownerId=owner-b", "test-a", userTextBody, messageHeaders(uuid.NewString(), 1), 400, "Error")
	h.request("GET", strings.TrimSuffix(path, "/messages")+"?revision=1", "test-a", "", nil, 400, "Error")
	parts := make([]map[string]string, 101)
	for i := range parts {
		parts[i] = map[string]string{"type": "TEXT", "text": "x"}
	}
	body, _ := json.Marshal(map[string]any{"content": parts})
	h.request("POST", path, "test-a", string(body), messageHeaders(uuid.NewString(), 1), 400, "Error")
	for i := range parts[:6] {
		parts[i]["text"] = strings.Repeat("a", 180000)
	}
	body, _ = json.Marshal(map[string]any{"content": parts[:6]})
	h.request("POST", path, "test-a", string(body), messageHeaders(uuid.NewString(), 1), 413, "Error")
	if len(h.f.messages[id]) != 0 || len(h.f.messageReceipts) != 0 || h.f.roots[id].Revision != 1 {
		t.Fatal("rejected input mutated persistence")
	}
	for i := range parts[:100] {
		parts[i]["text"] = "valid part"
	}
	body, _ = json.Marshal(map[string]any{"content": parts[:100]})
	h.request("POST", path, "test-a", string(body), messageHeaders(uuid.NewString(), 1), 201, "MessageReceiptResponse")
}

func TestHTTPMessageWriteConcurrentPreconditionAndTransactionalRollback(t *testing.T) {
	h := newHarness(t)
	id := h.create("test-a", "project-a", "concurrent", uuid.NewString())
	path := "/api/v2/conversations/" + id + "/messages"
	const count = 8
	results := make([]*httptest.ResponseRecorder, count)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			r := httptest.NewRequest("POST", path, strings.NewReader(userTextBody))
			r.Header.Set("Authorization", "Bearer test-a")
			r.Header.Set("Content-Type", "application/json")
			for k, v := range messageHeaders(uuid.NewString(), 1) {
				r.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			h.router.ServeHTTP(w, r)
			results[index] = w
		}(i)
	}
	wg.Wait()
	success := 0
	for _, r := range results {
		if r.Code == 201 {
			success++
		} else if r.Code != 412 {
			t.Fatalf("concurrent append returned %d", r.Code)
		}
	}
	if success != 1 || len(h.f.messages[id]) != 1 || h.f.roots[id].Revision != 2 {
		t.Fatal("same ETag allowed multiple appends")
	}
	key := uuid.NewString()
	for _, stage := range []string{"append", "receipt"} {
		h.f.failAppend = stage == "append"
		h.f.failReceipt = stage == "receipt"
		h.request("POST", path, "test-a", userTextBody, messageHeaders(key, 2), 503, "Error")
		if len(h.f.messages[id]) != 1 || len(h.f.messageReceipts) != 1 || h.f.roots[id].Revision != 2 || h.f.roots[id].NextMessageSequence != 2 {
			t.Fatal("failed transaction leaked message, sequence, revision or receipt")
		}
	}
	h.f.failAppend = false
	h.f.failReceipt = false
	_, result := h.request("POST", path, "test-a", userTextBody, messageHeaders(key, 2), 201, "MessageReceiptResponse")
	if result["data"].(map[string]any)["seq"] != json.Number("2") {
		t.Fatal("rollback consumed a sequence or key")
	}
	if _, ok := h.f.messageReceipts["owner-a"+application.AppendMessageOperation+key]; !ok {
		t.Fatal("successful retry did not store independent receipt")
	}
}
