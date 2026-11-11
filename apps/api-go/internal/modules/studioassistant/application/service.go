// Package application composes persisted HF conversations with product runs.
package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	assistant "studiotv.local/service/api/internal/modules/assistant/application"
	adomain "studiotv.local/service/api/internal/modules/assistant/domain"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	edomain "studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"strings"
)

type Command struct {
	CapabilityRef      string `json:"capabilityRef,omitempty"`
	CapabilityVersion  string `json:"capabilityVersion,omitempty"`
	AgentID            string `json:"agentId"`
	Message            string `json:"message"`
	PreviousResponseID string `json:"previousResponseId,omitempty"`
}
type Reservation struct {
	Revision                         int64
	CapabilityRef, CapabilityVersion string
}
type Store interface {
	Agent(context.Context, string, string, string) (string, error)
	Reserve(context.Context, string, string, string, string, Command, gateway.Capability) (Reservation, error)
}
type Service struct {
	store         Store
	conversations *assistant.Service
	execution     *execution.Service
	gateway       gateway.Gateway
}

func New(store Store, c *assistant.Service, e *execution.Service, g gateway.Gateway) (*Service, error) {
	if store == nil || c == nil || e == nil || g == nil {
		return nil, errors.New("HF application ports required")
	}
	return &Service{store, c, e, g}, nil
}
func (s *Service) Agent(ctx context.Context, owner, cid, key string) (string, error) {
	if _, err := assistant.NormalizeKey(key); err != nil {
		return "", err
	}
	c, err := s.conversations.Detail(ctx, adomain.VerifiedActor{OwnerID: owner}, cid)
	if err != nil {
		return "", err
	}
	if c.Kind != adomain.HF {
		return "", adomain.ErrConversationNotFound
	}
	return s.store.Agent(ctx, owner, cid, key)
}
func (s *Service) Run(ctx context.Context, owner, cid, key string, cmd Command) (edomain.Task, error) {
	if _, err := assistant.NormalizeKey(key); err != nil {
		return edomain.Task{}, err
	}
	if !adomain.ValidID(cmd.AgentID) || strings.TrimSpace(cmd.Message) == "" || len(cmd.Message) > 200000 || strings.ContainsRune(cmd.Message, '\x00') {
		return edomain.Task{}, adomain.ErrInvalid
	}
	c, err := s.conversations.Detail(ctx, adomain.VerifiedActor{OwnerID: owner}, cid)
	if err != nil {
		return edomain.Task{}, err
	}
	if c.Kind != adomain.HF {
		return edomain.Task{}, adomain.ErrConversationNotFound
	}
	if cmd.PreviousResponseID != "" {
		previous, err := s.execution.Get(ctx, owner, cmd.PreviousResponseID)
		if err != nil || previous.ConversationID == nil || *previous.ConversationID != cid || previous.State != "SUCCEEDED" {
			return edomain.Task{}, adomain.ErrConversationNotFound
		}
	}
	var cap gateway.Capability
	cursor := ""
	seen := map[string]bool{}
	for {
		catalog, err := s.gateway.Capabilities(ctx, gateway.Actor{SubjectRef: owner}, gateway.CapabilityQuery{Kind: "LLM", Limit: 100, Cursor: cursor})
		if err != nil {
			return edomain.Task{}, err
		}
		for _, v := range catalog.Items {
			if v.Kind != "LLM" || !s.execution.CanExecute(v) {
				continue
			}
			if cmd.CapabilityRef != "" {
				if v.Ref == cmd.CapabilityRef && (cmd.CapabilityVersion == "" || v.Version == cmd.CapabilityVersion) {
					cap = v
				}
				continue
			}
			if gateway.PreferCapability(v, cap) {
				cap = v
			}
		}
		if catalog.NextCursor == nil {
			break
		}
		cursor = *catalog.NextCursor
		if cursor == "" || seen[cursor] {
			return edomain.Task{}, &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		seen[cursor] = true
	}
	if cap.Ref == "" {
		return edomain.Task{}, &gateway.Fault{Code: "CAPABILITY_UNAVAILABLE"}
	}
	raw, _ := json.Marshal(cmd)
	digest := sha256.Sum256(raw)
	reservation, err := s.store.Reserve(ctx, owner, cid, key, hex.EncodeToString(digest[:]), cmd, cap)
	if err != nil {
		return edomain.Task{}, err
	}
	parts, _ := json.Marshal([]map[string]string{{"type": "TEXT", "text": cmd.Message}})
	messageKey := uuid.NewSHA1(uuid.NameSpaceOID, []byte("hf/"+owner+"/"+cid+"/"+key)).String()
	result, err := s.conversations.AppendMessage(ctx, adomain.VerifiedActor{OwnerID: owner}, cid, assistant.AppendMessageCommand{Content: parts, IdempotencyKey: messageKey, ExpectedRevision: reservation.Revision})
	if err != nil {
		return edomain.Task{}, err
	}
	return s.execution.Assistant(ctx, owner, cid, key, execution.AssistantCommand{CapabilityRef: reservation.CapabilityRef, CapabilityVersion: reservation.CapabilityVersion, MessageID: result.Message.ID, Parameters: json.RawMessage(`{}`)})
}
