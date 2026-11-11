package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"studiotv.local/service/api/internal/modules/assistant/domain"
)

const AppendMessageOperation = "assistantAppendUserMessage"

type MessageReceipt struct {
	RequestHash          string
	ExpectedRevision     int64
	ConversationRevision int64
	Message              domain.Message
}

type AppendMessageCommand struct {
	Content          json.RawMessage
	IdempotencyKey   string
	ExpectedRevision int64
}

type AppendMessageResult struct {
	Message              domain.Message
	ConversationRevision int64
}

// AppendMessageHash freezes the path and precondition along with canonical
// content. A caller cannot reuse a key on another root or with a newer ETag.
func AppendMessageHash(id string, expected int64, content json.RawMessage) (string, error) {
	if !domain.ValidID(id) || expected < 1 {
		return "", domain.ErrInvalid
	}
	if err := domain.ValidateUserParts(content); err != nil {
		return "", err
	}
	var parts any
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&parts); err != nil {
		return "", domain.ErrInvalid
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{
		"body":         map[string]any{"content": parts},
		"params":       map[string]any{"conversationId": id},
		"precondition": map[string]any{"expectedRevision": expected},
		"team":         nil,
	}); err != nil {
		return "", domain.ErrInvalid
	}
	sum := sha256.Sum256(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
	return hex.EncodeToString(sum[:]), nil
}

func (s *Service) Detail(ctx context.Context, actor domain.VerifiedActor, id string) (domain.Conversation, error) {
	var result domain.Conversation
	if err := actor.Validate(); err != nil {
		return result, err
	}
	if !domain.ValidID(id) {
		return result, domain.ErrInvalid
	}
	err := s.uow.Within(ctx, func(tx Repositories) error {
		var err error
		result, err = tx.Conversation(ctx, actor.OwnerID, id, false)
		return err
	})
	return result, err
}

func (s *Service) AppendMessage(ctx context.Context, actor domain.VerifiedActor, id string, command AppendMessageCommand) (AppendMessageResult, error) {
	var result AppendMessageResult
	if err := actor.Validate(); err != nil {
		return result, err
	}
	key, err := NormalizeKey(command.IdempotencyKey)
	if err != nil {
		return result, err
	}
	content := append(json.RawMessage(nil), command.Content...)
	hash, err := AppendMessageHash(id, command.ExpectedRevision, content)
	if err != nil {
		return result, err
	}
	err = s.uow.Within(ctx, func(tx Repositories) error {
		if err := tx.LockIdempotency(ctx, actor.OwnerID, AppendMessageOperation, key); err != nil {
			return err
		}
		// Every request, including a replay/conflict, rechecks the actual root
		// and owned undeleted Canvas project under the aggregate write lock.
		root, err := tx.Conversation(ctx, actor.OwnerID, id, true)
		if err != nil {
			return err
		}
		receipt, err := tx.FindMessageReceipt(ctx, actor.OwnerID, AppendMessageOperation, key)
		if err != nil {
			return err
		}
		if receipt != nil {
			if receipt.RequestHash != hash || receipt.Message.ConversationID != id || receipt.ExpectedRevision != command.ExpectedRevision {
				return domain.ErrIdempotencyConflict
			}
			// Receipt JSON never grants ownership. Query the persisted message
			// again with owner + root and reject inconsistent/corrupt receipts.
			message, err := tx.Message(ctx, actor.OwnerID, id, receipt.Message.ID)
			if err != nil {
				return err
			}
			if receipt.ConversationRevision != receipt.ExpectedRevision+1 || receipt.ConversationRevision > root.Revision || message.Sequence >= root.NextMessageSequence || !sameMessage(message, receipt.Message) {
				return domain.ErrUnavailable
			}
			result = AppendMessageResult{Message: message, ConversationRevision: receipt.ConversationRevision}
			return nil
		}
		if guard, ok := tx.(ActiveTaskGuard); ok {
			if err = guard.AssertNoActiveAssistantTask(ctx, actor.OwnerID, id); err != nil {
				return err
			}
		}
		if ids := domain.MessageAssetIDs(content); len(ids) > 0 {
			validator, ok := tx.(interface {
				AuthorizeMessageAssets(context.Context, string, []string) error
			})
			if !ok {
				return domain.ErrMessagePartsUnavailable
			}
			if err = validator.AuthorizeMessageAssets(ctx, actor.OwnerID, ids); err != nil {
				return err
			}
		}
		if domain.HasSkillParts(content) {
			validator, ok := tx.(interface {
				AuthorizeMessageSkills(context.Context, string, json.RawMessage) error
			})
			if !ok {
				return domain.ErrMessagePartsUnavailable
			}
			if err = validator.AuthorizeMessageSkills(ctx, actor.OwnerID, content); err != nil {
				return err
			}
		}
		message, err := root.AppendUserParts(s.newMessageID(), content, command.ExpectedRevision, s.now())
		if err != nil {
			return err
		}
		if err = tx.AppendMessage(ctx, root, message, command.ExpectedRevision); err != nil {
			return err
		}
		receipt = &MessageReceipt{RequestHash: hash, ExpectedRevision: command.ExpectedRevision, ConversationRevision: root.Revision, Message: message}
		if err = tx.SaveMessageReceipt(ctx, actor.OwnerID, AppendMessageOperation, key, *receipt); err != nil {
			return err
		}
		result = AppendMessageResult{Message: message, ConversationRevision: root.Revision}
		return nil
	})
	if err != nil {
		return AppendMessageResult{}, err
	}
	return result, nil
}

func sameMessage(a, b domain.Message) bool {
	if a.ID != b.ID || a.ConversationID != b.ConversationID || a.Sequence != b.Sequence || a.Role != "USER" || b.Role != "USER" || !a.CreatedAt.Equal(b.CreatedAt) {
		return false
	}
	// JSONB changes object order/spacing; compare canonical content semantics.
	x, err := AppendMessageHash(a.ConversationID, 1, a.Content)
	if err != nil {
		return false
	}
	y, err := AppendMessageHash(b.ConversationID, 1, b.Content)
	return err == nil && x == y
}
