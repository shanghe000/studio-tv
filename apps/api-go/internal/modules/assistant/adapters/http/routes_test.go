package http_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"studiotv.local/service/api/internal/httpapi"
	assistantHTTP "studiotv.local/service/api/internal/modules/assistant/adapters/http"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

// This fixture verifies transport/use-case behavior, not PostgreSQL. Real SQL,
// locks and constraints have separate TEST_DATABASE_URL integration coverage.
type project struct {
	owner   string
	deleted bool
}
type fixture struct {
	mu                      sync.Mutex
	projects                map[string]project
	roots                   map[string]domain.Conversation
	receipts                map[string]application.Receipt
	messageReceipts         map[string]application.MessageReceipt
	messages                map[string][]domain.Message
	deny, unavailable       bool
	failAppend, failReceipt bool
}

func (f *fixture) Within(_ context.Context, fn func(application.Repositories) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	roots, receipts, messageReceipts := cloneMap(f.roots), cloneMap(f.receipts), cloneMap(f.messageReceipts)
	messages := make(map[string][]domain.Message, len(f.messages))
	for id, records := range f.messages {
		messages[id] = append([]domain.Message(nil), records...)
	}
	if err := fn(f); err != nil {
		f.roots, f.receipts, f.messageReceipts, f.messages = roots, receipts, messageReceipts, messages
		return err
	}
	return nil
}
func cloneMap[K comparable, V any](input map[K]V) map[K]V {
	copy := make(map[K]V, len(input))
	for key, value := range input {
		copy[key] = value
	}
	return copy
}
func (f *fixture) OwnedProject(_ context.Context, owner, id string) error {
	p, ok := f.projects[id]
	if !ok || p.owner != owner || p.deleted {
		return domain.ErrProjectNotFound
	}
	return nil
}
func (*fixture) LockIdempotency(context.Context, string, string, string) error { return nil }
func (f *fixture) FindReceipt(_ context.Context, owner, op, key string) (*application.Receipt, error) {
	v, ok := f.receipts[owner+op+key]
	if !ok {
		return nil, nil
	}
	return &v, nil
}
func (f *fixture) SaveReceipt(_ context.Context, owner, op, key string, v application.Receipt) error {
	f.receipts[owner+op+key] = v
	return nil
}
func (f *fixture) CreateConversation(_ context.Context, c domain.Conversation) error {
	f.roots[c.ID] = c
	return nil
}
func (f *fixture) Conversation(ctx context.Context, owner, id string, _ bool) (domain.Conversation, error) {
	c, ok := f.roots[id]
	if !ok || c.OwnerID != owner || c.DeletedAt != nil || (c.Kind == domain.Canvas && (c.ProjectID == nil || f.OwnedProject(ctx, owner, *c.ProjectID) != nil)) {
		return c, domain.ErrConversationNotFound
	}
	return c, nil
}
func (f *fixture) DeleteConversation(_ context.Context, c domain.Conversation, _ int64) error {
	f.roots[c.ID] = c
	return nil
}
func (f *fixture) FindMessageReceipt(_ context.Context, owner, op, key string) (*application.MessageReceipt, error) {
	v, ok := f.messageReceipts[owner+op+key]
	if !ok {
		return nil, nil
	}
	return &v, nil
}
func (f *fixture) SaveMessageReceipt(_ context.Context, owner, op, key string, v application.MessageReceipt) error {
	f.messageReceipts[owner+op+key] = v
	if f.failReceipt {
		return domain.ErrUnavailable
	}
	return nil
}
func (f *fixture) Message(ctx context.Context, owner, conversationID, id string) (domain.Message, error) {
	if _, err := f.Conversation(ctx, owner, conversationID, false); err != nil {
		return domain.Message{}, err
	}
	for _, message := range f.messages[conversationID] {
		if message.ID == id {
			return message, nil
		}
	}
	return domain.Message{}, domain.ErrConversationNotFound
}
func (f *fixture) AppendMessage(_ context.Context, root domain.Conversation, message domain.Message, expected int64) error {
	current := f.roots[root.ID]
	if current.Revision != expected || current.NextMessageSequence != message.Sequence {
		return domain.ErrUnavailable
	}
	f.messages[root.ID] = append(f.messages[root.ID], message)
	f.roots[root.ID] = root
	if f.failAppend {
		return domain.ErrUnavailable
	}
	return nil
}
func (f *fixture) Conversations(ctx context.Context, owner string, q domain.ConversationQuery) (domain.Page[domain.Conversation], error) {
	var roots []domain.Conversation
	for _, c := range f.roots {
		if _, err := f.Conversation(ctx, owner, c.ID, false); err == nil && (q.Kind == nil || c.Kind == *q.Kind) && (q.ProjectID == nil || c.ProjectID != nil && *c.ProjectID == *q.ProjectID) && strings.Contains(strings.ToLower(c.Title), strings.ToLower(q.Keyword)) {
			roots = append(roots, c)
		}
	}
	sort.Slice(roots, func(i, j int) bool {
		if roots[i].UpdatedAt.Equal(roots[j].UpdatedAt) {
			return roots[i].ID < roots[j].ID
		}
		return roots[i].UpdatedAt.After(roots[j].UpdatedAt)
	})
	return domain.NewPage(q.PageQuery, paginate(roots, q.PageQuery), int64(len(roots))), nil
}
func (f *fixture) Messages(_ context.Context, _ string, id string, q domain.PageQuery) (domain.Page[domain.Message], error) {
	var messages []domain.Message
	for _, m := range f.messages[id] {
		if q.Keyword == "" || bytes.Contains(bytes.ToLower(m.Content), []byte(strings.ToLower(q.Keyword))) {
			messages = append(messages, m)
		}
	}
	return domain.NewPage(q, paginate(messages, q), int64(len(messages))), nil
}
func paginate[T any](records []T, q domain.PageQuery) []T {
	start := q.Offset()
	if start >= int64(len(records)) {
		return []T{}
	}
	end := min(start+int64(q.Size), int64(len(records)))
	return records[start:end]
}

type harness struct {
	t       *testing.T
	router  http.Handler
	f       *fixture
	schemas map[string]*jsonschema.Schema
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	f := &fixture{projects: map[string]project{"project-a": {"owner-a", false}, "project-b": {"owner-b", false}, "project-deleted": {"owner-a", true}}, roots: map[string]domain.Conversation{}, receipts: map[string]application.Receipt{}, messageReceipts: map[string]application.MessageReceipt{}, messages: map[string][]domain.Message{}}
	svc, err := application.New(f)
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Use(httpapi.Base(nil))
	r.NotFound(httpapi.Wrap(func(http.ResponseWriter, *http.Request) error {
		return httpapi.Fail(404, "NOT_FOUND", "接口不存在。")
	}))
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		if r.Header.Get("Authorization") == "Bearer test-a" {
			return httpapi.Identity{UserID: "owner-a"}, nil
		}
		if r.Header.Get("Authorization") == "Bearer test-b" {
			return httpapi.Identity{UserID: "owner-b"}, nil
		}
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "test identity unavailable")
	})
	protect := func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("route omitted tv.access")
		}
		return httpapi.RequireAuth(auth, func(w http.ResponseWriter, r *http.Request) error {
			if f.unavailable {
				return httpapi.Retry(503, "AUTHORIZATION_UNAVAILABLE", "test authorization offline")
			}
			if f.deny {
				return httpapi.Fail(403, "FORBIDDEN", "test authorization denied")
			}
			return next(w, r)
		})
	}
	if err = assistantHTTP.RegisterRoutes(r, svc, protect); err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	for _, file := range []string{"assistant-extension.json"} {
		raw, err := os.ReadFile("../../../../../../../contracts/" + file)
		if err != nil {
			t.Fatal(err)
		}
		var doc any
		if err = json.Unmarshal(raw, &doc); err != nil {
			t.Fatal(err)
		}
		if err = compiler.AddResource("https://rhtv.local/contracts/"+file, doc); err != nil {
			t.Fatal(err)
		}
	}
	schemas := map[string]*jsonschema.Schema{}
	for _, name := range []string{"ConversationResponse", "ConversationPageResponse", "MessagePageResponse", "MessageReceiptResponse", "AcknowledgementResponse", "Error"} {
		schemas[name], err = compiler.Compile("https://rhtv.local/contracts/assistant-extension.json#/components/schemas/" + name)
		if err != nil {
			t.Fatal(err)
		}
	}
	return &harness{t, r, f, schemas}
}
func (h *harness) request(method, path, user, body string, headers map[string]string, status int, schema string) (*httptest.ResponseRecorder, map[string]any) {
	h.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if user != "" {
		r.Header.Set("Authorization", "Bearer "+user)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, r)
	if w.Code != status {
		h.t.Fatalf("%s %s wanted %d got %d: %s", method, path, status, w.Code, w.Body.String())
	}
	var parsed map[string]any
	dec := json.NewDecoder(w.Body)
	dec.UseNumber()
	if err := dec.Decode(&parsed); err != nil {
		h.t.Fatal(err)
	}
	if err := h.schemas[schema].Validate(parsed); err != nil {
		h.t.Fatalf("response fails implemented assistant DTO %s: %v", schema, err)
	}
	if parsed["requestId"] == "" || parsed["requestId"] != w.Header().Get("X-Request-Id") {
		h.t.Fatal("request ID envelope mismatch")
	}
	return w, parsed
}
func (h *harness) create(user, project, title, key string) string {
	h.t.Helper()
	body, _ := json.Marshal(map[string]any{"kind": "CANVAS", "projectId": project, "title": title})
	_, r := h.request("POST", "/api/v2/conversations", user, string(body), map[string]string{"Idempotency-Key": key}, 201, "ConversationResponse")
	return r["data"].(map[string]any)["id"].(string)
}

func TestHTTPPrivateOwnersPaginationMessagesAndSoftDelete(t *testing.T) {
	h := newHarness(t)
	key := uuid.NewString()
	id := h.create("test-a", "project-a", "狐 one", key)
	if again := h.create("test-a", "project-a", "狐 one", strings.ToUpper(key)); again != id {
		t.Fatal("replay changed identity")
	}
	h.create("test-a", "project-a", "狐 two", uuid.NewString())
	h.create("test-b", "project-b", "owner b", key)
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"CANVAS","projectId":"project-b","title":"cross owner"}`, map[string]string{"Idempotency-Key": uuid.NewString()}, 404, "Error")
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"CANVAS","projectId":"project-deleted","title":"deleted"}`, map[string]string{"Idempotency-Key": uuid.NewString()}, 404, "Error")
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"CANVAS","projectId":"project-a","title":"changed"}`, map[string]string{"Idempotency-Key": key}, 409, "Error")
	h.request("GET", "/api/v2/conversations?projectId=project-b", "test-a", "", nil, 404, "Error")
	h.request("GET", "/api/v2/conversations?projectId=project-deleted", "test-a", "", nil, 404, "Error")
	_, page := h.request("GET", "/api/v2/conversations?projectId=project-a&size=1&keyword=%20%E7%8B%90%20", "test-a", "", map[string]string{"X-Owner-Id": "owner-b", "X-Workspace-Id": "untrusted"}, 200, "ConversationPageResponse")
	data := page["data"].(map[string]any)
	if data["total"] != json.Number("2") || data["hasNext"] != true || len(data["records"].([]any)) != 1 {
		t.Fatal("incorrect page projection")
	}
	h.request("GET", "/api/v2/conversations?page=100000&size=100", "test-a", "", nil, 200, "ConversationPageResponse")
	h.f.messages[id] = []domain.Message{{ID: "message-a", ConversationID: id, Sequence: 1, Role: "USER", Content: json.RawMessage(`[{"type":"TEXT","text":"visible fox"},{"type":"STRUCTURED","schemaCode":"test.v1","value":{"n":9007199254740993}}]`), CreatedAt: time.Now()}}
	_, history := h.request("GET", "/api/v2/conversations/"+id+"/messages?keyword=fox", "test-a", "", nil, 200, "MessagePageResponse")
	parts := history["data"].(map[string]any)["records"].([]any)[0].(map[string]any)["content"].([]any)
	if parts[1].(map[string]any)["value"].(map[string]any)["n"] != json.Number("9007199254740993") {
		t.Fatal("structured JSON number lost precision")
	}
	h.request("GET", "/api/v2/conversations/"+id+"/messages", "test-b", "", nil, 404, "Error")
	h.request("DELETE", "/api/v2/conversations/"+id, "test-b", "", map[string]string{"If-Match": `"1"`}, 404, "Error")
	h.request("DELETE", "/api/v2/conversations/"+id, "test-a", "", nil, 428, "Error")
	h.request("DELETE", "/api/v2/conversations/"+id, "test-a", "", map[string]string{"If-Match": `"2"`}, 412, "Error")
	w, _ := h.request("DELETE", "/api/v2/conversations/"+id, "test-a", "", map[string]string{"If-Match": `"1"`}, 200, "AcknowledgementResponse")
	if w.Header().Get("ETag") != `"2"` {
		t.Fatal("delete did not return advanced revision")
	}
	h.request("GET", "/api/v2/conversations/"+id+"/messages", "test-a", "", nil, 404, "Error")
	h.request("DELETE", "/api/v2/conversations/"+id, "test-a", "", map[string]string{"If-Match": `"2"`}, 404, "Error")
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"CANVAS","projectId":"project-a","title":"狐 one"}`, map[string]string{"Idempotency-Key": key}, 404, "Error")
	if len(h.f.roots) != 3 {
		t.Fatal("invalid/replayed creation wrote another root")
	}
	if len(h.f.messages[id]) != 1 {
		t.Fatal("soft delete removed historical message")
	}
}

func TestHTTPDeletedProjectHidesExistingHistory(t *testing.T) {
	h := newHarness(t)
	key := uuid.NewString()
	id := h.create("test-a", "project-a", "history", key)
	h.f.projects["project-a"] = project{"owner-a", true}
	_, page := h.request("GET", "/api/v2/conversations", "test-a", "", nil, 200, "ConversationPageResponse")
	if page["data"].(map[string]any)["total"] != json.Number("0") {
		t.Fatal("deleted project leaked history")
	}
	h.request("GET", "/api/v2/conversations/"+id+"/messages", "test-a", "", nil, 404, "Error")
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"CANVAS","projectId":"project-a","title":"history"}`, map[string]string{"Idempotency-Key": key}, 404, "Error")
}

func TestHTTPParameterFailuresAndReservedCapabilities(t *testing.T) {
	h := newHarness(t)
	for _, query := range []string{"page=0", "page=100001", "page=01", "page=", "page=1&page=2", "size=101", "size=-1", "size=1.2", "pageSize=10", "q=fox", "keyword=" + strings.Repeat("a", 301), "projectId=", "projectId=project-a&hfProjectId=hf-a", "kind=", "kind=global", "kind=UNKNOWN", "kind=GLOBAL&kind=CANVAS", "kind=GLOBAL&projectId=project-a", "kind=GLOBAL&hfProjectId=hf-a", "kind=CANVAS&hfProjectId=hf-a"} {
		h.request("GET", "/api/v2/conversations?"+query, "test-a", "", nil, 400, "Error")
	}
	for _, body := range []string{`null`, `{}`, `{"kind":"CANVAS","projectId":"project-a","title":null}`, `{"kind":"CANVAS","projectId":null,"title":"x"}`, `{"kind":"CANVAS","projectId":"project-a","hfProjectId":"hf-a","title":"x"}`, `{"kind":"CANVAS","projectId":"project-a","title":"x","ownerId":"owner-b"}`, `{"kind":"GLOBAL","projectId":"project-a","title":"x"}`, `{"kind":"GLOBAL","hfProjectId":"hf-a","title":"x"}`} {
		h.request("POST", "/api/v2/conversations", "test-a", body, map[string]string{"Idempotency-Key": uuid.NewString()}, 400, "Error")
	}
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"HF","title":"private HF"}`, map[string]string{"Idempotency-Key": uuid.NewString()}, 201, "ConversationResponse")
	h.request("GET", "/api/v2/conversations?hfProjectId=hf-a", "test-a", "", nil, 501, "Error")
	h.request("GET", "/api/v2/conversations?kind=HF", "test-a", "", nil, 200, "ConversationPageResponse")
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"CANVAS","projectId":"project-a","title":"x"}`, nil, 400, "Error")
	id := h.create("test-a", "project-a", "run disabled", uuid.NewString())
	for _, value := range []string{`W/"1"`, `*`, `"0"`, `"01"`, `"1", "2"`, `"999999999999999999999999999999"`} {
		h.request("DELETE", "/api/v2/conversations/"+id, "test-a", "", map[string]string{"If-Match": value}, 400, "Error")
	}
	h.request("POST", "/api/v2/conversations/"+id+"/runs", "test-a", `{}`, nil, 501, "Error")
	h.request("POST", "/api/v2/conversations/"+id+"/runs", "test-b", `{}`, nil, 404, "Error")
	for _, route := range []struct{ method, path string }{{"GET", "/api/v2/assistant-runs/future"}, {"GET", "/api/v2/assistant-runs/future/events"}, {"POST", "/api/v2/assistant-runs/future/cancel"}, {"POST", "/api/v2/assistant-runs/future/tool-calls/call/result"}} {
		h.request(route.method, route.path, "test-a", "", nil, 501, "Error")
	}
	h.request("GET", "/api/v2/conversations/unknown/path", "test-a", "", nil, 404, "Error")
}

func TestHTTPGlobalHistoryWithoutCanvasDependency(t *testing.T) {
	h := newHarness(t)
	key := uuid.NewString()
	body := `{"kind":"GLOBAL","title":"首页记录"}`
	_, created := h.request("POST", "/api/v2/conversations", "test-a", body, map[string]string{"Idempotency-Key": key}, 201, "ConversationResponse")
	data := created["data"].(map[string]any)
	id := data["id"].(string)
	if data["kind"] != "GLOBAL" || data["projectId"] != nil || data["hfProjectId"] != nil {
		t.Fatal("homepage DTO has project binding")
	}
	_, same := h.request("POST", "/api/v2/conversations", "test-a", body, map[string]string{"Idempotency-Key": strings.ToUpper(key)}, 201, "ConversationResponse")
	if same["data"].(map[string]any)["id"] != id {
		t.Fatal("global idempotency changed identity")
	}
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"GLOBAL","title":"changed"}`, map[string]string{"Idempotency-Key": key}, 409, "Error")
	_, other := h.request("POST", "/api/v2/conversations", "test-b", body, map[string]string{"Idempotency-Key": key}, 201, "ConversationResponse")
	if other["data"].(map[string]any)["id"] == id {
		t.Fatal("other owner shares root")
	}
	// Explicit null binding is supported, and remains a distinct request hash.
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"GLOBAL","projectId":null,"hfProjectId":null,"title":"首页记录"}`, map[string]string{"Idempotency-Key": key}, 409, "Error")
	h.request("POST", "/api/v2/conversations", "test-a", `{"kind":"GLOBAL","projectId":null,"hfProjectId":null,"title":"另一首页"}`, map[string]string{"Idempotency-Key": uuid.NewString()}, 201, "ConversationResponse")
	canvasID := h.create("test-a", "project-a", "canvas", uuid.NewString())
	_, mixed := h.request("GET", "/api/v2/conversations", "test-a", "", nil, 200, "ConversationPageResponse")
	if mixed["data"].(map[string]any)["total"] != json.Number("3") {
		t.Fatal("unfiltered list omitted kind")
	}
	_, canvas := h.request("GET", "/api/v2/conversations?kind=CANVAS", "test-a", "", nil, 200, "ConversationPageResponse")
	if canvas["data"].(map[string]any)["total"] != json.Number("1") {
		t.Fatal("Canvas filter incorrect")
	}
	h.f.projects["project-a"] = project{"owner-a", true}
	h.f.messages[id] = []domain.Message{{ID: "global-message", ConversationID: id, Sequence: 1, Role: "USER", Content: json.RawMessage(`[{"type":"TEXT","text":"durable homepage fox"}]`), CreatedAt: time.Now()}}
	_, page := h.request("GET", "/api/v2/conversations?kind=GLOBAL", "test-a", "", nil, 200, "ConversationPageResponse")
	if page["data"].(map[string]any)["total"] != json.Number("2") {
		t.Fatal("project deletion hides global")
	}
	h.request("GET", "/api/v2/conversations/"+id+"/messages", "test-a", "", nil, 200, "MessagePageResponse")
	h.request("GET", "/api/v2/conversations/"+id+"/messages", "test-b", "", nil, 404, "Error")
	h.request("GET", "/api/v2/conversations/"+canvasID+"/messages", "test-a", "", nil, 404, "Error")
	h.request("POST", "/api/v2/conversations", "test-a", body, map[string]string{"Idempotency-Key": key}, 201, "ConversationResponse")
	h.request("POST", "/api/v2/conversations/"+id+"/runs", "test-a", `{}`, nil, 501, "Error")
	h.request("DELETE", "/api/v2/conversations/"+id, "test-b", "", map[string]string{"If-Match": `"1"`}, 404, "Error")
	h.request("DELETE", "/api/v2/conversations/"+id, "test-a", "", map[string]string{"If-Match": `"1"`}, 200, "AcknowledgementResponse")
	h.request("GET", "/api/v2/conversations/"+id+"/messages", "test-a", "", nil, 404, "Error")
	if len(h.f.messages[id]) != 1 {
		t.Fatal("global delete removed history")
	}
}

func TestHTTPTrustedDecorationAndAuthorizationFailures(t *testing.T) {
	h := newHarness(t)
	h.request("GET", "/api/v2/conversations", "", "", map[string]string{"X-Owner-Id": "owner-a"}, 401, "Error")
	h.f.deny = true
	h.request("GET", "/api/v2/conversations", "test-a", "", nil, 403, "Error")
	h.f.deny = false
	h.f.unavailable = true
	h.request("GET", "/api/v2/conversations", "test-a", "", nil, 503, "Error")
	svc, _ := application.New(h.f)
	if err := assistantHTTP.RegisterRoutes(chi.NewRouter(), svc, nil); err == nil {
		t.Fatal("nil protector accepted")
	}
	r := chi.NewRouter()
	r.Use(httpapi.Base(nil))
	if err := assistantHTTP.RegisterRoutes(r, svc, func(_ string, next httpapi.Handler) http.HandlerFunc { return httpapi.Wrap(next) }); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v2/conversations", nil)
	req.Header.Set("X-Owner-Id", "owner-a")
	r.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("undecorated handler trusted caller owner")
	}
	if _, err := application.New(nil); err == nil {
		t.Fatal("nil unit of work accepted")
	}
}
