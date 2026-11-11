// Package router implements the application gateway using Router protocol v1.
package router

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

var refPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$`)
var sessionPattern = regexp.MustCompile(`^sess_[A-Za-z0-9_-]{32}$`)
var codePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,79}$`)

type Config struct {
	BaseURL, ClientApp, ServiceToken string
	SigningKey                       []byte
	Timeout                          time.Duration
	Transport                        http.RoundTripper
}
type Client struct {
	baseURL, clientApp, token string
	key                       []byte
	http                      *http.Client
}

func New(cfg Config) (*Client, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || u.Opaque != "" {
		return nil, errors.New("invalid models router origin")
	}
	if !refPattern.MatchString(cfg.ClientApp) || len(cfg.ServiceToken) < 32 || strings.ContainsAny(cfg.ServiceToken, "\r\n\t ") || len(cfg.SigningKey) < 32 {
		return nil, errors.New("invalid models router service credentials")
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Second
	}
	if cfg.Timeout < 0 {
		return nil, errors.New("invalid models router timeout")
	}
	return &Client{baseURL: strings.TrimRight(cfg.BaseURL, "/"), clientApp: cfg.ClientApp, token: cfg.ServiceToken, key: append([]byte(nil), cfg.SigningKey...), http: &http.Client{
		Timeout: cfg.Timeout, Transport: cfg.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

type sessionDTO struct {
	Ref               string                       `json:"sessionRef"`
	ConversationRef   string                       `json:"conversationRef"`
	State             string                       `json:"state"`
	CreatedAt         time.Time                    `json:"createdAt"`
	UpdatedAt         time.Time                    `json:"updatedAt"`
	ContextCheckpoint *string                      `json:"contextCheckpoint"`
	RuntimeMetadata   *application.RuntimeMetadata `json:"runtimeMetadata"`
}

func (s sessionDTO) product() application.Session {
	return application.Session{Ref: s.Ref, ConversationRef: s.ConversationRef, State: s.State, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt, ContextCheckpoint: s.ContextCheckpoint, RuntimeMetadata: s.RuntimeMetadata}
}
func (s sessionDTO) valid() bool {
	return sessionPattern.MatchString(s.Ref) && refPattern.MatchString(s.ConversationRef) && s.State == "OPEN" && !s.CreatedAt.IsZero() && !s.UpdatedAt.Before(s.CreatedAt)
}

func (c *Client) EnsureSession(ctx context.Context, actor application.Actor, conversation string) (application.Session, error) {
	if !refPattern.MatchString(conversation) {
		return application.Session{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	body, _ := json.Marshal(struct {
		ConversationRef string `json:"conversationRef"`
	}{conversation})
	var dto sessionDTO
	if err := c.do(ctx, actor, http.MethodPost, "/v1/sessions", body, &dto); err != nil {
		return application.Session{}, err
	}
	if !dto.valid() || dto.ConversationRef != conversation {
		return application.Session{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return dto.product(), nil
}
func (c *Client) Session(ctx context.Context, actor application.Actor, ref string) (application.Session, error) {
	if !sessionPattern.MatchString(ref) {
		return application.Session{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	var dto sessionDTO
	if err := c.do(ctx, actor, http.MethodGet, "/v1/sessions/"+ref, nil, &dto); err != nil {
		return application.Session{}, err
	}
	if !dto.valid() || dto.Ref != ref {
		return application.Session{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return dto.product(), nil
}

type capabilityDTO struct {
	Title                  string                       `json:"title,omitempty"`
	TestMode               bool                         `json:"testMode,omitempty"`
	Ref                    string                       `json:"capabilityRef"`
	Version                string                       `json:"version"`
	Kind                   string                       `json:"kind"`
	ExecutionKind          string                       `json:"executionKind"`
	ParameterSchemaVersion string                       `json:"parameterSchemaVersion"`
	ParameterSchema        json.RawMessage              `json:"parameterSchema"`
	InputKinds             []string                     `json:"inputKinds"`
	OutputKinds            []string                     `json:"outputKinds"`
	SupportsSession        bool                         `json:"supportsSession"`
	SessionMode            *string                      `json:"sessionMode"`
	SupportsStream         bool                         `json:"supportsStream"`
	SupportsCancel         bool                         `json:"supportsCancel"`
	Available              bool                         `json:"available"`
	Reason                 *string                      `json:"reason"`
	Model                  *application.ModelDescriptor `json:"model,omitempty"`
}

func (c *Client) Capabilities(ctx context.Context, actor application.Actor, q application.CapabilityQuery) (application.CapabilityPage, error) {
	if q.Limit == 0 {
		q.Limit = 100
	}
	if q.Limit < 1 || q.Limit > 100 {
		return application.CapabilityPage{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	values := url.Values{}
	values.Set("limit", strconv.Itoa(q.Limit))
	if q.Kind != "" {
		values.Set("kind", q.Kind)
	}
	if q.Cursor != "" {
		values.Set("cursor", q.Cursor)
	}
	var dto struct {
		Items           []capabilityDTO `json:"items"`
		NextCursor      *string         `json:"nextCursor"`
		ProtocolVersion string          `json:"protocolVersion"`
	}
	if err := c.do(ctx, actor, http.MethodGet, "/v1/capabilities?"+values.Encode(), nil, &dto); err != nil {
		return application.CapabilityPage{}, err
	}
	if dto.ProtocolVersion != "1" || dto.Items == nil {
		return application.CapabilityPage{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	result := application.CapabilityPage{Items: make([]application.Capability, 0, len(dto.Items)), NextCursor: dto.NextCursor}
	for _, item := range dto.Items {
		if item.Model != nil && (!refPattern.MatchString(item.Model.ProviderRef) || !refPattern.MatchString(item.Model.ModelRef) || item.Model.Title == "" || len(item.Model.Title) > 200 || item.Model.Version == "" || len(item.Model.Version) > 100 || strings.ContainsAny(item.Model.Title+item.Model.Version, "\x00\r\n")) {
			return application.CapabilityPage{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		var parameterSchema map[string]any
		if !refPattern.MatchString(item.Ref) || item.Version == "" || item.ParameterSchemaVersion == "" || json.Unmarshal(item.ParameterSchema, &parameterSchema) != nil || parameterSchema == nil || item.InputKinds == nil || item.OutputKinds == nil {
			return application.CapabilityPage{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		if item.ExecutionKind != "MODEL" && item.ExecutionKind != "AGENT" {
			return application.CapabilityPage{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		if item.SessionMode != nil {
			mode := *item.SessionMode
			expectsSessionSupport := mode != "NONE"
			if (mode != "NONE" && mode != "OPTIONAL" && mode != "REQUIRED") || expectsSessionSupport != item.SupportsSession {
				return application.CapabilityPage{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
			}
		}
		result.Items = append(result.Items, application.Capability{Title: item.Title, TestMode: item.TestMode, Ref: item.Ref, Version: item.Version, Kind: item.Kind, ExecutionKind: item.ExecutionKind, ParameterSchemaVersion: item.ParameterSchemaVersion, ParameterSchema: item.ParameterSchema, InputKinds: item.InputKinds, OutputKinds: item.OutputKinds, SupportsSession: item.SupportsSession, SessionMode: item.SessionMode, SupportsStream: item.SupportsStream, SupportsCancel: item.SupportsCancel, Available: item.Available, Reason: item.Reason, Model: item.Model})
	}
	return result, nil
}

func (c *Client) do(ctx context.Context, actor application.Actor, method, target string, body []byte, out any) error {
	return c.doHeaders(ctx, actor, method, target, body, out, nil, false)
}
func (c *Client) doHeaders(ctx context.Context, actor application.Actor, method, target string, body []byte, out any, headers http.Header, accepted bool) error {
	return c.doHeadersLimit(ctx, actor, method, target, body, out, headers, accepted, 2<<20)
}
func (c *Client) doHeadersLimit(ctx context.Context, actor application.Actor, method, target string, body []byte, out any, headers http.Header, accepted bool, maxResponse int64) error {
	if !refPattern.MatchString(actor.SubjectRef) {
		return &application.Fault{Code: "INVALID_ACTOR"}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+target, bytes.NewReader(body))
	if err != nil {
		return &application.Fault{Code: "INVALID_REQUEST"}
	}
	var random [18]byte
	if _, err = rand.Read(random[:]); err != nil {
		return &application.Fault{Code: "GATEWAY_UNAVAILABLE", Retryable: true}
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := base64.RawURLEncoding.EncodeToString(random[:])
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Router-Client-App", c.clientApp)
	req.Header.Set("X-Router-Subject-Ref", actor.SubjectRef)
	req.Header.Set("X-Router-Actor-Timestamp", timestamp)
	req.Header.Set("X-Router-Actor-Nonce", nonce)
	req.Header.Set("X-Router-Actor-Signature", proofSignature(c.key, method, req.URL.RequestURI(), c.clientApp, actor.SubjectRef, timestamp, nonce, body, headers.Get("Idempotency-Key")))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Models-Router-Features", "progress-detail-v1")
	for k, vs := range headers {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &application.Fault{Code: "GATEWAY_UNAVAILABLE", Retryable: true}
	}
	defer response.Body.Close()
	media, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || media != "application/json" || response.Header.Get("X-Models-Router-Version") != "1" {
		return &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil {
		return &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	if int64(len(data)) > maxResponse {
		if maxResponse > 2<<20 {
			return &application.Fault{Code: "LONGFORM_STATE_TOO_LARGE"}
		}
		return &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var envelope struct {
			Error struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			} `json:"error"`
			RequestID       string `json:"requestId"`
			ProtocolVersion string `json:"protocolVersion"`
		}
		if json.Unmarshal(data, &envelope) != nil || envelope.ProtocolVersion != "1" || !codePattern.MatchString(envelope.Error.Code) {
			return &application.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		return &application.Fault{Code: envelope.Error.Code, HTTPStatus: response.StatusCode, Retryable: envelope.Error.Retryable, RequestID: envelope.RequestID}
	}
	if response.StatusCode != http.StatusOK && !(method == http.MethodPost && (response.StatusCode == http.StatusCreated || (accepted && response.StatusCode == http.StatusAccepted))) {
		return &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	if json.Unmarshal(data, out) != nil {
		return &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return nil
}

var _ application.Gateway = (*Client)(nil)

func proofSignature(key []byte, method, target, app, subject, timestamp, nonce string, body []byte, idempotency ...string) string {
	hash := sha256.Sum256(body)
	keyRef := ""
	if len(idempotency) > 0 {
		keyRef = idempotency[0]
	}
	canonical := strings.Join([]string{"models-router.actor.v1", method, target, app, subject, timestamp, nonce, hex.EncodeToString(hash[:]), keyRef}, "\n")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(canonical))
	return "v1=" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
