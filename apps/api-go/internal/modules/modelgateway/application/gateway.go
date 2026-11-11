// Package application defines the product-facing model boundary. It knows no
// provider SDK, HTTP transport, native session, or database implementation.
package application

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var ErrNotConfigured = errors.New("models router is not configured")

// Actor must come from the verified STUDIO identity, never a browser-supplied ID.
type Actor struct{ SubjectRef string }

type CapabilityQuery struct {
	Kind, Cursor string
	Limit        int
}
type Capability struct {
	Ref, Version, Kind, ExecutionKind, ParameterSchemaVersion  string
	Title                                                      string
	TestMode                                                   bool
	ParameterSchema                                            json.RawMessage
	InputKinds, OutputKinds                                    []string
	SessionMode                                                *string
	SupportsSession, SupportsStream, SupportsCancel, Available bool
	Reason                                                     *string
	Model                                                      *ModelDescriptor
}

// ModelDescriptor is catalog metadata, never a native model name or runtime path.
type ModelDescriptor struct {
	ProviderRef string `json:"providerRef"`
	ModelRef    string `json:"modelRef"`
	Title       string `json:"title"`
	Version     string `json:"version"`
}
type CapabilityPage struct {
	Items      []Capability
	NextCursor *string
}
type Session struct {
	Ref, ConversationRef, State string
	CreatedAt, UpdatedAt        time.Time
	ContextCheckpoint           *string
	RuntimeMetadata             *RuntimeMetadata
}

// RuntimeMetadata carries normalized observations, never native session IDs or
// credentials. It remains nil until a configured adapter can report them.
type RuntimeMetadata struct {
	Usage   *Usage        `json:"usage"`
	Context *ContextUsage `json:"context"`
	Billing *Billing      `json:"billing"`
}
type Usage struct {
	Scope                 string      `json:"scope"`
	Source                string      `json:"source"`
	Coverage              string      `json:"coverage"`
	InputTokens           *int64      `json:"inputTokens"`
	CachedInputTokens     *int64      `json:"cachedInputTokens"`
	CacheWriteInputTokens *int64      `json:"cacheWriteInputTokens"`
	OutputTokens          *int64      `json:"outputTokens"`
	ReasoningOutputTokens *int64      `json:"reasoningOutputTokens"`
	TotalTokens           *int64      `json:"totalTokens"`
	Units                 []UsageUnit `json:"units,omitempty"`
	Status                *string     `json:"status,omitempty"`
	ObservedAt            *time.Time  `json:"observedAt,omitempty"`
}
type UsageUnit struct {
	Unit     string `json:"unit"`
	Quantity string `json:"quantity"`
	Source   string `json:"source"`
}
type ContextUsage struct {
	WindowTokens            *int64     `json:"windowTokens"`
	UsedTokens              *int64     `json:"usedTokens"`
	RemainingTokensEstimate *int64     `json:"remainingTokensEstimate"`
	ReservedOutputTokens    *int64     `json:"reservedOutputTokens"`
	Measurement             string     `json:"measurement"`
	CompactionCount         *int64     `json:"compactionCount"`
	ObservedAt              *time.Time `json:"observedAt"`
}
type Billing struct {
	Mode            string  `json:"mode"`
	Currency        *string `json:"currency"`
	ActualAmount    *string `json:"actualAmount"`
	EstimatedAmount *string `json:"estimatedAmount"`
	PricingRevision *string `json:"pricingRevision"`
}

// Gateway is deliberately limited to the operations enabled in iteration one.
// InvocationGateway is a separate reserved port; native-session import is not enabled.
type Gateway interface {
	Capabilities(context.Context, Actor, CapabilityQuery) (CapabilityPage, error)
	EnsureSession(context.Context, Actor, string) (Session, error)
	Session(context.Context, Actor, string) (Session, error)
}

type Unconfigured struct{}

func (Unconfigured) Capabilities(context.Context, Actor, CapabilityQuery) (CapabilityPage, error) {
	return CapabilityPage{}, ErrNotConfigured
}
func (Unconfigured) EnsureSession(context.Context, Actor, string) (Session, error) {
	return Session{}, ErrNotConfigured
}
func (Unconfigured) Session(context.Context, Actor, string) (Session, error) {
	return Session{}, ErrNotConfigured
}

// Fault contains only normalized diagnostics. Provider messages and credential
// material cannot escape through this application error.
type Fault struct {
	Code, RequestID string
	HTTPStatus      int
	Retryable       bool
}

func (f *Fault) Error() string { return "models router: " + f.Code }
func (f *Fault) Is(target error) bool {
	return target == ErrNotConfigured && f.Code == "ADAPTER_NOT_CONFIGURED"
}
