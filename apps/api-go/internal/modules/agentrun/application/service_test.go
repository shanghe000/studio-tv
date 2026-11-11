package application

import (
	"context"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type brokerStore struct {
	Store
	mu               sync.Mutex
	run              domain.Run
	call             domain.ToolCall
	begun, completed int
	paused           chan struct{}
	once             sync.Once
	finishState      domain.State
}

func (s *brokerStore) BeginTool(_ context.Context, r domain.Run, c domain.ToolCall, _ int) (domain.ToolCall, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.begun++
	if s.call.NativeCallID != "" {
		if s.call.ArgumentHash != c.ArgumentHash || s.call.RequestHash != c.RequestHash {
			return domain.ToolCall{}, domain.ErrConflict
		}
		return s.call, nil
	}
	s.call = c
	return c, nil
}
func (s *brokerStore) CompleteTool(_ context.Context, _ domain.Run, _ domain.ToolCall, response ToolResponse) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed++
	s.call.State = "SUCCEEDED"
	s.call.Success = true
	s.call.Result = response.Data
	return nil
}
func (s *brokerStore) ToolReceipt(_ context.Context, _ domain.Run, c domain.ToolCall) (domain.ToolCall, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.call.State != "SUCCEEDED" || s.call.NativeCallID != c.NativeCallID || s.call.ArgumentHash != c.ArgumentHash || s.call.RequestHash != c.RequestHash {
		return domain.ToolCall{}, domain.ErrNotFound
	}
	return s.call, nil
}
func (s *brokerStore) PauseAuth(context.Context, string, string, string) error {
	s.once.Do(func() { close(s.paused) })
	return nil
}
func (s *brokerStore) History(context.Context, domain.Run) ([]RuntimeMessage, error) {
	return []RuntimeMessage{{Role: "USER", Text: "Hello"}}, nil
}
func (s *brokerStore) Finish(_ context.Context, _ domain.Run, state domain.State, _ string, _ RuntimeResult) error {
	s.finishState = state
	return nil
}

type brokerExecutor struct{ calls, checks atomic.Int32 }

func (e *brokerExecutor) Revalidate(_ context.Context, c Credential) error {
	e.checks.Add(1)
	if c.Bearer != "current-token" {
		return domain.ErrAuth
	}
	return nil
}
func (e *brokerExecutor) Execute(_ context.Context, _ Credential, _ ToolRequest) (ToolResponse, error) {
	e.calls.Add(1)
	return ToolResponse{Status: 200, Data: json.RawMessage(`{"graphRevision":1}`)}, nil
}

type testRuntime struct{ calls atomic.Int32 }

func (r *testRuntime) Available() bool { return true }
func (r *testRuntime) Models(context.Context) ([]Model, error) {
	return []Model{{ID: "gpt-6.1-sol", Efforts: []string{"low", "high"}, Available: true}}, nil
}
func (r *testRuntime) Run(context.Context, RuntimeRequest, ToolHandler) (RuntimeResult, error) {
	r.calls.Add(1)
	return RuntimeResult{Text: "Done", TerminalVerified: true}, nil
}
func testService(t *testing.T) (*Service, *brokerStore, *brokerExecutor, domain.Run) {
	t.Helper()
	spec := &gateway.PromptSpec{TemplateSHA256: "frozen-hash", Instructions: []gateway.PromptInstruction{{Role: "SYSTEM", Text: "STUDIO"}}}
	raw, _ := json.Marshal(spec)
	run := domain.Run{ID: "agr_test", OwnerID: "a", ParentSessionID: "sid", ProjectID: "p", ConversationID: "cid", LeaseToken: "lease", State: domain.Running, NativeThreadID: "thread", NativeTurnID: "turn", Deadline: time.Now().Add(time.Minute), PromptHash: "frozen-hash", PromptSpec: raw, ToolSchemaHash: SchemaHash(), ProfileVersion: ProfileVersion}
	store := &brokerStore{run: run, paused: make(chan struct{})}
	exec := &brokerExecutor{}
	s, e := New(store, &testRuntime{}, exec, Config{PromptSpec: spec})
	if e != nil {
		t.Fatal(e)
	}
	return s, store, exec, run
}
func putCredential(s *Service, run domain.Run, token string) {
	s.mu.Lock()
	s.credentials[run.ID] = credentialEntry{credential: Credential{Actor: Actor{OwnerID: run.OwnerID, SessionID: run.ParentSessionID}, Bearer: token, ExpiresAt: time.Now().Add(time.Minute)}}
	s.mu.Unlock()
}
func TestBrokerWaitsForPrivateCurrentCredentialWithoutRestartOrSideEffect(t *testing.T) {
	s, store, exec, run := testService(t)
	putCredential(s, run, "expired-token")
	b := &broker{s: s, run: run}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	call := RuntimeToolCall{ThreadID: "thread", TurnID: "turn", CallID: "call", Name: "studio_canvas_read", Arguments: json.RawMessage(`{}`)}
	go func() {
		out, e := b.HandleTool(ctx, call)
		if e == nil && !out.Success {
			e = errors.New("tool receipt unsuccessful")
		}
		result <- e
	}()
	select {
	case <-store.paused:
	case <-ctx.Done():
		t.Fatal("run did not enter waiting auth")
	}
	if exec.calls.Load() != 0 {
		t.Fatal("executed tool with expired credential")
	}
	putCredential(s, run, "current-token")
	if e := <-result; e != nil {
		t.Fatal(e)
	}
	if exec.calls.Load() != 1 || store.completed != 1 {
		t.Fatal("did not resume exact native callback")
	}
	if _, e := b.HandleTool(ctx, call); e != nil || exec.calls.Load() != 1 {
		t.Fatal("same call executed twice", e)
	}
	checks := exec.checks.Load()
	if _, e := b.VerifyToolReceipt(ctx, call); e != nil || exec.calls.Load() != 1 || exec.checks.Load() <= checks {
		t.Fatal("durable verifier mutated or skipped reauth", e)
	}
	call.CallID = "missing"
	if _, e := b.VerifyToolReceipt(ctx, call); e == nil || store.begun != 2 {
		t.Fatal("receipt verifier registered missing call", e)
	}
}
func TestBrokerRejectsNativeOriginSpoofBeforeStoreOrHTTP(t *testing.T) {
	s, store, exec, run := testService(t)
	putCredential(s, run, "current-token")
	b := &broker{s: s, run: run}
	for _, call := range []RuntimeToolCall{{ThreadID: "other", TurnID: "turn", CallID: "x", Name: "studio_canvas_read", Arguments: json.RawMessage(`{}`)}, {ThreadID: "thread", TurnID: "other", CallID: "x", Name: "studio_canvas_read", Arguments: json.RawMessage(`{}`)}, {ThreadID: "thread", TurnID: "turn", CallID: "x", Name: "studio_canvas_read", Namespace: "foreign", Arguments: json.RawMessage(`{}`)}} {
		if _, e := b.HandleTool(context.Background(), call); !errors.Is(e, domain.ErrToolRejected) {
			t.Fatal("spoof accepted", e)
		}
	}
	if store.begun != 0 || exec.calls.Load() != 0 {
		t.Fatal("spoof reached mutation boundary")
	}
}
func TestRuntimeStartedWithoutCheckpointNeverStartsAnotherTurn(t *testing.T) {
	s, store, _, run := testService(t)
	putCredential(s, run, "current-token")
	run.RuntimeStarted = true
	s.execute(context.Background(), run)
	if s.runtime.(*testRuntime).calls.Load() != 0 || store.finishState != domain.Unknown {
		t.Fatal("unknown native acceptance caused resubmission", store.finishState)
	}
}

type uncertainExecutor struct{ brokerExecutor }

func (e *uncertainExecutor) Execute(context.Context, Credential, ToolRequest) (ToolResponse, error) {
	e.calls.Add(1)
	return ToolResponse{Status: 503, Data: json.RawMessage(`{"code":"STORE_UNAVAILABLE"}`)}, nil
}
func TestUnknownWriteResponseRetainsPendingKeyWithoutFailureReceiptOrRetry(t *testing.T) {
	s, store, _, run := testService(t)
	executor := &uncertainExecutor{}
	s.executor = executor
	putCredential(s, run, "current-token")
	b := &broker{s: s, run: run}
	_, err := b.HandleTool(context.Background(), RuntimeToolCall{ThreadID: "thread", TurnID: "turn", CallID: "call", Name: "studio_node_run", Arguments: json.RawMessage(`{"nodeId":"n","expectedRevision":1}`)})
	if !errors.Is(err, domain.ErrUnavailable) || store.completed != 0 || store.call.State != "PENDING" || executor.calls.Load() != 1 {
		t.Fatal("unknown HTTP acceptance became retryable tool failure", err, store.completed, store.call.State, executor.calls.Load())
	}
}
