// Package codexappserver is STUDIO's private, pinned Agent protocol adapter.
// Native frames, errors, checkpoints and account data never enter public events.
package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrUnavailable = errors.New("CODEX_AGENT_UNAVAILABLE")
	ErrProtocol    = errors.New("CODEX_AGENT_PROTOCOL_INVALID")
	ErrProfile     = errors.New("CODEX_AGENT_PROFILE_REJECTED")
	ErrUnknown     = errors.New("CODEX_AGENT_RESULT_UNKNOWN")
	ErrCanceled    = errors.New("CODEX_AGENT_CANCELED")
	ErrTurnFailed  = errors.New("CODEX_AGENT_TURN_FAILED")
)

const maxFrame = 4 << 20
const maxQueuedBytes = 8 << 20

// Frames is a private newline-delimited stdio stream supplied by the isolated
// launcher. There is deliberately no public arbitrary-RPC API or local exec.
type Frames interface {
	Send(context.Context, json.RawMessage) error
	Receive(context.Context) (json.RawMessage, error)
	Close() error
}
type notification struct {
	method string
	params json.RawMessage
}
type serverRequest struct {
	id     json.RawMessage
	params json.RawMessage
}
type rpcReply struct {
	result json.RawMessage
	failed bool
}
type transport struct {
	frames             Frames
	ctx                context.Context
	cancel             context.CancelFunc
	done               chan struct{}
	pendingMu, writeMu sync.Mutex
	pending            map[string]chan rpcReply
	ids                atomic.Uint64
	bytes              atomic.Int64
	notifications      chan notification
	tools              chan serverRequest
	unsafe             atomic.Bool
	lastSnapshot       []nativeItem
	closeOnce          sync.Once
}

func newTransport(frames Frames) *transport {
	ctx, cancel := context.WithCancel(context.Background())
	t := &transport{frames: frames, ctx: ctx, cancel: cancel, done: make(chan struct{}), pending: map[string]chan rpcReply{}, notifications: make(chan notification, 128), tools: make(chan serverRequest, 8)}
	go t.read()
	return t
}
func (t *transport) close() { t.closeOnce.Do(func() { t.cancel(); _ = t.frames.Close() }); <-t.done }
func (t *transport) send(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil || len(raw) > maxFrame {
		return ErrProtocol
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if t.frames.Send(ctx, raw) != nil {
		return ErrUnknown
	}
	return nil
}
func (t *transport) call(ctx context.Context, method string, params, result any) error {
	// Only adapter-owned protocol operations can reach the native process.
	switch method {
	case "initialize", "model/list", "thread/start", "thread/resume", "thread/read", "thread/turns/list", "thread/items/list", "turn/start", "turn/interrupt":
	default:
		return ErrProfile
	}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	id := fmt.Sprintf("studio_%d", t.ids.Add(1))
	ch := make(chan rpcReply, 1)
	t.pendingMu.Lock()
	t.pending[id] = ch
	t.pendingMu.Unlock()
	defer func() { t.pendingMu.Lock(); delete(t.pending, id); t.pendingMu.Unlock() }()
	if err := t.send(bounded, map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return err
	}
	select {
	case <-bounded.Done():
		diagnoseRuntime(bounded, phaseRPCWait, ErrUnknown)
		return ErrUnknown
	case <-t.done:
		return ErrUnknown
	case r := <-ch:
		if r.failed {
			return ErrUnavailable
		}
		if result != nil && json.Unmarshal(r.result, result) != nil {
			return ErrProtocol
		}
		return nil
	}
}
func (t *transport) initialize(ctx context.Context) error {
	var out struct {
		UserAgent string `json:"userAgent"`
	}
	if err := t.call(ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "studio-agent-private", "version": "1"}, "capabilities": map[string]any{"experimentalApi": true}}, &out); err != nil {
		return err
	}
	if out.UserAgent == "" {
		return ErrProtocol
	}
	return t.send(ctx, map[string]any{"method": "initialized"})
}
func (t *transport) response(ctx context.Context, id json.RawMessage, result any) error {
	return t.send(ctx, map[string]any{"id": id, "result": result})
}
func (t *transport) reject(ctx context.Context, id json.RawMessage, method string) error {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		return t.response(ctx, id, map[string]any{"decision": "cancel"})
	case "execCommandApproval", "applyPatchApproval":
		return t.response(ctx, id, map[string]any{"decision": "abort"})
	case "item/permissions/requestApproval":
		return t.response(ctx, id, map[string]any{"permissions": map[string]any{}, "scope": "turn"})
	case "mcpServer/elicitation/request":
		return t.response(ctx, id, map[string]any{"action": "cancel"})
	case "item/tool/requestUserInput":
		return t.response(ctx, id, map[string]any{"answers": map[string]any{}})
	default:
		return t.send(ctx, map[string]any{"id": id, "error": map[string]any{"code": -32601, "message": "method is not enabled"}})
	}
}
func (t *transport) read() {
	defer close(t.done)
	defer t.cancel()
	stopPhase, stopErr := phaseTransportReceive, ErrUnknown
	defer func() {
		if t.ctx.Err() == nil {
			diagnoseRuntime(t.ctx, stopPhase, stopErr)
		}
	}()
	for {
		stopPhase, stopErr = phaseTransportReceive, ErrUnknown
		raw, err := t.frames.Receive(t.ctx)
		if err != nil {
			return
		}
		stopPhase, stopErr = phaseTransportFrame, ErrProtocol
		if len(raw) > maxFrame || len(raw) == 0 {
			return
		}
		var wire struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(raw, &wire) != nil {
			return
		}
		if wire.Method != "" {
			if wire.Result != nil || wire.Error != nil {
				return
			}
			if wire.ID != nil {
				if !validRPCID(wire.ID) {
					return
				}
				if wire.Method != "item/tool/call" {
					stopPhase, stopErr = phaseTransportRequest, ErrProfile
					t.unsafe.Store(true)
					_ = t.reject(t.ctx, wire.ID, wire.Method)
					return
				}
				if t.bytes.Add(int64(len(wire.Params))) > maxQueuedBytes {
					stopPhase, stopErr = phaseTransportQueue, ErrProfile
					t.unsafe.Store(true)
					return
				}
				select {
				case t.tools <- serverRequest{wire.ID, wire.Params}:
				default:
					stopPhase, stopErr = phaseTransportQueue, ErrProfile
					t.unsafe.Store(true)
					return
				}
				continue
			}
			if t.bytes.Add(int64(len(wire.Params))) > maxQueuedBytes {
				stopPhase, stopErr = phaseTransportQueue, ErrUnknown
				return
			}
			select {
			case t.notifications <- notification{wire.Method, wire.Params}:
			default:
				stopPhase, stopErr = phaseTransportQueue, ErrUnknown
				return
			}
			continue
		}
		var id string
		stopPhase, stopErr = phaseTransportReply, ErrProtocol
		if json.Unmarshal(wire.ID, &id) != nil || id == "" || (wire.Result == nil) == (wire.Error == nil) {
			return
		}
		t.pendingMu.Lock()
		ch := t.pending[id]
		t.pendingMu.Unlock()
		if ch != nil {
			select {
			case ch <- rpcReply{wire.Result, wire.Error != nil}:
			default:
				return
			}
		}
		stopPhase, stopErr = phaseTransportReceive, ErrUnknown
	}
}
func validRPCID(raw json.RawMessage) bool {
	if len(raw) == 0 || len(raw) > 128 {
		return false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s != ""
	}
	var n int64
	return json.Unmarshal(raw, &n) == nil
}
