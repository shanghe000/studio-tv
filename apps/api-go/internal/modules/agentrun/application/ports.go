// Package application coordinates durable Agent runs and bounded trusted tools.
package application

import (
	"context"
	"encoding/json"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"time"
)

type Runtime interface {
	Available() bool
	Models(context.Context) ([]Model, error)
	Run(context.Context, RuntimeRequest, ToolHandler) (RuntimeResult, error)
}
type Model struct {
	ID            string   `json:"id"`
	Efforts       []string `json:"efforts"`
	DefaultEffort string   `json:"defaultEffort"`
	Available     bool     `json:"available"`
}
type RuntimeMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}
type RuntimeRequest struct {
	RunID, OwnerID, ConversationID, Model, Effort         string
	BaseInstructions, DeveloperInstructions, Instructions string
	Messages                                              []RuntimeMessage
	Tools                                                 []ToolDefinition
	PromptHash, ToolSchemaHash, ProfileVersion            string
	Checkpoint                                            json.RawMessage
	ReconcileOnly                                         bool
}
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	OperationID string          `json:"operationId"`
	Version     string          `json:"version"`
}
type ToolHandler interface {
	Bind(context.Context, string, string) error
	SaveCheckpoint(context.Context, json.RawMessage) error
	HandleTool(context.Context, RuntimeToolCall) (RuntimeToolResult, error)
}

// ToolReceiptVerifier reconciles only already completed durable evidence.
// It cannot register a call or produce a business side effect.
type ToolReceiptVerifier interface {
	VerifyToolReceipt(context.Context, RuntimeToolCall) (RuntimeToolResult, error)
}

type RuntimeToolCall struct {
	ThreadID, TurnID, CallID, Name, Namespace string
	Arguments                                 json.RawMessage
}
type RuntimeToolResult struct {
	Success bool
	Output  json.RawMessage
}
type RuntimeResult struct {
	Text             string
	Checkpoint       json.RawMessage
	TerminalVerified bool
	Usage            json.RawMessage
}

type Actor struct {
	OwnerID, SessionID                          string
	IssuedAt, AccessExpiresAt, SessionExpiresAt time.Time
}

// Credential is consumed only by trusted HTTP transport. Never serialize it.
type Credential struct {
	Actor     Actor
	Bearer    string                         `json:"-"`
	Canvas    collaboration.CanvasDelegation `json:"-"`
	Epoch     string
	ExpiresAt time.Time
}
type CreateCommand struct {
	MessageID         string          `json:"messageId"`
	CapabilityRef     string          `json:"capabilityRef"`
	CapabilityVersion string          `json:"capabilityVersion"`
	Parameters        json.RawMessage `json:"parameters"`
	ExpectedRevision  int64           `json:"expectedRevision"`
}
type CreateRecord struct {
	Run     domain.Run
	Command CreateCommand
	Actor   Actor
}
type ToolRequest struct {
	Method, Path     string
	Body             json.RawMessage
	ExpectedRevision int64
	IdempotencyKey   string
	WaitSeconds      int
}
type ToolResponse struct {
	Status    int
	Data      json.RawMessage
	ErrorCode string
	Retryable bool
}
type Executor interface {
	// Revalidate must check both current authentication AND live tv.access.
	Revalidate(context.Context, Credential) error
	Execute(context.Context, Credential, ToolRequest) (ToolResponse, error)
}

// Store implements short transactions. Owner/session bindings, frozen hashes,
// tool receipts and event allocation are checked inside those transactions.
type Store interface {
	Create(context.Context, CreateRecord) (domain.Run, error)
	Get(context.Context, string, string) (domain.Run, error)
	ListActive(context.Context, string, string) ([]domain.Run, error)
	Events(context.Context, string, string, int64, int) (domain.EventPage, error)
	UpdateAuth(context.Context, string, string, string, string, time.Time, time.Time, time.Time) (domain.Run, error)
	Cancel(context.Context, string, string) (domain.Run, error)
	Recover(context.Context) error
	Claim(context.Context, time.Duration) (*domain.Run, error)
	Renew(context.Context, string, string, time.Duration) error
	WaitAuth(context.Context, string, string, string) error
	PauseAuth(context.Context, string, string, string) error
	MarkRuntimeStarted(context.Context, string, string) error
	Bind(context.Context, string, string, string, string) error
	SaveCheckpoint(context.Context, string, string, json.RawMessage) error
	History(context.Context, domain.Run) ([]RuntimeMessage, error)
	BeginTool(context.Context, domain.Run, domain.ToolCall, int) (domain.ToolCall, error)
	CompleteTool(context.Context, domain.Run, domain.ToolCall, ToolResponse) error
	ToolReceipt(context.Context, domain.Run, domain.ToolCall) (domain.ToolCall, error)
	Finish(context.Context, domain.Run, domain.State, string, RuntimeResult) error
}
type Config struct {
	PromptSpec    *gateway.PromptSpec
	RunTimeout    time.Duration
	LeaseDuration time.Duration
	MaxToolCalls  int
	Workers       int
}
