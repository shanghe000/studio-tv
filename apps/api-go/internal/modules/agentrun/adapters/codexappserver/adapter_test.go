package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	app "studiotv.local/service/api/internal/modules/agentrun/application"
)

type fixtureHandler struct {
	mu           sync.Mutex
	calls        int
	checkpoints  []json.RawMessage
	thread, turn string
}

func (h *fixtureHandler) Bind(_ context.Context, thread, turn string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.thread = thread
	h.turn = turn
	return nil
}
func (h *fixtureHandler) SaveCheckpoint(_ context.Context, raw json.RawMessage) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.checkpoints = append(h.checkpoints, append(json.RawMessage(nil), raw...))
	return nil
}
func (h *fixtureHandler) HandleTool(_ context.Context, c app.RuntimeToolCall) (app.RuntimeToolResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.ThreadID != h.thread || c.TurnID != h.turn {
		return app.RuntimeToolResult{}, ErrProtocol
	}
	h.calls++
	return app.RuntimeToolResult{Success: true, Output: json.RawMessage(`{"revision":1}`)}, nil
}

type fixtureFrames struct {
	frames  chan json.RawMessage
	closed  chan struct{}
	once    sync.Once
	mu      sync.Mutex
	methods []string
	onSend  func(map[string]json.RawMessage)
}

func newFixture() *fixtureFrames {
	return &fixtureFrames{frames: make(chan json.RawMessage, 32), closed: make(chan struct{})}
}
func (f *fixtureFrames) push(v any) {
	raw, _ := json.Marshal(v)
	select {
	case f.frames <- raw:
	case <-f.closed:
	}
}
func (f *fixtureFrames) Send(_ context.Context, raw json.RawMessage) error {
	var v map[string]json.RawMessage
	if json.Unmarshal(raw, &v) != nil {
		return ErrProtocol
	}
	var method string
	_ = json.Unmarshal(v["method"], &method)
	f.mu.Lock()
	f.methods = append(f.methods, method)
	f.mu.Unlock()
	if f.onSend != nil {
		f.onSend(v)
	}
	return nil
}
func (f *fixtureFrames) Receive(ctx context.Context) (json.RawMessage, error) {
	select {
	case raw := <-f.frames:
		return raw, nil
	case <-f.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (f *fixtureFrames) Close() error { f.once.Do(func() { close(f.closed) }); return nil }
func fixtureRequest() app.RuntimeRequest {
	tools := []app.ToolDefinition{{Name: "studio_canvas_read", Description: "fixture read", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`), OperationID: "readFixture", Version: "1"}}
	return app.RuntimeRequest{RunID: "run_fixture", OwnerID: "owner_fixture", ConversationID: "conversation_fixture", Model: "gpt-6.1-sol", Effort: "low", BaseInstructions: "STUDIO trusted fixture policy", Instructions: "Use only the supplied STUDIO tools.", Messages: []app.RuntimeMessage{{Role: "USER", Text: "Read the fixture canvas."}}, Tools: tools, PromptHash: "prompt-fixture", ToolSchemaHash: digest(tools), ProfileVersion: ProfileVersion}
}
func fixtureAdapter(f *fixtureFrames) *Adapter {
	a := New(Config{Enabled: true, ProfileValidated: true, SocketPath: "/private/fixture.sock", Models: []app.Model{{ID: "gpt-6.1-sol", Efforts: []string{"low", "high"}, DefaultEffort: "low", Available: true}}})
	a.open = func(context.Context, app.RuntimeRequest) (Frames, error) { return f, nil }
	return a
}
func threadResult() any {
	return map[string]any{"thread": map[string]any{"id": "native_thread", "cliVersion": RuntimeVersion, "cwd": Workspace, "historyMode": HistoryMode}, "model": "gpt-6.1-sol", "reasoningEffort": "low", "cwd": Workspace, "approvalPolicy": "never", "sandbox": map[string]any{"type": "readOnly"}, "instructionSources": []any{}}
}
func toolItem(success bool) map[string]any {
	return map[string]any{"id": "native_call", "type": "dynamicToolCall", "tool": "studio_canvas_read", "namespace": nil, "arguments": map[string]any{}, "status": "completed", "success": success, "contentItems": []any{map[string]any{"type": "inputText", "text": "{\"revision\":1}"}}}
}
func snapshot(items ...any) any {
	return map[string]any{"thread": map[string]any{"id": "native_thread", "cliVersion": RuntimeVersion, "cwd": Workspace, "historyMode": HistoryMode, "turns": []any{map[string]any{"id": "native_turn", "status": "completed", "itemsView": "full", "items": items}}}}
}
func reply(f *fixtureFrames, id json.RawMessage, result any) {
	f.push(map[string]any{"id": id, "result": result})
}
func replySnapshot(f *fixtureFrames, v map[string]json.RawMessage, snap any) {
	var method string
	_ = json.Unmarshal(v["method"], &method)
	var decoded struct {
		Thread nativeThread `json:"thread"`
	}
	raw, _ := json.Marshal(snap)
	_ = json.Unmarshal(raw, &decoded)
	switch method {
	case "thread/turns/list":
		reply(f, v["id"], map[string]any{"data": decoded.Thread.Turns, "nextCursor": nil})
	case "thread/items/list":
		f.push(map[string]any{"id": v["id"], "error": map[string]any{"code": -32601, "message": "fixture unavailable"}})
	default:
		reply(f, v["id"], snap)
	}
}

func TestDirectLoopRequiresActualToolAndFullSnapshot(t *testing.T) {
	f := newFixture()
	h := &fixtureHandler{}
	r := fixtureRequest()
	final := map[string]any{"id": "native_final", "type": "agentMessage", "text": "Fixture revision 1.", "phase": "final_answer"}
	f.onSend = func(v map[string]json.RawMessage) {
		var method string
		_ = json.Unmarshal(v["method"], &method)
		switch method {
		case "initialize":
			reply(f, v["id"], map[string]any{"userAgent": "fixture/" + RuntimeVersion})
		case "thread/start":
			var p struct {
				Approval string         `json:"approvalPolicy"`
				Sandbox  string         `json:"sandbox"`
				Config   map[string]any `json:"config"`
				History  string         `json:"historyMode"`
				Dynamic  []any          `json:"dynamicTools"`
			}
			_ = json.Unmarshal(v["params"], &p)
			if p.History != HistoryMode || p.Approval != "never" || p.Sandbox != "read-only" || p.Config["features.code_mode_host"] != true || p.Config["features.code_mode"] != false || p.Config["features.shell_tool"] != false || p.Config["features.unified_exec"] != false || p.Config["features.browser_use"] != false || p.Config["features.multi_agent"] != false || len(p.Dynamic) != 1 {
				t.Error("unsafe native profile")
			}
			reply(f, v["id"], threadResult())
		case "turn/start":
			h.mu.Lock()
			if len(h.checkpoints) == 0 {
				t.Error("submission was not durably fenced")
			}
			h.mu.Unlock()
			// Native callback may precede the RPC response; it must wait for trusted Bind.
			f.push(map[string]any{"id": 77, "method": "item/tool/call", "params": map[string]any{"threadId": "native_thread", "turnId": "native_turn", "callId": "native_call", "tool": "studio_canvas_read", "arguments": map[string]any{}}})
			reply(f, v["id"], map[string]any{"turn": map[string]any{"id": "native_turn", "status": "inProgress", "items": []any{}}})
		case "thread/read", "thread/turns/list":
			replySnapshot(f, v, snapshot(toolItem(true), final))
		default:
			if string(v["id"]) == "77" {
				f.push(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "native_thread", "turnId": "native_turn", "item": final}})
				f.push(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "native_thread", "turn": map[string]any{"id": "native_turn", "status": "completed", "items": []any{}}}})
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := fixtureAdapter(f).Run(ctx, r, h)
	if err != nil || !result.TerminalVerified || result.Text != "Fixture revision 1." {
		t.Fatalf("unexpected safe result: verified=%v err=%v", result.TerminalVerified, err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.calls != 1 || len(h.checkpoints) != 4 {
		t.Fatalf("calls=%d checkpoints=%d", h.calls, len(h.checkpoints))
	}
}

func TestCallbacksRejectForeignIdentityAndNamespace(t *testing.T) {
	for _, field := range []string{"threadId", "turnId", "tool", "namespace"} {
		t.Run(field, func(t *testing.T) {
			f := newFixture()
			tr := newTransport(f)
			defer tr.close()
			r := fixtureRequest()
			h := &fixtureHandler{}
			_ = h.Bind(context.Background(), "native_thread", "native_turn")
			c := checkpoint{HistoryMode: HistoryMode, ThreadID: "native_thread", TurnID: "native_turn", Calls: map[string]callEvidence{}}
			p := map[string]any{"threadId": "native_thread", "turnId": "native_turn", "callId": "native_call", "tool": "studio_canvas_read", "arguments": map[string]any{}}
			p[field] = "foreign"
			raw, _ := json.Marshal(p)
			err := executeTool(context.Background(), tr, r, &c, &sync.Mutex{}, h, serverRequest{json.RawMessage(`77`), raw}, 32)
			if !errors.Is(err, ErrProfile) || h.calls != 0 {
				t.Fatalf("invalid callback executed: calls=%d err=%v", h.calls, err)
			}
		})
	}
}
func TestDuplicateCallFrozenArgumentsAndReceipt(t *testing.T) {
	f := newFixture()
	tr := newTransport(f)
	defer tr.close()
	r := fixtureRequest()
	h := &fixtureHandler{}
	_ = h.Bind(context.Background(), "native_thread", "native_turn")
	c := checkpoint{HistoryMode: HistoryMode, ThreadID: "native_thread", TurnID: "native_turn", Calls: map[string]callEvidence{}}
	raw := json.RawMessage(`{"threadId":"native_thread","turnId":"native_turn","callId":"native_call","tool":"studio_canvas_read","arguments":{}}`)
	req := serverRequest{json.RawMessage(`77`), raw}
	mu := &sync.Mutex{}
	if executeTool(context.Background(), tr, r, &c, mu, h, req, 32) != nil || executeTool(context.Background(), tr, r, &c, mu, h, req, 32) != nil || h.calls != 1 {
		t.Fatal("replay did not reuse frozen receipt")
	}
	req.params = json.RawMessage(`{"threadId":"native_thread","turnId":"native_turn","callId":"native_call","tool":"studio_canvas_read","arguments":{"unexpected":1}}`)
	if !errors.Is(executeTool(context.Background(), tr, r, &c, mu, h, req, 32), ErrProfile) || h.calls != 1 {
		t.Fatal("altered replay accepted")
	}
}
func TestFullSnapshotCannotInventSuccessfulTools(t *testing.T) {
	for _, kind := range []string{"missing_receipt", "changed_result", "native_shell", "summary"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture()
			tr := newTransport(f)
			defer tr.close()
			c := checkpoint{HistoryMode: HistoryMode, ThreadID: "native_thread", TurnID: "native_turn", Calls: map[string]callEvidence{}}
			if kind != "missing_receipt" {
				c.Calls["native_call"] = callEvidence{Name: "studio_canvas_read", ArgumentsHash: argumentDigest(json.RawMessage(`{}`)), Success: true, Output: json.RawMessage(`{"revision":1}`)}
			}
			final := map[string]any{"id": "native_final", "type": "agentMessage", "text": "Claimed success"}
			item := toolItem(true)
			if kind == "changed_result" {
				item["success"] = false
			}
			items := []any{item, final}
			if kind == "native_shell" {
				items = append(items, map[string]any{"id": "shell", "type": "commandExecution"})
			}
			snap := snapshot(items...)
			if kind == "summary" {
				snap = map[string]any{"thread": map[string]any{"id": "native_thread", "cliVersion": RuntimeVersion, "cwd": Workspace, "historyMode": HistoryMode, "turns": []any{map[string]any{"id": "native_turn", "status": "completed", "itemsView": "summary", "items": []any{final}}}}}
			}
			f.onSend = func(v map[string]json.RawMessage) { replySnapshot(f, v, snap) }
			result, err := finishFromSnapshot(context.Background(), tr, &c, &fixtureHandler{})
			if err == nil || result.TerminalVerified || result.Text != "" {
				t.Fatal("unverified claimed success was exposed")
			}
		})
	}
}
func TestRecoveryNeverResubmitsUncertainTurn(t *testing.T) {
	r := fixtureRequest()
	r.ReconcileOnly = true
	f := newFixture()
	if _, err := fixtureAdapter(f).Run(context.Background(), r, &fixtureHandler{}); !errors.Is(err, ErrUnknown) {
		t.Fatal("missing recovery checkpoint accepted")
	}
	c := checkpoint{Version: RuntimeVersion, RunID: r.RunID, OwnerID: r.OwnerID, ConversationID: r.ConversationID, Model: r.Model, Effort: r.Effort, PromptHash: r.PromptHash, ToolSchemaHash: r.ToolSchemaHash, Profile: r.ProfileVersion, HistoryMode: HistoryMode, ConfigHash: digest(configFor(r)), InstructionHash: instructionDigest(r), ThreadID: "native_thread", SubmissionAttempted: true}
	r.Checkpoint = marshalCheckpoint(&c)
	f.onSend = func(v map[string]json.RawMessage) {
		var method string
		_ = json.Unmarshal(v["method"], &method)
		if method == "initialize" {
			reply(f, v["id"], map[string]any{"userAgent": "fixture"})
		}
		if method == "thread/resume" {
			reply(f, v["id"], threadResult())
		}
	}
	if _, err := fixtureAdapter(f).Run(context.Background(), r, &fixtureHandler{}); !errors.Is(err, ErrUnknown) {
		t.Fatalf("uncertain turn recovered as success: %v", err)
	}
	for _, method := range f.methods {
		if method == "turn/start" {
			t.Fatal("recovery submitted another turn")
		}
	}
}
func TestNativeApprovalsAlwaysRejected(t *testing.T) {
	for _, method := range []string{"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "mcpServer/elicitation/request", "unknown/request"} {
		t.Run(method, func(t *testing.T) {
			f := newFixture()
			responses := make(chan map[string]json.RawMessage, 1)
			f.onSend = func(v map[string]json.RawMessage) { responses <- v }
			tr := newTransport(f)
			defer tr.close()
			f.push(map[string]any{"id": 1, "method": method, "params": map[string]any{"token": "must never escape"}})
			select {
			case v := <-responses:
				if string(v["result"]) == `{"decision":"accept"}` {
					t.Fatal("native approval accepted")
				}
			case <-time.After(time.Second):
				t.Fatal("missing denial")
			}
			<-tr.done
			if !tr.unsafe.Load() {
				t.Fatal("unsafe request did not abort profile")
			}
		})
	}
}

type durableReceiptFixture struct {
	fixtureHandler
	verified int
}

func (h *durableReceiptFixture) VerifyToolReceipt(_ context.Context, call app.RuntimeToolCall) (app.RuntimeToolResult, error) {
	if call.ThreadID != "native_thread" || call.TurnID != "native_turn" || call.CallID != "native_call" || call.Name != "studio_canvas_read" || call.Namespace != "" || argumentDigest(call.Arguments) != argumentDigest(json.RawMessage(`{}`)) {
		return app.RuntimeToolResult{}, ErrProtocol
	}
	h.verified++
	return app.RuntimeToolResult{Success: true, Output: json.RawMessage(`{"revision":1}`)}, nil
}
func TestRecoveryHydratesOnlyExistingDurableToolReceipt(t *testing.T) {
	f := newFixture()
	tr := newTransport(f)
	defer tr.close()
	h := &durableReceiptFixture{}
	c := checkpoint{HistoryMode: HistoryMode, ThreadID: "native_thread", TurnID: "native_turn"}
	f.onSend = func(v map[string]json.RawMessage) {
		replySnapshot(f, v, snapshot(toolItem(true), map[string]any{"id": "native_final", "type": "agentMessage", "text": "Recovered revision 1."}))
	}
	result, err := finishFromSnapshot(context.Background(), tr, &c, h)
	if err != nil || !result.TerminalVerified || h.verified != 1 || h.calls != 0 || len(c.Calls) != 1 || len(h.checkpoints) != 1 {
		t.Fatalf("unsafe receipt recovery: verified=%v reads=%d writes=%d err=%v", result.TerminalVerified, h.verified, h.calls, err)
	}
}

func TestRecoveryNormalizesJSONBCheckpointResult(t *testing.T) {
	r := fixtureRequest()
	r.ReconcileOnly = true
	c := checkpoint{Version: RuntimeVersion, RunID: r.RunID, OwnerID: r.OwnerID, ConversationID: r.ConversationID, Model: r.Model, Effort: r.Effort, PromptHash: r.PromptHash, ToolSchemaHash: r.ToolSchemaHash, Profile: r.ProfileVersion, HistoryMode: HistoryMode, ConfigHash: digest(configFor(r)), InstructionHash: instructionDigest(r), ThreadID: "native_thread", TurnID: "native_turn", SubmissionAttempted: true, Calls: map[string]callEvidence{"native_call": {Name: "studio_canvas_read", ArgumentsHash: argumentDigest(json.RawMessage(`{}`)), Success: true, Output: json.RawMessage(`{"revision":1,"nodes":[]}`)}}}
	// JSONB preserves structure but retrieves a differently spaced/keyed object.
	r.Checkpoint = marshalCheckpoint(&c)
	var roundTrip map[string]any
	if json.Unmarshal(r.Checkpoint, &roundTrip) != nil {
		t.Fatal("invalid fixture")
	}
	r.Checkpoint, _ = json.MarshalIndent(roundTrip, "", "  ")
	f := newFixture()
	f.onSend = func(v map[string]json.RawMessage) {
		var method string
		_ = json.Unmarshal(v["method"], &method)
		switch method {
		case "initialize":
			reply(f, v["id"], map[string]any{"userAgent": "fixture"})
		case "thread/resume":
			reply(f, v["id"], threadResult())
		case "thread/read", "thread/turns/list":
			item := toolItem(true)
			item["contentItems"] = []any{map[string]any{"type": "inputText", "text": `{"nodes":[],"revision":1}`}}
			replySnapshot(f, v, snapshot(item, map[string]any{"id": "native_final", "type": "agentMessage", "text": "Recovered normalized result."}))
		}
	}
	h := &fixtureHandler{}
	result, err := fixtureAdapter(f).Run(context.Background(), r, h)
	if err != nil || !result.TerminalVerified || h.calls != 0 {
		t.Fatalf("JSONB recovery failed: verified=%v writes=%d err=%v", result.TerminalVerified, h.calls, err)
	}
	for _, method := range f.methods {
		if method == "turn/start" {
			t.Fatal("JSONB recovery submitted a new turn")
		}
	}
}

func TestPaginatedSnapshotRequiresCompleteBoundPages(t *testing.T) {
	for _, kind := range []string{"complete", "foreign_turn", "duplicate_turn", "duplicate_item", "missing_page", "item_cursor_cycle", "turn_page_bound"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture()
			tr := newTransport(f)
			defer tr.close()
			c := checkpoint{HistoryMode: HistoryMode, ThreadID: "native_thread", TurnID: "native_turn", Calls: map[string]callEvidence{"native_call": {Name: "studio_canvas_read", ArgumentsHash: argumentDigest(json.RawMessage(`{}`)), Success: true, Output: json.RawMessage(`{"revision":1}`)}}}
			turnPages, itemPages := 0, 0
			final := map[string]any{"id": "native_final", "type": "agentMessage", "text": "Paginated revision 1."}
			f.onSend = func(v map[string]json.RawMessage) {
				var method string
				_ = json.Unmarshal(v["method"], &method)
				var p struct {
					Thread       string `json:"threadId"`
					Turn         string `json:"turnId"`
					Cursor       string `json:"cursor"`
					View         string `json:"itemsView"`
					IncludeTurns bool   `json:"includeTurns"`
				}
				_ = json.Unmarshal(v["params"], &p)
				if p.Thread != c.ThreadID {
					t.Error("foreign thread read")
				}
				switch method {
				case "thread/read":
					if p.IncludeTurns {
						t.Error("legacy turn snapshot requested")
					}
					replySnapshot(f, v, snapshot())
				case "thread/turns/list":
					turnPages++
					if p.View != "full" {
						t.Error("summary requested")
					}
					if kind == "turn_page_bound" {
						reply(f, v["id"], map[string]any{"data": []any{map[string]any{"id": "turn_" + string(rune('a'+turnPages)), "status": "completed", "itemsView": "full", "items": []any{}}}, "nextCursor": "cursor_" + string(rune('a'+turnPages))})
					} else if turnPages == 1 {
						reply(f, v["id"], map[string]any{"data": []any{map[string]any{"id": "another_turn", "status": "completed", "itemsView": "full", "items": []any{}}}, "nextCursor": "next_turn"})
					} else {
						if p.Cursor != "next_turn" {
							t.Error("turn cursor not followed")
						}
						id := "native_turn"
						if kind == "duplicate_turn" {
							id = "another_turn"
						}
						reply(f, v["id"], map[string]any{"data": []any{map[string]any{"id": id, "status": "completed", "itemsView": "notLoaded", "items": []any{}}}, "nextCursor": nil})
					}
				case "thread/items/list":
					itemPages++
					if p.Turn != c.TurnID {
						t.Error("item read lacks exact turn")
					}
					turn := c.TurnID
					if kind == "foreign_turn" {
						turn = "foreign_turn"
					}
					if itemPages == 1 {
						reply(f, v["id"], map[string]any{"data": []any{map[string]any{"turnId": turn, "item": toolItem(true)}}, "nextCursor": "next_item"})
					} else if kind == "missing_page" {
						f.push(map[string]any{"id": v["id"], "error": map[string]any{"code": -32601, "message": "unavailable"}})
					} else {
						if p.Cursor != "next_item" {
							t.Error("item cursor not followed")
						}
						item := final
						if kind == "duplicate_item" {
							item = toolItem(true)
						}
						var next any
						if kind == "item_cursor_cycle" {
							next = "next_item"
						}
						reply(f, v["id"], map[string]any{"data": []any{map[string]any{"turnId": turn, "item": item}}, "nextCursor": next})
					}
				default:
					t.Error("unexpected snapshot RPC")
				}
			}
			h := &fixtureHandler{}
			result, err := finishFromSnapshot(context.Background(), tr, &c, h)
			if kind == "complete" {
				if err != nil || !result.TerminalVerified || result.Text != "Paginated revision 1." || turnPages != 2 || itemPages != 2 || h.calls != 0 {
					t.Fatalf("complete pages failed: turns=%d items=%d err=%v", turnPages, itemPages, err)
				}
			} else if err == nil || result.TerminalVerified || result.Text != "" || len(h.checkpoints) != 0 {
				t.Fatal("incomplete or foreign pagination exposed final output")
			}
			if turnPages > 8 || itemPages > 8 {
				t.Fatal("pagination exceeded bound")
			}
		})
	}
}

func TestRecoveryRejectsLegacyOrMissingHistoryMode(t *testing.T) {
	for _, mode := range []string{"", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			r := fixtureRequest()
			r.ReconcileOnly = true
			c := checkpoint{Version: RuntimeVersion, RunID: r.RunID, OwnerID: r.OwnerID, ConversationID: r.ConversationID, Model: r.Model, Effort: r.Effort, PromptHash: r.PromptHash, ToolSchemaHash: r.ToolSchemaHash, Profile: r.ProfileVersion, HistoryMode: mode, ConfigHash: digest(configFor(r)), InstructionHash: instructionDigest(r), ThreadID: "native_thread", TurnID: "native_turn", SubmissionAttempted: true}
			r.Checkpoint = marshalCheckpoint(&c)
			f := newFixture()
			_, err := fixtureAdapter(f).Run(context.Background(), r, &fixtureHandler{})
			if !errors.Is(err, ErrUnknown) || len(f.methods) != 0 {
				t.Fatal("legacy recovery opened native runtime")
			}
		})
	}
	var response nativeThreadResponse
	raw, _ := json.Marshal(threadResult())
	_ = json.Unmarshal(raw, &response)
	response.Thread.HistoryMode = "legacy"
	if validThreadResponse(response, fixtureRequest()) {
		t.Fatal("native legacy response accepted")
	}
}
