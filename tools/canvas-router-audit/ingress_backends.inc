package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"studio.example.invalid/models-router/internal/adapters/codexappserver"
	"studio.example.invalid/models-router/internal/adapters/codexexecution"
	"studio.example.invalid/models-router/internal/adapters/officialvideo"
	"studio.example.invalid/models-router/internal/adapters/postgres"
	"studio.example.invalid/models-router/internal/application"
	"studio.example.invalid/models-router/internal/domain"
	"strings"
	"testing"
	"time"
)

type ingressHTTP func(*http.Request) (*http.Response, error)

func (f ingressHTTP) RoundTrip(q *http.Request) (*http.Response, error) { return f(q) }
func officialIngress(t *testing.T, ctx context.Context, pool *pgxpool.Pool, r application.InvocationRequest, n *int) application.Executor {
	t.Helper()
	actor := domain.Actor{ClientApp: testCredential.ClientApp, SubjectRef: "studio-canvas-audit"}
	vault, err := postgres.NewProviderCredentialVault(pool, bytes.Repeat([]byte{41}, 32))
	if err != nil {
		t.Fatal(err)
	}
	const key = "offline-test-key-not-an-account"
	if _, err = vault.Put(ctx, actor, "volcengine-official", key, ""); err != nil {
		t.Fatal(err)
	}
	e, err := officialvideo.New(officialvideo.Config{Enabled: true}, postgres.NewOfficialVideoStore(pool), ingressMedia{})
	if err != nil {
		t.Fatal(err)
	}
	e.WithProviderCredentials(vault)
	t.Cleanup(e.Close)
	e.CanvasAuditTransport(ingressHTTP(func(q *http.Request) (*http.Response, error) {
		if q.Method != "POST" || q.URL.Host != "ark.cn-beijing.volces.com" || q.URL.Path != "/api/v3/contents/generations/tasks" || q.Header.Get("Authorization") != "Bearer "+key {
			return nil, fmt.Errorf("unexpected vendor request")
		}
		var b struct {
			Model, Ratio, Resolution string
			Duration                 int
			GA                       bool `json:"generate_audio"`
			Last                     bool `json:"return_last_frame"`
			Content                  []struct {
				Type, Role, Text string
				Image            struct{ URL string } `json:"image_url"`
			}
		}
		if err := json.NewDecoder(q.Body).Decode(&b); err != nil {
			return nil, err
		}
		var wantGA, wantLast bool
		json.Unmarshal(r.Parameters["generateAudio"], &wantGA)
		json.Unmarshal(r.Parameters["returnLastFrame"], &wantLast)
		if b.Model != "doubao-seedance-2-5-260628" || b.GA != wantGA || b.Last != wantLast || len(b.Content) != 2 || b.Content[1].Role != "first_frame" {
			return nil, fmt.Errorf("incorrect native Seedance fields")
		}
		auditUserText(t, r, b.Content[0].Text)
		_, enc, ok := strings.Cut(b.Content[1].Image.URL, ",")
		raw, err := base64.StdEncoding.DecodeString(enc)
		if !ok || err != nil || auditSHA(raw) != r.Attachments[0].SHA256 {
			return nil, fmt.Errorf("native first frame changed")
		}
		*n++
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"id":"offline-provider-task"}`))}, nil
	}))
	return e
}

type ingressNativeRPC struct {
	t       *testing.T
	request application.InvocationRequest
	turns   *int
	scope   application.InvocationScope
	sent    bool
	history []string
}

func (p *ingressNativeRPC) Acquire(_ context.Context, scope application.InvocationScope) (codexappserver.RuntimeBinding, error) {
	return codexappserver.RuntimeBinding{Owner: scope.Actor, Workspace: "/isolated", IsolationRef: "canvas-test", Model: "gpt-6.1-sol", RPC: p}, nil
}
func (p *ingressNativeRPC) Release(application.InvocationScope) error { return nil }
func (p *ingressNativeRPC) Bind(s application.InvocationScope) error  { p.scope = s; return nil }
func (p *ingressNativeRPC) Initialize(context.Context) error          { return nil }
func ingressTurn() map[string]any {
	return map[string]any{"id": "offline-turn", "status": "completed", "itemsView": "full", "items": []any{map[string]any{"id": "message-1", "type": "agentMessage", "phase": "final_answer", "text": "isolated model reply"}}}
}
func (p *ingressNativeRPC) Next(ctx context.Context) (codexappserver.Notification, error) {
	if p.sent {
		select {
		case <-ctx.Done():
			return codexappserver.Notification{}, ctx.Err()
		}
	}
	p.sent = true
	body, _ := json.Marshal(map[string]any{"threadId": "offline-thread", "turn": ingressTurn()})
	return codexappserver.Notification{StreamRef: "offline-native", Sequence: 1, Method: "turn/completed", Params: body}, nil
}
func (p *ingressNativeRPC) Call(_ context.Context, method string, params, result any) error {
	var reply any
	switch method {
	case "thread/start":
		raw, _ := json.Marshal(params)
		var v struct{ Model string }
		json.Unmarshal(raw, &v)
		if v.Model != "gpt-6.1-sol" {
			return fmt.Errorf("unexpected native model")
		}
		reply = map[string]any{"thread": map[string]any{"id": "offline-thread"}, "cwd": "/isolated", "model": v.Model}
	case "thread/inject_items":
		raw, _ := json.Marshal(params)
		var seed struct {
			Items []struct{ Content []struct{ Type, Text string } }
		}
		if err := json.Unmarshal(raw, &seed); err != nil {
			return err
		}
		for _, item := range seed.Items {
			for _, part := range item.Content {
				if part.Type == "input_text" || part.Type == "output_text" {
					p.history = append(p.history, part.Text)
				}
			}
		}
		reply = map[string]any{}
	case "turn/start":
		raw, _ := json.Marshal(params)
		var turn struct {
			Effort string
			Input  []struct{ Type, Text string }
		}
		json.Unmarshal(raw, &turn)
		var effort string
		json.Unmarshal(p.request.Parameters["reasoningEffort"], &effort)
		if effort == "" || turn.Effort != effort {
			return fmt.Errorf("wrong native effort")
		}
		parts := append([]string(nil), p.history...)
		for _, item := range turn.Input {
			parts = append(parts, item.Text)
		}
		auditUserText(p.t, p.request, strings.Join(parts, "\n"))
		*p.turns++
		reply = map[string]any{"turn": map[string]any{"id": "offline-turn", "status": "inProgress"}}
	case "thread/read":
		reply = map[string]any{"thread": map[string]any{"id": "offline-thread", "turns": []any{ingressTurn()}}}
	default:
		return fmt.Errorf("unexpected RPC method %s", method)
	}
	raw, _ := json.Marshal(reply)
	return json.Unmarshal(raw, result)
}
func codexIngress(t *testing.T, pool *pgxpool.Pool, r application.InvocationRequest, n *int) application.Executor {
	t.Helper()
	rpc := &ingressNativeRPC{t: t, request: r, turns: n}
	store := postgres.NewCodexPrivateStore(pool)
	adapter, err := codexappserver.New(codexappserver.Config{CapabilityRef: r.Capability.Ref, CapabilityVersion: "2", ParameterSchemaVersion: "2", ParameterSchema: codexexecution.ReasoningParameterSchema(), DefaultReasoningEffort: "low"}, rpc, store, nil)
	if err != nil {
		t.Fatal(err)
	}
	executor, err := codexexecution.NewModelWithReasoning(adapter, nil, store, rpc, codexexecution.Config{ExecutionTimeout: 3 * time.Second}, domain.ModelDescriptor{ProviderRef: "codex", ModelRef: "codex-6-1", Title: "Codex 6.1", Version: "6.1"}, false)
	if err != nil {
		t.Fatal(err)
	}
	return executor
}
