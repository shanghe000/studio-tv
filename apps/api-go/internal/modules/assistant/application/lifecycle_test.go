package application

import (
	"context"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/modules/assistant/domain"
	"testing"
)

type lifecycleGuardRepository struct {
	*globalRepositories
	busy, evidence bool
}

func (r *lifecycleGuardRepository) AssertNoActiveAssistantTask(context.Context, string, string) error {
	if r.busy {
		return domain.ErrTaskActive
	}
	return nil
}
func (r *lifecycleGuardRepository) HasClientToolEvidence(context.Context, string, string) (bool, error) {
	return r.evidence, nil
}

type lifecycleTestUOW struct{ repo Repositories }

func (u lifecycleTestUOW) Within(_ context.Context, fn func(Repositories) error) error {
	return fn(u.repo)
}

func TestLifecycleHashBindsPathTargetOperationAndPrecondition(t *testing.T) {
	base, err := DeletionHash("conversation-a", "message-a", true, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct {
		id, message string
		turn        bool
		revision    int64
	}{{"conversation-b", "message-a", true, 2}, {"conversation-a", "message-b", true, 2}, {"conversation-a", "message-a", false, 2}, {"conversation-a", "message-a", true, 3}} {
		hash, err := DeletionHash(v.id, v.message, v.turn, v.revision)
		if err != nil || hash == base {
			t.Fatal("deletion request identity did not bind the actual target and precondition")
		}
	}
	if _, err = DeletionHash("conversation-a", "", true, 2); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal("empty target accepted")
	}
}

func TestLifecycleOptionalPortsNeverClaimUnsupportedSuccessAndGuardAppend(t *testing.T) {
	ctx := context.Background()
	actor := domain.VerifiedActor{OwnerID: "owner-a"}
	base := &globalRepositories{root: domain.Conversation{ID: "conversation-a", OwnerID: "owner-a", Kind: domain.Global, Revision: 1, NextMessageSequence: 1}}
	svc, _ := New(lifecycleTestUOW{base})
	command := MessageDeletionCommand{ExpectedRevision: 1, IdempotencyKey: "f9b7a437-06f2-4d3c-884a-27d6bc3e0053"}
	if _, err := svc.DeleteMessage(ctx, actor, base.root.ID, "message-a", true, command); !errors.Is(err, domain.ErrLifecycleUnavailable) {
		t.Fatal("legacy adapter claimed persisted deletion")
	}
	if _, err := svc.PendingClientTools(ctx, actor, base.root.ID); !errors.Is(err, domain.ErrClientToolsUnavailable) {
		t.Fatal("legacy adapter claimed actual SQL tool absence")
	}
	guard := &lifecycleGuardRepository{globalRepositories: base, busy: true}
	svc, _ = New(lifecycleTestUOW{guard})
	if _, err := svc.Delete(ctx, actor, base.root.ID, 1); !errors.Is(err, domain.ErrTaskActive) || base.root.Revision != 1 || base.root.DeletedAt != nil {
		t.Fatal("busy aggregate allowed conversation deletion or consumed a revision")
	}
	appendCommand := AppendMessageCommand{ExpectedRevision: 1, IdempotencyKey: command.IdempotencyKey, Content: json.RawMessage(`[{"type":"TEXT","text":"next turn"}]`)}
	if _, err := svc.AppendMessage(ctx, actor, base.root.ID, appendCommand); !errors.Is(err, domain.ErrTaskActive) || len(base.messages) != 0 || base.root.Revision != 1 {
		t.Fatal("busy aggregate accepted a later USER or consumed a sequence/revision")
	}
	pending, err := svc.PendingClientTools(ctx, actor, base.root.ID)
	if err != nil || pending.SessionID != base.root.ID || pending.Status != "none" || pending.HostEvents == nil || pending.Call != nil || pending.TerminalRecovered {
		t.Fatal("verified absence returned a fabricated resume result")
	}
	guard.evidence = true
	if _, err = svc.PendingClientTools(ctx, actor, base.root.ID); !errors.Is(err, domain.ErrClientToolsUnavailable) {
		t.Fatal("actual unsupported tool evidence pretended to be none")
	}
	if _, err = svc.PendingClientTools(ctx, domain.VerifiedActor{OwnerID: "owner-b"}, base.root.ID); !errors.Is(err, domain.ErrConversationNotFound) {
		t.Fatal("tool evidence query bypassed aggregate ownership")
	}
}
