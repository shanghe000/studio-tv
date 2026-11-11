package application

import (
	"context"
	"encoding/json"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"time"
)

type Asset struct {
	ID, Kind, MimeType, Version, SHA256 string
	ByteSize                            int64
	Width, Height                       *int
	DurationMs                          *int64
}
type Grant struct{ ID, AssetID, Version, SHA256 string }

type HistoryInputQuery struct {
	ProjectID, NodeID, OutputID, ExecutionID string
	OutputIndex                              *int
}
type HistoryInput struct {
	TaskID, ExecutionID string
	Output              domain.Output
}
type historyInputReader interface {
	ResolveHistoryInput(context.Context, string, HistoryInputQuery) (HistoryInput, error)
}
type Event struct {
	Sequence   int64           `json:"sequence"`
	Type       string          `json:"type"`
	Data       json.RawMessage `json:"data"`
	ObservedAt time.Time       `json:"observedAt"`
	TestMode   bool            `json:"testMode"`
}
type EventPage struct {
	Items         []Event `json:"items"`
	NextCursor    *string `json:"nextCursor"`
	Terminal      bool    `json:"terminal"`
	SchemaVersion string  `json:"schemaVersion"`
}
type History struct {
	ID                 string          `json:"id"`
	TaskID             string          `json:"taskId"`
	ExecutionID        string          `json:"executionId"`
	NodeID             string          `json:"nodeId"`
	ProjectID          *string         `json:"projectId"`
	Outputs            []domain.Output `json:"outputs"`
	ParamsSnapshot     json.RawMessage `json:"paramsSnapshot"`
	NodeConfigSnapshot json.RawMessage `json:"nodeConfigSnapshot"`
	CreatedAt          time.Time       `json:"createdAt"`
	TestMode           bool            `json:"testMode"`
	Revision           int64           `json:"revision"`
}
type HistoryQuery struct {
	ProjectID, NodeID, Type string
	Page, Size              int
}
type HistoryPage struct {
	Records  []History `json:"records"`
	Page     int       `json:"page"`
	Size     int       `json:"size"`
	Total    int64     `json:"total"`
	HasNext  bool      `json:"hasNext"`
	Revision int64     `json:"revision"`
}
type ConversationInput struct {
	PreviousCapabilityRef, PreviousCapabilityVersion, RouterConversationRef string
	PreviousState                                                           string
	Kind                                                                    string
	ProjectID                                                               *string
	Content                                                                 json.RawMessage
	Context                                                                 json.RawMessage
	Sequence                                                                int64
	Revision                                                                int64
}
type Store interface {
	Create(context.Context, domain.Task, string, string, []Grant) (domain.Task, error)
	Get(context.Context, string, string) (domain.Task, error)
	Assets(context.Context, string, []string) ([]Asset, error)
	Conversation(context.Context, string, string, string) (ConversationInput, error)
	Claim(context.Context, string) (domain.Task, bool, error)
	Save(context.Context, domain.Task, string) (bool, error)
	Cancel(context.Context, string, string) (domain.Task, error)
	Events(context.Context, string, string, int64) (EventPage, error)
	History(context.Context, string, HistoryQuery) (HistoryPage, error)
	DeleteHistory(context.Context, string, []string) ([]string, error)
	DeleteOutput(context.Context, string, string, string, int64) (domain.Task, error)
}
type AssetImporter interface {
	Import(context.Context, string, string, string, gateway.Artifact, []byte) (Asset, error)
}

// CanvasContextReader supplies a bounded product snapshot after verifying its
// current user's ownership. It grants no tool or mutation authority.
type CanvasContextReader interface {
	ReadCanvasContext(context.Context, string, string) (json.RawMessage, error)
}
