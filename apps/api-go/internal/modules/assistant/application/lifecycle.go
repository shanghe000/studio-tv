package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"studiotv.local/service/api/internal/modules/assistant/domain"
	"time"
)

const DeleteTurnOperation = "assistantDeleteTurn"
const DeleteMessageOperation = "assistantDeleteMessage"

type MessageDeletionCommand struct {
	ExpectedRevision int64
	IdempotencyKey   string
}
type MessageDeletionReceipt struct {
	RequestHash string
	Result      domain.MessageDeletion
}

// Optional ports preserve existing test/legacy adapters; the real PostgreSQL
// repository implements these inside the already locked conversation UoW.
type LifecycleRepositories interface {
	FindDeletionReceipt(context.Context, string, string, string) (*MessageDeletionReceipt, error)
	SaveDeletionReceipt(context.Context, string, string, string, MessageDeletionReceipt) error
	ValidateDeletionReceipt(context.Context, string, string, domain.MessageDeletion) error
	DeleteMessages(context.Context, domain.Conversation, string, bool, time.Time) (domain.MessageDeletion, error)
}
type ActiveTaskGuard interface {
	AssertNoActiveAssistantTask(context.Context, string, string) error
}
type ClientToolRepositories interface {
	HasClientToolEvidence(context.Context, string, string) (bool, error)
}

func DeletionHash(conversation, target string, turn bool, expected int64) (string, error) {
	if !domain.ValidID(conversation) || !domain.ValidID(target) || expected < 1 {
		return "", domain.ErrInvalid
	}
	raw, e := json.Marshal(struct {
		ConversationID, TargetID string
		Turn                     bool
		Expected                 int64
	}{conversation, target, turn, expected})
	if e != nil {
		return "", domain.ErrInvalid
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
func (s *Service) DeleteMessage(ctx context.Context, a domain.VerifiedActor, id, target string, turn bool, command MessageDeletionCommand) (domain.MessageDeletion, error) {
	var result domain.MessageDeletion
	if e := a.Validate(); e != nil {
		return result, e
	}
	key, e := NormalizeKey(command.IdempotencyKey)
	if e != nil {
		return result, e
	}
	hash, e := DeletionHash(id, target, turn, command.ExpectedRevision)
	if e != nil {
		return result, e
	}
	operation := DeleteMessageOperation
	if turn {
		operation = DeleteTurnOperation
	}
	e = s.uow.Within(ctx, func(tx Repositories) error {
		if e := tx.LockIdempotency(ctx, a.OwnerID, operation, key); e != nil {
			return e
		}
		root, e := tx.Conversation(ctx, a.OwnerID, id, true)
		if e != nil {
			return e
		}
		repo, ok := tx.(LifecycleRepositories)
		if !ok {
			return domain.ErrLifecycleUnavailable
		}
		receipt, e := repo.FindDeletionReceipt(ctx, a.OwnerID, operation, key)
		if e != nil {
			return e
		}
		if receipt != nil {
			if receipt.RequestHash != hash || receipt.Result.ConversationID != id {
				return domain.ErrIdempotencyConflict
			}
			if receipt.Result.ConversationRevision > root.Revision {
				return domain.ErrUnavailable
			}
			if e = repo.ValidateDeletionReceipt(ctx, a.OwnerID, id, receipt.Result); e != nil {
				return e
			}
			result = receipt.Result
			return nil
		}
		if root.Revision != command.ExpectedRevision {
			return &domain.VersionConflict{Current: root.Revision}
		}
		if root.Revision == math.MaxInt64 {
			return domain.ErrInvalid
		}
		result, e = repo.DeleteMessages(ctx, root, target, turn, s.now().UTC().Truncate(time.Millisecond))
		if e != nil {
			return e
		}
		return repo.SaveDeletionReceipt(ctx, a.OwnerID, operation, key, MessageDeletionReceipt{hash, result})
	})
	return result, e
}
func (s *Service) PendingClientTools(ctx context.Context, a domain.VerifiedActor, id string) (domain.ClientToolPending, error) {
	var result domain.ClientToolPending
	if e := a.Validate(); e != nil {
		return result, e
	}
	if !domain.ValidID(id) {
		return result, domain.ErrInvalid
	}
	e := s.uow.Within(ctx, func(tx Repositories) error {
		if _, e := tx.Conversation(ctx, a.OwnerID, id, false); e != nil {
			return e
		}
		repo, ok := tx.(ClientToolRepositories)
		if !ok {
			return domain.ErrClientToolsUnavailable
		}
		evidence, e := repo.HasClientToolEvidence(ctx, a.OwnerID, id)
		if e != nil {
			return e
		}
		if evidence {
			return domain.ErrClientToolsUnavailable
		}
		result = domain.NoPendingClientTools(id)
		return nil
	})
	return result, e
}
