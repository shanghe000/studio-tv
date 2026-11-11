// Package pfhttp is the sole trusted user-Bearer transport for Agent tools.
package pfhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	canvas "studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type Verify func(context.Context, string) (application.Actor, error)
type Executor struct {
	base   *url.URL
	client *http.Client
	verify Verify
}

func New(baseURL string, client *http.Client, verify Verify) (*Executor, error) {
	base, e := url.Parse(baseURL)
	if e != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" || base.Path != "" && base.Path != "/" || verify == nil {
		return nil, errors.New("fixed STUDIO HTTP origin and trusted bearer verifier required")
	}
	if client == nil {
		client = &http.Client{Timeout: 25 * time.Second}
	}
	copy := *client
	copy.Jar = nil
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if copy.Timeout == 0 || copy.Timeout > 30*time.Second {
		copy.Timeout = 25 * time.Second
	}
	return &Executor{base: base, client: &copy, verify: verify}, nil
}
func (e *Executor) Revalidate(ctx context.Context, c application.Credential) error {
	if !time.Now().Before(c.ExpiresAt) {
		return domain.ErrAuth
	}
	actual, err := e.verify(ctx, c.Bearer)
	if err != nil {
		return normalizeVerifyError(err)
	}
	if actual.OwnerID != c.Actor.OwnerID || actual.SessionID != c.Actor.SessionID || !actual.IssuedAt.Equal(c.Actor.IssuedAt) || !actual.AccessExpiresAt.Equal(c.Actor.AccessExpiresAt) || !time.Now().Before(actual.SessionExpiresAt) || !time.Now().Before(actual.AccessExpiresAt) {
		return domain.ErrAuth
	}
	return nil
}

// Verifier errors are normalized without retaining provider or token messages.
func normalizeVerifyError(err error) error {
	var api *httpapi.Error
	if errors.As(err, &api) && (api.Status == 401 || api.Status == 403) {
		return domain.ErrAuth
	}
	if errors.Is(err, domain.ErrAuth) {
		return domain.ErrAuth
	}
	if api != nil {
		return application.NewVerificationFailure(api.Status, api.Code)
	}
	return application.NewVerificationFailure(0, "OTHER")
}

var allowedPath = regexp.MustCompile(`^/api/v2/(projects/[A-Za-z0-9_-]+/(live-snapshot|canvas-commands|canvas-executions)|tasks/[A-Za-z0-9_-]+(/cancel)?|model-capabilities(\?limit=100(&kind=[A-Z][A-Z0-9_]*)?)?)$`)

func (e *Executor) Execute(ctx context.Context, c application.Credential, command application.ToolRequest) (application.ToolResponse, error) {
	if command.WaitSeconds < 0 || command.WaitSeconds > 20 {
		return application.ToolResponse{}, domain.ErrInvalid
	}
	until := time.Now().Add(time.Duration(command.WaitSeconds) * time.Second)
	for {
		response, err := e.executeOnce(ctx, c, command)
		if err != nil {
			return response, err
		}
		if command.WaitSeconds == 0 || command.Method != "GET" || !strings.HasPrefix(command.Path, "/api/v2/tasks/") || response.Status != 200 {
			return response, nil
		}
		var task struct {
			State string `json:"state"`
		}
		if json.Unmarshal(response.Data, &task) != nil || (task.State != "QUEUED" && task.State != "RUNNING") || !time.Now().Before(until) {
			return response, nil
		}
		delay := time.Second
		if remaining := time.Until(until); remaining < delay {
			delay = remaining
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return application.ToolResponse{}, ctx.Err()
		case <-timer.C:
		}
	}
}
func (e *Executor) executeOnce(ctx context.Context, c application.Credential, command application.ToolRequest) (application.ToolResponse, error) {
	if !allowedPath.MatchString(command.Path) || strings.Contains(command.Path, "..") || (command.Method != "GET" && command.Method != "POST") {
		return application.ToolResponse{}, domain.ErrToolRejected
	}
	if err := e.Revalidate(ctx, c); err != nil {
		return application.ToolResponse{}, err
	}
	ref, err := url.Parse(command.Path)
	if err != nil || ref.Host != "" || ref.Scheme != "" {
		return application.ToolResponse{}, domain.ErrToolRejected
	}
	target := e.base.ResolveReference(ref)
	req, err := http.NewRequestWithContext(ctx, command.Method, target.String(), bytes.NewReader(command.Body))
	if err != nil {
		return application.ToolResponse{}, domain.ErrInvalid
	}
	req.Header.Set("Authorization", "Bearer "+c.Bearer)
	req.Header.Set("Accept", "application/json")
	if command.Method == "POST" {
		c.Canvas.ApplyTo(req.Header)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", command.IdempotencyKey)
	}
	if command.ExpectedRevision > 0 {
		req.Header.Set("If-Match", fmt.Sprintf(`"%d"`, command.ExpectedRevision))
	}
	response, err := e.client.Do(req)
	if err != nil {
		return application.ToolResponse{}, domain.ErrUnavailable
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(body) > 4<<20 {
		return application.ToolResponse{}, domain.ErrUnavailable
	}
	result := application.ToolResponse{Status: response.StatusCode}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return application.ToolResponse{}, domain.ErrUnavailable
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
		}
		if json.Unmarshal(body, &failure) != nil || !regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,100}$`).MatchString(failure.Code) {
			return application.ToolResponse{}, domain.ErrUnavailable
		}
		result.ErrorCode = failure.Code
		result.Retryable = failure.Retryable
		result.Data, _ = json.Marshal(map[string]any{"code": failure.Code, "status": response.StatusCode, "retryable": failure.Retryable})
		return result, nil
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil || envelope.Code != 0 || len(envelope.Data) == 0 || !json.Valid(envelope.Data) {
		return application.ToolResponse{}, domain.ErrUnavailable
	}
	if strings.HasSuffix(command.Path, "/live-snapshot") {
		var live struct {
			ProjectID     string          `json:"projectId"`
			GraphRevision int64           `json:"graphRevision"`
			Graph         json.RawMessage `json:"graph"`
			EventCursor   string          `json:"eventCursor"`
		}
		if json.Unmarshal(envelope.Data, &live) != nil {
			return application.ToolResponse{}, domain.ErrUnavailable
		}
		projected, err := canvas.Build(live.ProjectID, live.GraphRevision, live.Graph)
		if err != nil {
			return application.ToolResponse{}, domain.ErrUnavailable
		}
		projected.ToolExecutionAvailable = true
		result.Data, _ = json.Marshal(map[string]any{"canvas": projected, "projectId": live.ProjectID, "graphRevision": live.GraphRevision, "eventCursor": live.EventCursor})
	} else if strings.HasSuffix(command.Path, "/canvas-commands") {
		var receipt map[string]json.RawMessage
		if json.Unmarshal(envelope.Data, &receipt) != nil {
			return application.ToolResponse{}, domain.ErrUnavailable
		}
		safe := map[string]json.RawMessage{}
		for _, key := range []string{"commandId", "projectId", "state", "baseRevision", "graphRevision", "eventCursor", "committedAt"} {
			if value, ok := receipt[key]; ok {
				safe[key] = value
			}
		}
		raw, _ := json.Marshal(safe)
		result.Data = sanitize(raw)
	} else {
		result.Data = sanitize(envelope.Data)
	}
	// Keep native prompt context bounded even if the owned canvas is very large.
	if len(result.Data) > 256<<10 {
		result.Status = 413
		result.ErrorCode = "TOOL_RESULT_TOO_LARGE"
		result.Data = json.RawMessage(`{"code":"TOOL_RESULT_TOO_LARGE","status":413,"retryable":false}`)
	}
	return result, nil
}
func sanitize(raw json.RawMessage) json.RawMessage {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return json.RawMessage(`{"code":"INVALID_TOOL_RESULT"}`)
	}
	var clean func(any) any
	clean = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			out := map[string]any{}
			for k, child := range x {
				normal := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(k, "_", ""), "-", ""))
				switch normal {
				case "xpfcanvasproof", "xpfcanvaslease", "xpfcanvassession", "pageproof", "authorization", "cookie", "accessToken", "accesstoken", "refreshtoken", "token", "nativeThreadId", "nativethreadid", "nativeturnid", "checkpoint", "workspace", "filepath", "path", "url", "downloadurl", "previewurl", "src":
					continue
				}
				out[k] = clean(child)
			}
			return out
		case []any:
			out := make([]any, len(x))
			for i, child := range x {
				out[i] = clean(child)
			}
			return out
		case string:
			value, _ := canvas.SafeContextText(x)
			return value
		default:
			return v
		}
	}
	result, _ := json.Marshal(clean(value))
	return result
}
