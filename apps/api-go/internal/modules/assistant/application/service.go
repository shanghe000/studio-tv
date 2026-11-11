// Package application orchestrates product persistence, never Router execution.
package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

const CreateOperation = "domainCreateConversation"

type Receipt struct {
	RequestHash  string
	Conversation domain.Conversation
}

// Repositories is bound to one transaction. Reads must hide deleted projects
// and conversations; project checks lock the root against concurrent deletion.
type Repositories interface {
	OwnedProject(context.Context, string, string) error
	LockIdempotency(context.Context, string, string, string) error
	FindReceipt(context.Context, string, string, string) (*Receipt, error)
	SaveReceipt(context.Context, string, string, string, Receipt) error
	CreateConversation(context.Context, domain.Conversation) error
	Conversation(context.Context, string, string, bool) (domain.Conversation, error)
	DeleteConversation(context.Context, domain.Conversation, int64) error
	Conversations(context.Context, string, domain.ConversationQuery) (domain.Page[domain.Conversation], error)
	Messages(context.Context, string, string, domain.PageQuery) (domain.Page[domain.Message], error)
	FindMessageReceipt(context.Context, string, string, string) (*MessageReceipt, error)
	SaveMessageReceipt(context.Context, string, string, string, MessageReceipt) error
	Message(context.Context, string, string, string) (domain.Message, error)
	AppendMessage(context.Context, domain.Conversation, domain.Message, int64) error
}
type UnitOfWork interface {
	Within(context.Context, func(Repositories) error) error
}

type Service struct {
	uow          UnitOfWork
	now          func() time.Time
	newID        func() string
	newMessageID func() string
}

func New(uow UnitOfWork) (*Service, error) {
	if uow == nil {
		return nil, errors.New("assistant unit of work is required")
	}
	return &Service{uow: uow, now: time.Now, newID: func() string { return "cnv_" + strings.ReplaceAll(uuid.NewString(), "-", "") }, newMessageID: func() string { return "msg_" + strings.ReplaceAll(uuid.NewString(), "-", "") }}, nil
}

func NormalizeKey(key string) (string, error) {
	id, err := uuid.Parse(key)
	if err != nil || len(key) != 36 || strings.ToLower(key) != id.String() {
		return "", domain.ErrInvalid
	}
	return id.String(), nil
}

// CreationHash follows the existing core body/params/team canonical hash.
// rawBody is the validated JSON object: omitted and explicit null stay distinct,
// while object field order and Unicode/HTML escaping do not affect the hash.
func CreationHash(rawBody map[string]any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"body": rawBody, "params": map[string]any{}, "team": nil}); err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
	return hex.EncodeToString(sum[:]), nil
}

type CreateCommand struct {
	Input          domain.Create
	IdempotencyKey string
	RequestHash    string
}

func (s *Service) Create(ctx context.Context, actor domain.VerifiedActor, command CreateCommand) (domain.Conversation, error) {
	var result domain.Conversation
	if err := actor.Validate(); err != nil {
		return result, err
	}
	if err := command.Input.Validate(); err != nil {
		return result, err
	}
	key, err := NormalizeKey(command.IdempotencyKey)
	if err != nil {
		return result, err
	}
	hash, err := hex.DecodeString(command.RequestHash)
	if err != nil || len(hash) != sha256.Size {
		return result, domain.ErrInvalid
	}
	err = s.uow.Within(ctx, func(tx Repositories) error {
		if err := tx.LockIdempotency(ctx, actor.OwnerID, CreateOperation, key); err != nil {
			return err
		}
		receipt, err := tx.FindReceipt(ctx, actor.OwnerID, CreateOperation, key)
		if err != nil {
			return err
		}
		if receipt != nil && receipt.RequestHash != command.RequestHash {
			return domain.ErrIdempotencyConflict
		}
		if command.Input.Kind == domain.Canvas {
			if err := tx.OwnedProject(ctx, actor.OwnerID, *command.Input.ProjectID); err != nil {
				return err
			}
		}
		if command.Input.HFProjectID != nil {
			validator, ok := tx.(interface {
				OwnedHFProject(context.Context, string, string) error
			})
			if !ok {
				return domain.ErrHFUnavailable
			}
			if err := validator.OwnedHFProject(ctx, actor.OwnerID, *command.Input.HFProjectID); err != nil {
				return err
			}
		}
		if receipt != nil {
			// A replay is still an access: do not resurrect a soft deleted root.
			if _, err := tx.Conversation(ctx, actor.OwnerID, receipt.Conversation.ID, false); err != nil {
				return err
			}
			result = receipt.Conversation
			return nil
		}
		result, err = domain.NewConversation(s.newID(), actor, command.Input, s.now())
		if err != nil {
			return err
		}
		if err = tx.CreateConversation(ctx, result); err != nil {
			return err
		}
		return tx.SaveReceipt(ctx, actor.OwnerID, CreateOperation, key, Receipt{RequestHash: command.RequestHash, Conversation: result})
	})
	return result, err
}

func (s *Service) List(ctx context.Context, actor domain.VerifiedActor, query domain.ConversationQuery) (domain.Page[domain.Conversation], error) {
	var page domain.Page[domain.Conversation]
	if err := actor.Validate(); err != nil {
		return page, err
	}
	query.Keyword = strings.TrimSpace(query.Keyword)
	if err := query.Validate(); err != nil {
		return page, err
	}
	err := s.uow.Within(ctx, func(tx Repositories) error {
		if query.ProjectID != nil {
			read := tx.OwnedProject
			if reader, ok := tx.(interface {
				ReadProject(context.Context, string, string) error
			}); ok {
				read = reader.ReadProject
			}
			if err := read(ctx, actor.OwnerID, *query.ProjectID); err != nil {
				return err
			}
		}
		if query.HFProjectID != nil {
			validator, ok := tx.(interface {
				OwnedHFProject(context.Context, string, string) error
			})
			if !ok {
				return domain.ErrHFUnavailable
			}
			if err := validator.OwnedHFProject(ctx, actor.OwnerID, *query.HFProjectID); err != nil {
				return err
			}
		}
		var err error
		page, err = tx.Conversations(ctx, actor.OwnerID, query)
		return err
	})
	return page, err
}

func (s *Service) Messages(ctx context.Context, actor domain.VerifiedActor, id string, query domain.PageQuery) (domain.Page[domain.Message], error) {
	var page domain.Page[domain.Message]
	if err := actor.Validate(); err != nil {
		return page, err
	}
	query.Keyword = strings.TrimSpace(query.Keyword)
	if !domain.ValidID(id) {
		return page, domain.ErrInvalid
	}
	if err := query.Validate(); err != nil {
		return page, err
	}
	err := s.uow.Within(ctx, func(tx Repositories) error {
		if _, err := tx.Conversation(ctx, actor.OwnerID, id, false); err != nil {
			return err
		}
		var err error
		page, err = tx.Messages(ctx, actor.OwnerID, id, query)
		return err
	})
	return page, err
}

func (s *Service) Delete(ctx context.Context, actor domain.VerifiedActor, id string, expected int64) (int64, error) {
	if err := actor.Validate(); err != nil {
		return 0, err
	}
	if !domain.ValidID(id) || expected < 1 {
		return 0, domain.ErrInvalid
	}
	var revision int64
	err := s.uow.Within(ctx, func(tx Repositories) error {
		root, err := tx.Conversation(ctx, actor.OwnerID, id, true)
		if err != nil {
			return err
		}
		if guard, ok := tx.(ActiveTaskGuard); ok {
			if err = guard.AssertNoActiveAssistantTask(ctx, actor.OwnerID, id); err != nil {
				return err
			}
		}
		if err = root.SoftDelete(expected, s.now()); err != nil {
			return err
		}
		if err = tx.DeleteConversation(ctx, root, expected); err != nil {
			return err
		}
		revision = root.Revision
		return nil
	})
	return revision, err
}

// Visible is used by the reserved conversation-run endpoint before returning
// 501. It does not enqueue a run or invoke any external service.
func (s *Service) Visible(ctx context.Context, actor domain.VerifiedActor, id string) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	if !domain.ValidID(id) {
		return domain.ErrInvalid
	}
	return s.uow.Within(ctx, func(tx Repositories) error { _, err := tx.Conversation(ctx, actor.OwnerID, id, false); return err })
}
