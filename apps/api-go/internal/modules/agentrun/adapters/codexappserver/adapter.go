package codexappserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"time"

	app "studiotv.local/service/api/internal/modules/agentrun/application"
)

const RuntimeVersion = "0.160.0"
const ProfileVersion = "studio-agent-tools-v1"
const Workspace = "/workspace"
const HistoryMode = "paginated"

// Config is server-owned. ProfileValidated is an explicit operator acceptance
// gate for the pinned tools-only runtime; config flags alone are not proof.
type Config struct {
	Enabled          bool
	ProfileValidated bool
	SocketPath       string
	Models           []app.Model
	MaxToolCalls     int
}
type Adapter struct {
	config Config
	open   func(context.Context, app.RuntimeRequest) (Frames, error)
}

func New(config Config) *Adapter {
	if config.MaxToolCalls <= 0 || config.MaxToolCalls > 64 {
		config.MaxToolCalls = 32
	}
	models := make([]app.Model, len(config.Models))
	for i, model := range config.Models {
		models[i] = model
		models[i].Efforts = append([]string(nil), model.Efforts...)
	}
	config.Models = models
	a := &Adapter{config: config}
	a.open = func(ctx context.Context, r app.RuntimeRequest) (Frames, error) {
		return openIsolated(ctx, config.SocketPath, r)
	}
	return a
}
func (a *Adapter) Available() bool {
	return a != nil && a.config.Enabled && a.config.ProfileValidated && a.config.SocketPath != ""
}
func (a *Adapter) Models(ctx context.Context) ([]app.Model, error) {
	if !a.Available() {
		return nil, ErrUnavailable
	}
	// Accepted policy is frozen separately from native discovery. A discovered
	// model/effort does not automatically become an enabled STUDIO capability.
	models := make([]app.Model, len(a.config.Models))
	for i, model := range a.config.Models {
		models[i] = model
		models[i].Efforts = append([]string(nil), model.Efforts...)
	}
	return models, nil
}
func digest(v any) string {
	raw, _ := json.Marshal(v)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func argumentDigest(raw json.RawMessage) string {
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return ""
	}
	return digest(value)
}

// PostgreSQL JSONB reformats nested raw JSON in private checkpoints. Normalize
// response data at both wire submission and checkpoint thaw so byte authority
// still matches the actual compact text returned to the native tool.
func canonicalOutput(raw json.RawMessage) (json.RawMessage, error) {
	if !json.Valid(raw) || len(raw) > 256<<10 {
		return nil, ErrProtocol
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return nil, ErrProtocol
	}
	result, err := json.Marshal(value)
	if err != nil {
		return nil, ErrProtocol
	}
	return result, nil
}
func identity(s string) bool {
	return len(s) > 0 && len(s) <= 200 && !strings.ContainsAny(s, "\x00\r\n")
}

var toolName = regexp.MustCompile(`^studio_[a-z0-9_]{1,60}$`)
var credentialText = regexp.MustCompile(`(?i)(bearer\s+[a-z0-9._~+/=-]{12,}|eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{10,}|sk-[a-zA-Z0-9_-]{20,})`)

type callEvidence struct {
	Name, Namespace, ArgumentsHash string
	Success                        bool
	Output                         json.RawMessage
}
type checkpoint struct {
	Version                                                                            string
	RunID, OwnerID, ConversationID, Model, Effort, PromptHash, ToolSchemaHash, Profile string
	ThreadID, TurnID                                                                   string
	HistoryMode                                                                        string
	SubmissionAttempted                                                                bool
	ConfigHash, InstructionHash                                                        string
	Calls                                                                              map[string]callEvidence
}

func (c checkpoint) matches(r app.RuntimeRequest) bool {
	return c.Version == RuntimeVersion && c.RunID == r.RunID && c.OwnerID == r.OwnerID && c.ConversationID == r.ConversationID && c.Model == r.Model && c.Effort == r.Effort && c.PromptHash == r.PromptHash && c.ToolSchemaHash == r.ToolSchemaHash && c.Profile == r.ProfileVersion && c.HistoryMode == HistoryMode && c.ConfigHash == digest(configFor(r)) && c.InstructionHash == instructionDigest(r) && identity(c.ThreadID) && c.SubmissionAttempted
}
func instructionDigest(r app.RuntimeRequest) string {
	return digest(struct{ Base, Developer, Policy string }{r.BaseInstructions, r.DeveloperInstructions, r.Instructions})
}
func marshalCheckpoint(c *checkpoint) json.RawMessage { raw, _ := json.Marshal(c); return raw }
func (a *Adapter) validate(r app.RuntimeRequest) error {
	if !a.Available() {
		return ErrUnavailable
	}
	if !identity(r.RunID) || !identity(r.OwnerID) || !identity(r.ConversationID) || !identity(r.Model) || r.ProfileVersion != ProfileVersion || r.PromptHash == "" || r.ToolSchemaHash != digest(r.Tools) || len(r.Messages) == 0 || len(r.Messages) > 128 || len(r.Tools) == 0 || len(r.Tools) > 32 {
		return ErrProtocol
	}
	permitted := false
	for _, m := range a.config.Models {
		if m.ID == r.Model && m.Available {
			for _, effort := range m.Efforts {
				if effort == r.Effort {
					permitted = true
				}
			}
		}
	}
	// Ultra has native child-thread behavior; it needs a separate bound child
	// runtime protocol and is intentionally unavailable in this initial profile.
	if !permitted || r.Effort == "ultra" {
		return ErrUnavailable
	}
	bytes := len(r.BaseInstructions) + len(r.DeveloperInstructions) + len(r.Instructions)
	for _, m := range r.Messages {
		if m.Role != "USER" && m.Role != "ASSISTANT" {
			return ErrProtocol
		}
		bytes += len(m.Text)
	}
	if bytes > 512<<10 {
		return ErrProtocol
	}
	seen := map[string]bool{}
	for _, tool := range r.Tools {
		if !toolName.MatchString(tool.Name) || seen[tool.Name] || !json.Valid(tool.InputSchema) || len(tool.InputSchema) > 64<<10 {
			return ErrProfile
		}
		seen[tool.Name] = true
	}
	return nil
}

// Run owns exactly one turn. Durable submission intent is saved BEFORE writing
// turn/start. ReconcileOnly is read/interrupt only and can never start a turn.
func (a *Adapter) Run(ctx context.Context, r app.RuntimeRequest, h app.ToolHandler) (result app.RuntimeResult, err error) {
	phase := phaseValidate
	defer func() { diagnoseRuntime(ctx, phase, err) }()
	if err = a.validate(r); err != nil {
		return result, err
	}
	if h == nil {
		return result, ErrProtocol
	}
	c := checkpoint{Version: RuntimeVersion, RunID: r.RunID, OwnerID: r.OwnerID, ConversationID: r.ConversationID, Model: r.Model, Effort: r.Effort, PromptHash: r.PromptHash, ToolSchemaHash: r.ToolSchemaHash, Profile: r.ProfileVersion, HistoryMode: HistoryMode, ConfigHash: digest(configFor(r)), InstructionHash: instructionDigest(r), Calls: map[string]callEvidence{}}
	if len(r.Checkpoint) > 0 {
		var thawed checkpoint
		if len(r.Checkpoint) > 4<<20 || json.Unmarshal(r.Checkpoint, &thawed) != nil || !thawed.matches(r) {
			return result, ErrUnknown
		}
		c = thawed
		r.ReconcileOnly = true
	}
	if r.ReconcileOnly && (len(r.Checkpoint) == 0 || !c.matches(r)) {
		return result, ErrUnknown
	}
	if c.Calls == nil {
		c.Calls = map[string]callEvidence{}
	}
	if len(c.Calls) > a.config.MaxToolCalls {
		return result, ErrUnknown
	}
	for id, evidence := range c.Calls {
		output, normalizeErr := canonicalOutput(evidence.Output)
		if normalizeErr != nil {
			return result, ErrUnknown
		}
		evidence.Output = output
		c.Calls[id] = evidence
	}
	phase = phaseOpen
	frames, err := a.open(ctx, r)
	if err != nil {
		return result, ErrUnavailable
	}
	t := newTransport(frames)
	defer t.close()
	var stateMu sync.Mutex
	defer func() {
		stateMu.Lock()
		result.Checkpoint = marshalCheckpoint(&c)
		stateMu.Unlock()
		if t.unsafe.Load() {
			result.Text = ""
			result.TerminalVerified = false
			err = ErrProfile
		}
	}()
	phase = phaseInitialize
	if err = t.initialize(ctx); err != nil {
		return result, err
	}
	if r.ReconcileOnly {
		phase = phaseThreadResume
		var resumed nativeThreadResponse
		if err = t.call(ctx, "thread/resume", map[string]any{"threadId": c.ThreadID, "model": r.Model, "cwd": Workspace, "approvalPolicy": "never", "sandbox": "read-only", "config": configFor(r), "excludeTurns": false}, &resumed); err != nil {
			return result, ErrUnknown
		}
		if !validThreadResponse(resumed, r) || resumed.Thread.ID != c.ThreadID {
			return result, ErrProfile
		}
		if c.TurnID == "" {
			return result, ErrUnknown
		} // Uncertain submission: no second turn.
		phase = phaseBind
		if err = h.Bind(ctx, c.ThreadID, c.TurnID); err != nil {
			return result, ErrUnknown
		}
		// A relaunched runtime must not replay side effects. Persisted completed
		// calls are verified against the snapshot; active/unmatched calls stay UNKNOWN.
		phase = phaseSnapshot
		return finishFromSnapshot(ctx, t, &c, h)
	}
	var started nativeThreadResponse
	tools := make([]map[string]any, 0, len(r.Tools))
	for _, tool := range r.Tools {
		tools = append(tools, map[string]any{"type": "function", "name": tool.Name, "description": tool.Description, "inputSchema": tool.InputSchema})
	}
	developer := r.DeveloperInstructions + "\n\n" + r.Instructions
	params := map[string]any{"model": r.Model, "cwd": Workspace, "approvalPolicy": "never", "sandbox": "read-only", "baseInstructions": r.BaseInstructions, "developerInstructions": developer, "config": configFor(r), "dynamicTools": tools, "ephemeral": false, "historyMode": HistoryMode, "experimentalRawEvents": false, "allowProviderModelFallback": false, "environments": []any{}, "selectedCapabilityRoots": []any{}, "runtimeWorkspaceRoots": []any{}}
	phase = phaseThreadStart
	if err = t.call(ctx, "thread/start", params, &started); err != nil {
		return result, err
	}
	if !validThreadResponse(started, r) {
		return result, ErrProfile
	}
	c.ThreadID = started.Thread.ID
	// A checkpoint with attempted=true is an immutable no-resubmit fence even
	// when the process dies before the server supplies a native turn id.
	c.SubmissionAttempted = true
	phase = phaseSubmissionCheckpoint
	if err = h.SaveCheckpoint(ctx, marshalCheckpoint(&c)); err != nil {
		return result, ErrUnknown
	}
	bound := make(chan struct{})
	workerDone := make(chan struct{})
	toolErrors := make(chan error, 1)
	toolCtx, toolCancel := context.WithCancel(ctx)
	defer toolCancel()
	go func() {
		defer close(workerDone)
		select {
		case <-bound:
		case <-toolCtx.Done():
			return
		}
		for {
			select {
			case <-toolCtx.Done():
				return
			case req := <-t.tools:
				t.bytes.Add(-int64(len(req.params)))
				if e := executeTool(toolCtx, t, r, &c, &stateMu, h, req, a.config.MaxToolCalls); e != nil {
					diagnoseRuntime(toolCtx, phaseToolWorker, e)
					select {
					case toolErrors <- e:
					default:
					}
					return
				}
			}
		}
	}()
	defer func() { toolCancel(); t.cancel(); <-workerDone }()
	transcript, _ := json.Marshal(r.Messages)
	var turn struct {
		Turn nativeTurn `json:"turn"`
	}
	start := map[string]any{"threadId": c.ThreadID, "model": r.Model, "effort": r.Effort, "approvalPolicy": "never", "input": []any{map[string]any{"type": "text", "text": "STUDIO authorized conversation (JSON messages, in chronological order):\n" + string(transcript), "text_elements": []any{}}}, "environments": []any{}, "runtimeWorkspaceRoots": []any{}}
	phase = phaseTurnStart
	if err = t.call(ctx, "turn/start", start, &turn); err != nil {
		return result, ErrUnknown
	}
	if !identity(turn.Turn.ID) {
		return result, ErrProtocol
	}
	stateMu.Lock()
	c.TurnID = turn.Turn.ID
	stateMu.Unlock()
	phase = phaseBind
	if err = h.Bind(ctx, c.ThreadID, c.TurnID); err != nil {
		return result, ErrUnknown
	}
	phase = phaseAcceptedCheckpoint
	if err = h.SaveCheckpoint(ctx, marshalCheckpoint(&c)); err != nil {
		return result, ErrUnknown
	}
	close(bound)
	completedItems := map[string]string{}
	for {
		phase = phaseEvents
		if t.unsafe.Load() {
			return result, ErrProfile
		}
		select {
		case <-ctx.Done():
			toolCancel()
			interruptCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = t.call(interruptCtx, "turn/interrupt", map[string]any{"threadId": c.ThreadID, "turnId": c.TurnID}, nil)
			cancel()
			return result, ErrCanceled
		case <-t.done:
			phase = phaseTransportClosed
			return result, ErrUnknown
		case e := <-toolErrors:
			phase = phaseToolWorker
			return result, e
		case n := <-t.notifications:
			t.bytes.Add(-int64(len(n.params)))
			phase = phaseNotification
			terminal, e := validateNotification(n, c.ThreadID, c.TurnID, completedItems)
			if e != nil {
				return result, e
			}
			if terminal {
				// Tool worker saves result evidence before returning any response. Native
				// terminal evidence can only be verified after all completed responses.
				stateMu.Lock()
				copyCheckpoint := c
				copyCheckpoint.Calls = cloneCalls(c.Calls)
				stateMu.Unlock()
				phase = phaseSnapshot
				out, e := finishFromSnapshot(ctx, t, &copyCheckpoint, h)
				if e == nil {
					phase = phaseTranscript
					if e = verifyCompletedItems(completedItems, t.lastSnapshot); e != nil {
						return result, e
					}
				}
				return out, e
			}
		}
	}
}

func cloneCalls(source map[string]callEvidence) map[string]callEvidence {
	result := map[string]callEvidence{}
	for k, v := range source {
		result[k] = v
	}
	return result
}
func fixedConfig() map[string]any {
	config := map[string]any{"web_search": "disabled", "project_doc_max_bytes": 0, "agents.enabled": false, "analytics.enabled": false, "tools.view_image": false, "mcp_servers": map[string]any{}, "tool_result_log.max_bytes": 0}
	for _, name := range []string{"shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "image_generation", "view_image", "multi_agent", "multi_agent_v2", "goals", "sleep_tool", "code_mode", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "memories", "shell_snapshot", "request_permissions_tool", "tool_suggest", "in_app_local_automation", "in_app_chat", "realtime_conversation", "system_proxy_fallback", "daemon_auto_start"} {
		config["features."+name] = false
	}
	// The pinned native dynamic tools use the stable Code Mode dispatch host.
	// Its model-visible exec wrapper is distinct from disabled shell/unified exec.
	config["features.code_mode_host"] = true
	config["features.skip_host_skill_discovery"] = true
	return config
}
func configFor(r app.RuntimeRequest) map[string]any {
	config := fixedConfig()
	config["model_reasoning_effort"] = r.Effort
	return config
}

func executeTool(ctx context.Context, t *transport, r app.RuntimeRequest, c *checkpoint, mu *sync.Mutex, h app.ToolHandler, req serverRequest, maxCalls int) error {
	var p struct {
		ThreadID  string          `json:"threadId"`
		TurnID    string          `json:"turnId"`
		CallID    string          `json:"callId"`
		Tool      string          `json:"tool"`
		Namespace string          `json:"namespace"`
		Arguments json.RawMessage `json:"arguments"`
	}
	deny := func() error {
		diagnoseRuntime(ctx, phaseToolReceipt, ErrProfile)
		_ = t.response(ctx, req.id, map[string]any{"success": false, "contentItems": []any{map[string]any{"type": "inputText", "text": "{\"code\":\"STUDIO_TOOL_REJECTED\"}"}}})
		return ErrProfile
	}
	if json.Unmarshal(req.params, &p) != nil || p.ThreadID != c.ThreadID || p.TurnID != c.TurnID || !identity(p.CallID) || p.Namespace != "" || !json.Valid(p.Arguments) || len(p.Arguments) > 128<<10 {
		return deny()
	}
	known := false
	for _, tool := range r.Tools {
		if tool.Name == p.Tool {
			known = true
		}
	}
	if !known {
		return deny()
	}
	argsHash := argumentDigest(p.Arguments)
	mu.Lock()
	old, exists := c.Calls[p.CallID]
	count := len(c.Calls)
	mu.Unlock()
	evidence := callEvidence{Name: p.Tool, Namespace: p.Namespace, ArgumentsHash: argsHash}
	if exists {
		if old.Name != p.Tool || old.Namespace != p.Namespace || old.ArgumentsHash != argsHash {
			return deny()
		}
		evidence = old
	} else {
		if count >= maxCalls {
			return deny()
		}
		out, err := h.HandleTool(ctx, app.RuntimeToolCall{ThreadID: p.ThreadID, TurnID: p.TurnID, CallID: p.CallID, Name: p.Tool, Namespace: p.Namespace, Arguments: p.Arguments})
		if err != nil {
			diagnoseRuntime(ctx, phaseToolHandler, err)
			return ErrUnknown
		}
		if len(out.Output) > 256<<10 || !json.Valid(out.Output) || credentialText.Match(out.Output) {
			return deny()
		}
		evidence.Success = out.Success
		evidence.Output, err = canonicalOutput(out.Output)
		if err != nil {
			return deny()
		}
		mu.Lock()
		c.Calls[p.CallID] = evidence
		raw := marshalCheckpoint(c)
		mu.Unlock()
		if len(raw) > 4<<20 {
			diagnoseRuntime(ctx, phaseToolCheckpoint, ErrUnknown)
			return ErrUnknown
		}
		if err = h.SaveCheckpoint(ctx, raw); err != nil {
			diagnoseRuntime(ctx, phaseToolCheckpoint, err)
			return ErrUnknown
		}
	}
	err := t.response(ctx, req.id, map[string]any{"success": evidence.Success, "contentItems": []any{map[string]any{"type": "inputText", "text": string(evidence.Output)}}})
	diagnoseRuntime(ctx, phaseToolResponse, err)
	return err
}
