package application

import (
	"context"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/modules/assistant/domain"
	"strings"
	"testing"
)

func TestCanonicalCreationHashAndUUIDKey(t *testing.T) {
	a := map[string]any{"kind": "CANVAS", "title": "<fox> & 狐", "projectId": "project-a"}
	b := map[string]any{"projectId": "project-a", "title": "<fox> & 狐", "kind": "CANVAS"}
	x, err := CreationHash(a)
	if err != nil {
		t.Fatal(err)
	}
	y, err := CreationHash(b)
	if err != nil || x != y {
		t.Fatal("field order affected hash")
	}
	b["hfProjectId"] = nil
	y, _ = CreationHash(b)
	if x == y {
		t.Fatal("omission must stay distinct from explicit null, matching core")
	}
	key := "f9b7a437-06f2-4d3c-884a-27d6bc3e0053"
	canonical, err := NormalizeKey(strings.ToUpper(key))
	if err != nil || canonical != key {
		t.Fatal("case variant UUID must share lock scope")
	}
	for _, bad := range []string{"", strings.ReplaceAll(key, "-", ""), "urn:uuid:" + key, "{" + key + "}"} {
		if _, err := NormalizeKey(bad); err == nil {
			t.Fatal("noncanonical key accepted")
		}
	}
}

// Unexpected project/SQL paths panic through the embedded interface. The
// explicit OwnedProject rejection proves GLOBAL does not require a Canvas root.
type globalRepositories struct {
	Repositories
	root            domain.Conversation
	receipt         *Receipt
	projectChecks   int
	messages        []domain.Message
	messageReceipts map[string]MessageReceipt
}

func (r *globalRepositories) OwnedProject(context.Context, string, string) error {
	r.projectChecks++
	return domain.ErrProjectNotFound
}
func (*globalRepositories) LockIdempotency(context.Context, string, string, string) error { return nil }
func (r *globalRepositories) FindReceipt(context.Context, string, string, string) (*Receipt, error) {
	return r.receipt, nil
}
func (r *globalRepositories) CreateConversation(_ context.Context, c domain.Conversation) error {
	r.root = c
	return nil
}
func (r *globalRepositories) SaveReceipt(_ context.Context, _, _, _ string, receipt Receipt) error {
	r.receipt = &receipt
	return nil
}
func (r *globalRepositories) Conversation(_ context.Context, owner, id string, _ bool) (domain.Conversation, error) {
	if r.root.OwnerID != owner || r.root.ID != id || r.root.DeletedAt != nil {
		return domain.Conversation{}, domain.ErrConversationNotFound
	}
	return r.root, nil
}
func (r *globalRepositories) FindMessageReceipt(_ context.Context, owner, operation, key string) (*MessageReceipt, error) {
	v, ok := r.messageReceipts[owner+operation+key]
	if !ok {
		return nil, nil
	}
	return &v, nil
}
func (r *globalRepositories) SaveMessageReceipt(_ context.Context, owner, operation, key string, receipt MessageReceipt) error {
	if r.messageReceipts == nil {
		r.messageReceipts = map[string]MessageReceipt{}
	}
	r.messageReceipts[owner+operation+key] = receipt
	return nil
}
func (r *globalRepositories) Message(ctx context.Context, owner, conversationID, id string) (domain.Message, error) {
	if _, err := r.Conversation(ctx, owner, conversationID, false); err != nil {
		return domain.Message{}, err
	}
	for _, m := range r.messages {
		if m.ID == id && m.ConversationID == conversationID {
			return m, nil
		}
	}
	return domain.Message{}, domain.ErrConversationNotFound
}
func (r *globalRepositories) AppendMessage(_ context.Context, root domain.Conversation, message domain.Message, expected int64) error {
	if r.root.Revision != expected || r.root.NextMessageSequence != message.Sequence {
		return domain.ErrUnavailable
	}
	r.root = root
	r.messages = append(r.messages, message)
	return nil
}

type globalUOW struct{ repo *globalRepositories }

func (u globalUOW) Within(_ context.Context, fn func(Repositories) error) error { return fn(u.repo) }
func TestGlobalUseCaseNeverQueriesProjectAndRestoresReceipt(t *testing.T) {
	repo := &globalRepositories{}
	uow := globalUOW{repo}
	service, err := New(uow)
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := CreationHash(map[string]any{"kind": "GLOBAL", "title": "首页"})
	cmd := CreateCommand{Input: domain.Create{Kind: domain.Global, Title: "首页"}, IdempotencyKey: "f9b7a437-06f2-4d3c-884a-27d6bc3e0053", RequestHash: hash}
	actor := domain.VerifiedActor{OwnerID: "owner-a"}
	created, err := service.Create(context.Background(), actor, cmd)
	if err != nil || created.Kind != domain.Global || created.ProjectID != nil || repo.projectChecks != 0 {
		t.Fatalf("global creation depends on project: %v", err)
	}
	restarted, _ := New(uow)
	replayed, err := restarted.Create(context.Background(), actor, cmd)
	if err != nil || created.ID != replayed.ID || repo.projectChecks != 0 {
		t.Fatal("reassembled service lost homepage identity")
	}
	changed := cmd
	changed.RequestHash = strings.Repeat("a", 64)
	if _, err = restarted.Create(context.Background(), actor, changed); !errors.Is(err, domain.ErrIdempotencyConflict) {
		t.Fatal("changed request reused receipt")
	}
	if err = restarted.Visible(context.Background(), domain.VerifiedActor{OwnerID: "owner-b"}, created.ID); !errors.Is(err, domain.ErrConversationNotFound) {
		t.Fatal("other user read global conversation")
	}
	project := "project-a"
	canvasCmd := cmd
	canvasCmd.Input = domain.Create{Kind: domain.Canvas, ProjectID: &project}
	canvasCmd.IdempotencyKey = "f9b7a437-06f2-4d3c-884a-27d6bc3e0054"
	repo.receipt = nil
	if _, err = restarted.Create(context.Background(), actor, canvasCmd); !errors.Is(err, domain.ErrProjectNotFound) || repo.projectChecks != 1 {
		t.Fatal("Canvas ownership check was removed")
	}
}

func TestMessageHashFreezesPathAndPrecondition(t *testing.T) {
	content := json.RawMessage(`[{"type":"TEXT","text":"<fox> & 狐"}]`)
	a, err := AppendMessageHash("conversation-a", 1, content)
	if err != nil {
		t.Fatal(err)
	}
	b, err := AppendMessageHash("conversation-a", 1, json.RawMessage(`[ {"text":"\u003cfox\u003e & 狐","type":"TEXT"} ]`))
	if err != nil || a != b {
		t.Fatal("JSON object order/escaping changed canonical identity")
	}
	for _, variant := range []struct {
		id       string
		revision int64
		content  json.RawMessage
	}{
		{"conversation-b", 1, content}, {"conversation-a", 2, content}, {"conversation-a", 1, json.RawMessage(`[{"type":"TEXT","text":"changed"}]`)},
	} {
		b, err = AppendMessageHash(variant.id, variant.revision, variant.content)
		if err != nil || a == b {
			t.Fatal("request identity omits path/precondition/content")
		}
	}
}

func TestReassembledServiceRestoresPersistedUserMessagesAndReceipt(t *testing.T) {
	repo := &globalRepositories{}
	s, _ := New(globalUOW{repo})
	actor := domain.VerifiedActor{OwnerID: "owner-a"}
	hash, _ := CreationHash(map[string]any{"kind": "GLOBAL", "title": "history"})
	root, err := s.Create(context.Background(), actor, CreateCommand{Input: domain.Create{Kind: domain.Global, Title: "history"}, IdempotencyKey: "f9b7a437-06f2-4d3c-884a-27d6bc3e0053", RequestHash: hash})
	if err != nil {
		t.Fatal(err)
	}
	cmd := AppendMessageCommand{Content: json.RawMessage(`[{"type":"TEXT","text":"saved user text"}]`), ExpectedRevision: 1, IdempotencyKey: "f9b7a437-06f2-4d3c-884a-27d6bc3e0054"}
	first, err := s.AppendMessage(context.Background(), actor, root.ID, cmd)
	if err != nil || first.Message.Role != "USER" || first.Message.Sequence != 1 || first.ConversationRevision != 2 {
		t.Fatalf("append failed: %v", err)
	}
	restarted, _ := New(globalUOW{repo})
	replay, err := restarted.AppendMessage(context.Background(), actor, root.ID, cmd)
	if err != nil || replay.Message.ID != first.Message.ID || replay.ConversationRevision != 2 || len(repo.messages) != 1 || repo.projectChecks != 0 {
		t.Fatal("reassembly lost history or replay appended twice")
	}
	if _, err = restarted.AppendMessage(context.Background(), domain.VerifiedActor{OwnerID: "owner-b"}, root.ID, cmd); !errors.Is(err, domain.ErrConversationNotFound) {
		t.Fatal("receipt authorized another owner")
	}
	// Receipt projection cannot hide a changed/missing real DB message.
	repo.messages[0].Content = json.RawMessage(`[{"type":"TEXT","text":"tampered"}]`)
	if _, err = restarted.AppendMessage(context.Background(), actor, root.ID, cmd); !errors.Is(err, domain.ErrUnavailable) {
		t.Fatal("replay trusted receipt instead of actual message")
	}
}
