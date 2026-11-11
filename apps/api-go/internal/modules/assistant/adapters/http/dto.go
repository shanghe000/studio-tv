package http

import (
	"encoding/json"
	"studiotv.local/service/api/internal/modules/assistant/domain"
	"time"
)

type conversationDTO struct {
	ID          string  `json:"id"`
	Revision    int64   `json:"revision"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	ProjectID   *string `json:"projectId"`
	HFProjectID *string `json:"hfProjectId"`
	Kind        string  `json:"kind"`
	Title       string  `json:"title"`
}

func iso(at time.Time) string { return at.UTC().Format("2006-01-02T15:04:05.000Z") }
func conversationView(c domain.Conversation) conversationDTO {
	return conversationDTO{c.ID, c.Revision, iso(c.CreatedAt), iso(c.UpdatedAt), c.ProjectID, c.HFProjectID, string(c.Kind), c.Title}
}

type messageDTO struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversationId"`
	Sequence       int64           `json:"seq"`
	Role           string          `json:"role"`
	Content        json.RawMessage `json:"content"`
	CreatedAt      string          `json:"createdAt"`
}

func messageView(m domain.Message) messageDTO {
	return messageDTO{m.ID, m.ConversationID, m.Sequence, m.Role, m.Content, iso(m.CreatedAt)}
}

type messageReceiptDTO struct {
	messageDTO
	ConversationRevision int64 `json:"conversationRevision"`
}

type pageDTO[T any] struct {
	Records []T   `json:"records"`
	Page    int   `json:"page"`
	Size    int   `json:"size"`
	Total   int64 `json:"total"`
	HasNext bool  `json:"hasNext"`
}
