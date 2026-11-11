// Package domain defines actor-bound Agent evidence, never transport credentials.
package domain

import (
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrInvalid        = errors.New("invalid agent request")
	ErrNotFound       = errors.New("agent resource not found")
	ErrConflict       = errors.New("agent idempotency conflict")
	ErrActive         = errors.New("conversation already has active work")
	ErrUnavailable    = errors.New("agent store unavailable")
	ErrDisabled       = errors.New("agent runtime unavailable")
	ErrAuth           = errors.New("agent needs current parent session")
	ErrAuthVersion    = errors.New("agent credential epoch conflict")
	ErrAuthRegression = errors.New("agent credential cannot regress")
	ErrParentSession  = errors.New("agent parent session differs")
	ErrFenced         = errors.New("agent lease fenced")
	ErrToolRejected   = errors.New("agent tool rejected")
	ErrBudget         = errors.New("agent tool budget exceeded")
)

type VersionConflict struct{ Current int64 }

func (e *VersionConflict) Error() string { return "agent canvas revision changed" }

type State string

const (
	Queued      State = "QUEUED"
	Running     State = "RUNNING"
	WaitingAuth State = "WAITING_FOR_AUTH"
	Succeeded   State = "SUCCEEDED"
	Failed      State = "FAILED"
	Canceled    State = "CANCELED"
	TimedOut    State = "TIMED_OUT"
	Unknown     State = "UNKNOWN"
)

func (s State) Active() bool { return s == Queued || s == Running || s == WaitingAuth }

type Run struct {
	ID                 string          `json:"id"`
	Kind               string          `json:"kind"`
	OwnerID            string          `json:"-"`
	ParentSessionID    string          `json:"-"`
	ConversationID     string          `json:"conversationId"`
	ProjectID          string          `json:"projectId"`
	MessageID          string          `json:"messageId"`
	CapabilityRef      string          `json:"capabilityRef"`
	CapabilityVersion  string          `json:"capabilityVersion"`
	Parameters         json.RawMessage `json:"parameters"`
	ExpectedRevision   int64           `json:"expectedRevision"`
	State              State           `json:"state"`
	AssistantMessageID *string         `json:"assistantMessageId"`
	CredentialEpoch    string          `json:"credentialEpoch"`
	AuthExpiresAt      time.Time       `json:"authExpiresAt"`
	CreatedAt          time.Time       `json:"createdAt"`
	UpdatedAt          time.Time       `json:"updatedAt"`
	Deadline           time.Time       `json:"deadline"`
	ErrorCode          *string         `json:"errorCode"`
	Usage              json.RawMessage `json:"usage"`
	CanvasWriterDigest string          `json:"-"`
	RequestHash        string          `json:"-"`
	IdempotencyKey     string          `json:"-"`
	PromptHash         string          `json:"-"`
	PromptSpec         json.RawMessage `json:"-"`
	ToolSchemaHash     string          `json:"-"`
	ProfileVersion     string          `json:"-"`
	Model              string          `json:"-"`
	Effort             string          `json:"-"`
	RuntimeStarted     bool            `json:"-"`
	Checkpoint         json.RawMessage `json:"-"`
	NativeThreadID     string          `json:"-"`
	NativeTurnID       string          `json:"-"`
	LeaseToken         string          `json:"-"`
	LeaseUntil         time.Time       `json:"-"`
	ToolCount          int             `json:"toolCount"`
}

type Event struct {
	RunID      string          `json:"runId"`
	Sequence   string          `json:"sequence"`
	Type       string          `json:"type"`
	Data       json.RawMessage `json:"data"`
	OccurredAt time.Time       `json:"occurredAt"`
}
type EventPage struct {
	Items      []Event `json:"items"`
	NextCursor string  `json:"nextCursor"`
	Terminal   bool    `json:"terminal"`
}
type ToolCall struct {
	RunID, OwnerID, NativeCallID, NativeThreadID, NativeTurnID, Name, Namespace string
	Arguments                                                                   json.RawMessage
	ArgumentHash, RequestHash, OperationKey, State                              string
	Result                                                                      json.RawMessage
	Success                                                                     bool
	Status                                                                      int
}
