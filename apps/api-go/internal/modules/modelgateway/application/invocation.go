package application

import (
	"context"
	"encoding/json"
	"time"
)

// InvocationGateway is separated from the read/session gateway. The product
// execution application permits explicit test-mode capabilities only.
// Every access requires the product's verified stable owner, including reads
// and cancellation. Native backend receipts never enter this product boundary.
type InvocationGateway interface {
	Submit(context.Context, Actor, Submission) (Invocation, error)
	Invocation(context.Context, Actor, string) (Invocation, error)
	Cancel(context.Context, Actor, string, CancelRequest) (Invocation, error)
}

// ExecutionGateway imports only actor-scoped, verified Router results.
type ExecutionGateway interface {
	Gateway
	InvocationGateway
	Events(context.Context, Actor, string, string) (EventPage, error)
	ArtifactContent(context.Context, Actor, Artifact) ([]byte, error)
}

type Event struct {
	InvocationRef string          `json:"invocationRef"`
	Sequence      int64           `json:"sequence"`
	Type          string          `json:"type"`
	SchemaVersion string          `json:"schemaVersion"`
	ObservedAt    time.Time       `json:"observedAt"`
	Data          json.RawMessage `json:"data"`
	TestMode      bool            `json:"testMode,omitempty"`
}
type EventPage struct {
	Items           []Event `json:"items"`
	NextCursor      *string `json:"nextCursor"`
	Terminal        bool    `json:"terminal"`
	ProtocolVersion string  `json:"protocolVersion"`
}

// Submission separates the stable transport retry key from normalized input.
// The capability/version's immutable schema validates Parameters before any
// future adapter sends a request. These types do not enable execution by itself.
type Submission struct {
	IdempotencyKey string
	Request        InvocationRequest
}

type InvocationRequest struct {
	SchemaVersion          string              `json:"schemaVersion"`
	OperationRef           string              `json:"operationRef"`
	Capability             CapabilitySelection `json:"capability"`
	SessionRef             *string             `json:"sessionRef,omitempty"`
	Correlation            *Correlation        `json:"correlation,omitempty"`
	Input                  []InputPart         `json:"input"`
	Attachments            []Attachment        `json:"attachments"`
	Parameters             json.RawMessage     `json:"parameters"`
	ParameterSchemaVersion string              `json:"parameterSchemaVersion"`
	ContextSnapshot        json.RawMessage     `json:"contextSnapshot,omitempty"`
	PromptSpec             *PromptSpec         `json:"promptSpec,omitempty"`
}

// PromptSpec is a provider-neutral, product-authored instruction manifest.
// Privileged instructions are assembled in STUDIO, never accepted from the browser.
type PromptSpec struct {
	SchemaVersion   string                `json:"schemaVersion"`
	TemplateRef     string                `json:"templateRef,omitempty"`
	TemplateVersion string                `json:"templateVersion,omitempty"`
	TemplateSHA256  string                `json:"templateSHA256,omitempty"`
	Instructions    []PromptInstruction   `json:"instructions"`
	Messages        []PromptMessage       `json:"messages"`
	Conditioning    []PromptConditioning  `json:"conditioning"`
	OutputContract  *PromptOutputContract `json:"outputContract,omitempty"`
}
type PromptInstruction struct {
	Role string `json:"role"`
	Text string `json:"text"`
}
type PromptMessage struct {
	Role         string `json:"role"`
	InputIndexes []int  `json:"inputIndexes"`
}
type PromptConditioning struct {
	AttachmentRef       string  `json:"attachmentRef"`
	Role                string  `json:"role"`
	TargetAttachmentRef *string `json:"targetAttachmentRef,omitempty"`
}
type PromptOutputContract struct {
	Type          string          `json:"type"`
	SchemaRef     *string         `json:"schemaRef,omitempty"`
	SchemaVersion *string         `json:"schemaVersion,omitempty"`
	Schema        json.RawMessage `json:"schema,omitempty"`
	Strict        *bool           `json:"strict,omitempty"`
}

type CapabilitySelection struct {
	Ref     string `json:"ref"`
	Version string `json:"version"`
}

type Correlation struct {
	ProjectRef      string `json:"projectRef,omitempty"`
	ConversationRef string `json:"conversationRef,omitempty"`
}

// InputPart and OutputPart are contract-discriminated unions. An adapter must
// validate the matching fields, rather than treating this struct as validation.
type InputPart struct {
	Type          string          `json:"type"`
	Text          *string         `json:"text,omitempty"`
	AttachmentRef *string         `json:"attachmentRef,omitempty"`
	SchemaVersion *string         `json:"schemaVersion,omitempty"`
	Data          json.RawMessage `json:"data,omitempty"`
}

// A scoped read grant is required. A source ID alone cannot authorize media,
// and neither an arbitrary input URL nor a runtime file path is accepted.
type Attachment struct {
	Ref           string `json:"ref"`
	SourceRef     string `json:"sourceRef"`
	Kind          string `json:"kind"`
	SourceVersion string `json:"sourceVersion"`
	SHA256        string `json:"sha256"`
	ReadGrantRef  string `json:"readGrantRef"`
}

type Invocation struct {
	TestMode        bool             `json:"testMode,omitempty"`
	Ref             string           `json:"invocationRef"`
	OperationRef    string           `json:"operationRef"`
	SessionRef      *string          `json:"sessionRef"`
	State           string           `json:"state"`
	Progress        *float64         `json:"progress"`
	ProgressDetail  *ProgressDetail  `json:"progressDetail,omitempty"`
	NormalizedError *NormalizedError `json:"normalizedError"`
	OutputParts     []OutputPart     `json:"outputParts"`
	Artifacts       []Artifact       `json:"artifacts"`
	Execution       *Execution       `json:"execution"`
	Usage           *Usage           `json:"usage"`
	Context         *ContextUsage    `json:"context"`
	Billing         *Billing         `json:"billing"`
	CreatedAt       time.Time        `json:"createdAt"`
	UpdatedAt       time.Time        `json:"updatedAt"`
}

// ProgressDetail identifies the measured phase. SAMPLING is local sampler
// progress and never a claim about total wall-clock completion.
type ProgressDetail struct {
	Phase       string `json:"phase"`
	Scope       string `json:"scope"`
	CurrentStep *int   `json:"currentStep,omitempty"`
	TotalSteps  *int   `json:"totalSteps,omitempty"`
}

type OutputPart struct {
	TestMode      bool            `json:"testMode,omitempty"`
	FixtureLabel  string          `json:"fixtureLabel,omitempty"`
	OutputRef     string          `json:"outputRef"`
	Type          string          `json:"type"`
	Text          *string         `json:"text,omitempty"`
	ArtifactRef   *string         `json:"artifactRef,omitempty"`
	SchemaVersion *string         `json:"schemaVersion,omitempty"`
	Data          json.RawMessage `json:"data,omitempty"`
}

// Artifact describes temporary, verified output bytes. STUDIO must import them to
// its own Asset storage for durable history; expiry is not permanent storage.
type Artifact struct {
	TestMode     bool       `json:"testMode,omitempty"`
	FixtureLabel string     `json:"fixtureLabel,omitempty"`
	Ref          string     `json:"artifactRef"`
	OutputRef    string     `json:"outputRef"`
	Kind         *string    `json:"kind,omitempty"`
	MediaType    string     `json:"mediaType"`
	SizeBytes    int64      `json:"sizeBytes"`
	SHA256       string     `json:"sha256"`
	ExpiresAt    *time.Time `json:"expiresAt"`
}

type Execution struct {
	TestMode          bool    `json:"testMode,omitempty"`
	Kind              string  `json:"executionKind"`
	CapabilityRef     string  `json:"capabilityRef"`
	CapabilityVersion string  `json:"capabilityVersion"`
	ModelRef          *string `json:"modelRef"`
	AgentRef          *string `json:"agentRef"`
}

type NormalizedError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type CancelRequest struct {
	Reason string `json:"reason,omitempty"`
}

var _ InvocationGateway = Unconfigured{}

func (Unconfigured) Submit(context.Context, Actor, Submission) (Invocation, error) {
	return Invocation{}, ErrNotConfigured
}

func (Unconfigured) Invocation(context.Context, Actor, string) (Invocation, error) {
	return Invocation{}, ErrNotConfigured
}

func (Unconfigured) Cancel(context.Context, Actor, string, CancelRequest) (Invocation, error) {
	return Invocation{}, ErrNotConfigured
}

func (Unconfigured) Events(context.Context, Actor, string, string) (EventPage, error) {
	return EventPage{}, ErrNotConfigured
}
func (Unconfigured) ArtifactContent(context.Context, Actor, Artifact) ([]byte, error) {
	return nil, ErrNotConfigured
}
