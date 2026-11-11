package application

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/observability"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

const ProfileVersion = "studio-agent-tools-v1"
const CapabilityRef = "codex-6-1-text-v1"
const CapabilityVersion = "2"

type credentialEntry struct {
	credential Credential
	digest     [32]byte
}
type Service struct {
	store       Store
	runtime     Runtime
	executor    Executor
	config      Config
	mu          sync.Mutex
	credentials map[string]credentialEntry
	active      map[string]context.CancelFunc
	wake        chan struct{}
}

func New(store Store, runtime Runtime, executor Executor, config Config) (*Service, error) {
	if store == nil {
		return nil, errors.New("agent store required")
	}
	if config.RunTimeout == 0 {
		config.RunTimeout = 10 * time.Minute
	}
	if config.LeaseDuration == 0 {
		config.LeaseDuration = 45 * time.Second
	}
	if config.MaxToolCalls == 0 {
		config.MaxToolCalls = 32
	}
	if config.Workers == 0 {
		config.Workers = 2
	}
	if config.RunTimeout < time.Second || config.RunTimeout > 30*time.Minute || config.LeaseDuration < 3*time.Second || config.LeaseDuration > time.Minute || config.MaxToolCalls < 1 || config.MaxToolCalls > 100 || config.Workers < 1 || config.Workers > 8 {
		return nil, domain.ErrInvalid
	}
	return &Service{store: store, runtime: runtime, executor: executor, config: config, credentials: map[string]credentialEntry{}, active: map[string]context.CancelFunc{}, wake: make(chan struct{}, 1)}, nil
}
func (s *Service) Enabled() bool {
	return s.runtime != nil && s.runtime.Available() && s.executor != nil && s.config.PromptSpec != nil && s.config.PromptSpec.TemplateSHA256 != ""
}
func (s *Service) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func credential(ctx context.Context, actor Actor, bearer string, deadline time.Time) (Credential, error) {
	now := time.Now()
	expiry := actor.AccessExpiresAt
	if actor.OwnerID == "" || actor.SessionID == "" || actor.IssuedAt.IsZero() || actor.AccessExpiresAt.IsZero() || actor.SessionExpiresAt.IsZero() || !actor.IssuedAt.Before(actor.AccessExpiresAt) || actor.IssuedAt.After(now.Add(time.Minute)) || bearer == "" || strings.ContainsAny(bearer, "\r\n\x00") {
		return Credential{}, domain.ErrAuth
	}
	if actor.SessionExpiresAt.Before(expiry) {
		expiry = actor.SessionExpiresAt
	}
	if deadline.Before(expiry) {
		expiry = deadline
	}
	if !now.Before(expiry) {
		return Credential{}, domain.ErrAuth
	}
	return Credential{Actor: actor, Bearer: bearer, Canvas: collaboration.CanvasDelegationFrom(ctx), ExpiresAt: expiry}, nil
}
func selectModel(cmd CreateCommand) (string, error) {
	if cmd.CapabilityRef != CapabilityRef || cmd.CapabilityVersion != CapabilityVersion {
		return "", domain.ErrDisabled
	}
	var p struct {
		ReasoningEffort string `json:"reasoningEffort"`
	}
	if len(cmd.Parameters) == 0 {
		cmd.Parameters = json.RawMessage(`{}`)
	}
	var exact map[string]json.RawMessage
	if json.Unmarshal(cmd.Parameters, &exact) != nil || exact == nil {
		return "", domain.ErrInvalid
	}
	if value, present := exact["reasoningEffort"]; present {
		var text string
		if string(value) == "null" || json.Unmarshal(value, &text) != nil {
			return "", domain.ErrInvalid
		}
	}
	if decode(cmd.Parameters, &p) != nil {
		return "", domain.ErrInvalid
	}
	if p.ReasoningEffort == "" {
		p.ReasoningEffort = "low"
	}
	if p.ReasoningEffort != "low" && p.ReasoningEffort != "high" {
		return "", domain.ErrInvalid
	}
	return p.ReasoningEffort, nil
}
func (s *Service) Create(ctx context.Context, actor Actor, bearer, cid, key string, cmd CreateCommand) (domain.Run, error) {
	if !s.Enabled() {
		return domain.Run{}, domain.ErrDisabled
	}
	if !validID(cid) || !validID(cmd.MessageID) || cmd.ExpectedRevision < 1 {
		return domain.Run{}, domain.ErrInvalid
	}
	k, e := normalizeKey(key)
	if e != nil {
		return domain.Run{}, e
	}
	effort, e := selectModel(cmd)
	if e != nil {
		return domain.Run{}, e
	}
	if len(cmd.Parameters) == 0 {
		cmd.Parameters = json.RawMessage(`{}`)
	}
	params, e := canonical(cmd.Parameters)
	if e != nil {
		return domain.Run{}, e
	}
	cmd.Parameters = params
	now := time.Now().UTC()
	deadline := now.Add(s.config.RunTimeout)
	cred, e := credential(ctx, actor, bearer, deadline)
	if e != nil {
		return domain.Run{}, e
	}
	if e = s.executor.Revalidate(ctx, cred); e != nil {
		return domain.Run{}, e
	}
	models, e := s.runtime.Models(ctx)
	if e != nil {
		return domain.Run{}, domain.ErrDisabled
	}
	available := false
	for _, m := range models {
		if m.ID == "gpt-6.1-sol" && m.Available {
			for _, f := range m.Efforts {
				if f == effort {
					available = true
				}
			}
		}
	}
	if !available {
		return domain.Run{}, domain.ErrDisabled
	}
	prompt, _ := json.Marshal(s.config.PromptSpec)
	raw, _ := json.Marshal(map[string]any{"conversationId": cid, "parentSessionId": actor.SessionID, "command": cmd, "promptHash": s.config.PromptSpec.TemplateSHA256, "toolSchemaHash": SchemaHash(), "profileVersion": ProfileVersion})
	run := domain.Run{ID: "agr_" + strings.ReplaceAll(uuid.NewString(), "-", ""), Kind: "AGENT", OwnerID: actor.OwnerID, ParentSessionID: actor.SessionID, ConversationID: cid, MessageID: cmd.MessageID, CapabilityRef: cmd.CapabilityRef, CapabilityVersion: cmd.CapabilityVersion, Parameters: params, ExpectedRevision: cmd.ExpectedRevision, State: domain.Queued, CredentialEpoch: "1", AuthExpiresAt: cred.ExpiresAt, CreatedAt: now, UpdatedAt: now, Deadline: deadline, IdempotencyKey: k, RequestHash: hashBytes(raw), PromptHash: s.config.PromptSpec.TemplateSHA256, PromptSpec: prompt, ToolSchemaHash: SchemaHash(), ProfileVersion: ProfileVersion, Model: "gpt-6.1-sol", Effort: effort}
	run, e = s.store.Create(ctx, CreateRecord{Run: run, Command: cmd, Actor: actor})
	if e != nil {
		return domain.Run{}, e
	}
	// An idempotent creation replay must not silently replace a refreshed token.
	s.mu.Lock()
	current, exists := s.credentials[run.ID]
	if !exists || (!actor.IssuedAt.Before(current.credential.Actor.IssuedAt) && !actor.AccessExpiresAt.Before(current.credential.Actor.AccessExpiresAt)) {
		cred.Epoch = run.CredentialEpoch
		if run.AuthExpiresAt.Before(cred.ExpiresAt) {
			cred.ExpiresAt = run.AuthExpiresAt
		}
		s.credentials[run.ID] = credentialEntry{cred, sha256.Sum256([]byte(bearer))}
	}
	s.mu.Unlock()
	s.notify()
	return run, nil
}
func (s *Service) Get(ctx context.Context, owner, id string) (domain.Run, error) {
	if owner == "" || !validID(id) {
		return domain.Run{}, domain.ErrInvalid
	}
	return s.store.Get(ctx, owner, id)
}
func (s *Service) ListActive(ctx context.Context, owner, cid string) ([]domain.Run, error) {
	if owner == "" || !validID(cid) {
		return nil, domain.ErrInvalid
	}
	return s.store.ListActive(ctx, owner, cid)
}
func (s *Service) Events(ctx context.Context, owner, id string, after int64, limit int) (domain.EventPage, error) {
	if owner == "" || !validID(id) || after < 0 || limit < 1 || limit > 100 {
		return domain.EventPage{}, domain.ErrInvalid
	}
	return s.store.Events(ctx, owner, id, after, limit)
}
func (s *Service) UpdateAuth(ctx context.Context, actor Actor, bearer, id, epoch string) (domain.Run, error) {
	run, e := s.Get(ctx, actor.OwnerID, id)
	if e != nil {
		return run, e
	}
	if actor.SessionID != run.ParentSessionID {
		return domain.Run{}, domain.ErrParentSession
	}
	cred, e := credential(ctx, actor, bearer, run.Deadline)
	if e != nil {
		return domain.Run{}, e
	}
	if cred.Canvas.Digest() != run.CanvasWriterDigest {
		return domain.Run{}, httpapi.Fail(409, "EDIT_SESSION_EXPIRED", "此助手运行属于先前的画布编辑会话，请在当前画布重新发起。")
	}
	if s.executor == nil {
		return domain.Run{}, domain.ErrDisabled
	}
	if e = s.executor.Revalidate(ctx, cred); e != nil {
		return domain.Run{}, e
	}
	s.mu.Lock()
	entry, exists := s.credentials[id]
	same := exists && entry.digest == sha256.Sum256([]byte(bearer))
	s.mu.Unlock()
	if same && entry.credential.Epoch == run.CredentialEpoch && run.State != domain.WaitingAuth {
		return run, nil
	}
	run, e = s.store.UpdateAuth(ctx, actor.OwnerID, id, actor.SessionID, epoch, actor.IssuedAt, actor.AccessExpiresAt, cred.ExpiresAt)
	if e != nil {
		return domain.Run{}, e
	}
	cred.Epoch = run.CredentialEpoch
	s.mu.Lock()
	existing, ok := s.credentials[id]
	if !ok || !existing.credential.Actor.IssuedAt.After(actor.IssuedAt) && !existing.credential.Actor.AccessExpiresAt.After(actor.AccessExpiresAt) {
		s.credentials[id] = credentialEntry{cred, sha256.Sum256([]byte(bearer))}
	}
	s.mu.Unlock()
	s.notify()
	return run, nil
}
func (s *Service) Cancel(ctx context.Context, owner, id string) (domain.Run, error) {
	run, e := s.store.Cancel(ctx, owner, id)
	if e != nil {
		return run, e
	}
	s.mu.Lock()
	if cancel := s.active[id]; cancel != nil {
		cancel()
	}
	delete(s.credentials, id)
	s.mu.Unlock()
	return run, nil
}
func (s *Service) current(run domain.Run) (Credential, error) {
	s.mu.Lock()
	entry, ok := s.credentials[run.ID]
	s.mu.Unlock()
	if !ok || entry.credential.Actor.OwnerID != run.OwnerID || entry.credential.Actor.SessionID != run.ParentSessionID || !time.Now().Before(entry.credential.ExpiresAt) {
		return Credential{}, domain.ErrAuth
	}
	return entry.credential, nil
}

// Worker has its own bounded pool, separate from generation-task workers.
func (s *Service) Worker(ctx context.Context) error {
	if e := s.store.Recover(ctx); e != nil {
		return e
	}
	if !s.Enabled() {
		return nil
	}
	var wg sync.WaitGroup
	for i := 0; i < s.config.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			timer := time.NewTicker(time.Second)
			defer timer.Stop()
			for {
				if ctx.Err() != nil {
					return
				}
				run, e := s.store.Claim(ctx, s.config.LeaseDuration)
				if e == nil && run != nil {
					s.execute(ctx, *run)
					continue
				}
				select {
				case <-ctx.Done():
					return
				case <-timer.C:
				case <-s.wake:
				}
			}
		}()
	}
	<-ctx.Done()
	wg.Wait()
	return nil
}
func (s *Service) execute(parent context.Context, run domain.Run) {
	parent = observability.WithLogID(parent, observability.TaskLogID(run.ID))
	if !time.Now().Before(run.Deadline) {
		_ = s.store.Finish(parent, run, domain.TimedOut, "RUN_DEADLINE", RuntimeResult{})
		return
	}
	if _, e := s.current(run); e != nil {
		_ = s.store.WaitAuth(parent, run.ID, run.LeaseToken, "AUTH_CONTEXT_REQUIRED")
		return
	}
	messages, e := s.store.History(parent, run)
	if e != nil {
		_ = s.store.Finish(parent, run, domain.Failed, "HISTORY_UNAVAILABLE", RuntimeResult{})
		return
	}
	var prompt gateway.PromptSpec
	if json.Unmarshal(run.PromptSpec, &prompt) != nil || prompt.TemplateSHA256 != run.PromptHash || run.ToolSchemaHash != SchemaHash() || run.ProfileVersion != ProfileVersion {
		_ = s.store.Finish(parent, run, domain.Failed, "AGENT_PROFILE_CHANGED", RuntimeResult{})
		return
	}
	request := RuntimeRequest{RunID: run.ID, OwnerID: run.OwnerID, ConversationID: run.ConversationID, Model: run.Model, Effort: run.Effort, Messages: messages, Tools: Tools(), PromptHash: run.PromptHash, ToolSchemaHash: run.ToolSchemaHash, ProfileVersion: run.ProfileVersion, Instructions: ToolPolicy, Checkpoint: run.Checkpoint, ReconcileOnly: run.RuntimeStarted}
	for _, i := range prompt.Instructions {
		switch i.Role {
		case "SYSTEM":
			request.BaseInstructions += i.Text + "\n"
		case "DEVELOPER":
			request.DeveloperInstructions += i.Text + "\n"
		default:
			_ = s.store.Finish(parent, run, domain.Failed, "AGENT_PROMPT_INVALID", RuntimeResult{})
			return
		}
	}
	if run.RuntimeStarted && len(run.Checkpoint) == 0 {
		_ = s.store.Finish(parent, run, domain.Unknown, "RUNTIME_SUBMISSION_UNKNOWN", RuntimeResult{})
		return
	}
	if e = s.store.MarkRuntimeStarted(parent, run.ID, run.LeaseToken); e != nil {
		return
	}
	ctx, cancel := context.WithDeadline(parent, run.Deadline)
	defer cancel()
	s.mu.Lock()
	s.active[run.ID] = cancel
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.active, run.ID); s.mu.Unlock() }()
	heartbeatDone := make(chan struct{})
	defer close(heartbeatDone)
	go func() {
		ticker := time.NewTicker(s.config.LeaseDuration / 3)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatDone:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := s.store.Renew(ctx, run.ID, run.LeaseToken, s.config.LeaseDuration); err != nil {
					logRunFailure(ctx, run.ID, "HEARTBEAT_RENEW", err)
					cancel()
					return
				}
			}
		}
	}()
	broker := &broker{s: s, run: run}
	result, e := s.runtime.Run(ctx, request, broker)
	if len(result.Checkpoint) > 0 {
		_ = s.store.SaveCheckpoint(parent, run.ID, run.LeaseToken, result.Checkpoint)
	}
	if errors.Is(e, domain.ErrAuth) {
		_ = s.store.WaitAuth(parent, run.ID, run.LeaseToken, "AUTH_CONTEXT_REQUIRED")
		return
	}
	if parent.Err() != nil {
		_ = s.store.WaitAuth(context.Background(), run.ID, run.LeaseToken, "SERVICE_RESTART")
		return
	}
	state, code := domain.Succeeded, ""
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		state, code = domain.TimedOut, "RUN_DEADLINE"
	} else if errors.Is(e, domain.ErrBudget) {
		state, code = domain.Failed, "TOOL_BUDGET_EXCEEDED"
	} else if errors.Is(e, domain.ErrToolRejected) {
		state, code = domain.Failed, "TOOL_CALLBACK_REJECTED"
	} else if e != nil || !result.TerminalVerified {
		state, code = domain.Unknown, "RUNTIME_RESULT_UNVERIFIED"
	} else if len(result.Text) > 200000 || strings.ContainsRune(result.Text, 0) {
		state, code = domain.Failed, "ASSISTANT_REPLY_INVALID"
	} else if strings.TrimSpace(result.Text) == "" {
		state, code = domain.Failed, "EMPTY_ASSISTANT_REPLY"
	}
	_ = s.store.Finish(parent, run, state, code, result)
	if !state.Active() {
		s.mu.Lock()
		delete(s.credentials, run.ID)
		s.mu.Unlock()
	}
}

type broker struct {
	s   *Service
	run domain.Run
	mu  sync.Mutex
}

func (b *broker) Bind(ctx context.Context, thread, turn string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if thread == "" || turn == "" || len(thread) > 200 || len(turn) > 200 {
		return domain.ErrToolRejected
	}
	if e := b.s.store.Bind(ctx, b.run.ID, b.run.LeaseToken, thread, turn); e != nil {
		return e
	}
	b.run.NativeThreadID = thread
	b.run.NativeTurnID = turn
	return nil
}
func (b *broker) SaveCheckpoint(ctx context.Context, checkpoint json.RawMessage) error {
	if len(checkpoint) == 0 || len(checkpoint) > 4<<20 || !json.Valid(checkpoint) {
		return domain.ErrInvalid
	}
	return b.s.store.SaveCheckpoint(ctx, b.run.ID, b.run.LeaseToken, checkpoint)
}
func (b *broker) HandleTool(ctx context.Context, call RuntimeToolCall) (RuntimeToolResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if call.Namespace != "" || call.ThreadID != b.run.NativeThreadID || call.TurnID != b.run.NativeTurnID || call.ThreadID == "" || call.TurnID == "" || call.CallID == "" || len(call.CallID) > 200 {
		return RuntimeToolResult{}, domain.ErrToolRejected
	}
	request, args, e := ToolHTTP(b.run, call)
	if e != nil {
		return RuntimeToolResult{Output: json.RawMessage(`{"code":"TOOL_REJECTED","message":"Unknown tool or invalid typed arguments."}`)}, nil
	}
	evidence := domain.ToolCall{RunID: b.run.ID, OwnerID: b.run.OwnerID, NativeCallID: call.CallID, NativeThreadID: call.ThreadID, NativeTurnID: call.TurnID, Name: call.Name, Namespace: call.Namespace, Arguments: args, ArgumentHash: hashBytes(args), RequestHash: requestHash(request), OperationKey: request.IdempotencyKey, State: "PENDING"}
	stored, e := b.s.store.BeginTool(ctx, b.run, evidence, b.s.config.MaxToolCalls)
	if e != nil {
		return RuntimeToolResult{}, e
	}
	cred, e := b.waitCredential(ctx)
	if e != nil {
		logRunFailure(ctx, b.run.ID, "BROKER_WAIT_CREDENTIAL", e)
		return RuntimeToolResult{}, e
	}
	if stored.State != "PENDING" {
		return RuntimeToolResult{Success: stored.Success, Output: stored.Result}, nil
	}
	var response ToolResponse
	for {
		response, e = b.s.executor.Execute(ctx, cred, request)
		if e != nil {
			logRunFailure(ctx, b.run.ID, "BROKER_EXECUTE", e)
			return RuntimeToolResult{}, e
		}
		if response.Status != 401 && response.Status != 403 {
			break
		}
		b.s.mu.Lock()
		delete(b.s.credentials, b.run.ID)
		b.s.mu.Unlock()
		cred, e = b.waitCredential(ctx)
		if e != nil {
			logRunFailure(ctx, b.run.ID, "BROKER_WAIT_CREDENTIAL", e)
			return RuntimeToolResult{}, e
		}
	}

	// A failed write response can follow an unknown committed transaction. Keep
	// the pending stable-key evidence; never invite a fresh model retry/key.
	if request.Method == "POST" && response.Status >= 500 {
		logRunFailure(ctx, b.run.ID, "BROKER_WRITE_HTTP_5XX", domain.ErrUnavailable)
		return RuntimeToolResult{}, domain.ErrUnavailable
	}

	if e = b.s.store.CompleteTool(ctx, b.run, evidence, response); e != nil {
		logRunFailure(ctx, b.run.ID, "BROKER_COMPLETE_TOOL", e)
		return RuntimeToolResult{}, e
	}
	return RuntimeToolResult{Success: response.Status >= 200 && response.Status < 300, Output: response.Data}, nil
}

func (b *broker) waitCredential(ctx context.Context) (Credential, error) {
	paused := false
	for {
		cred, err := b.s.current(b.run)
		if err == nil {
			err = b.s.executor.Revalidate(ctx, cred)
		}
		if err == nil {
			return cred, nil
		}
		if !errors.Is(err, domain.ErrAuth) {
			return Credential{}, err
		}
		if !paused {
			if err = b.s.store.PauseAuth(ctx, b.run.ID, b.run.LeaseToken, "AUTH_CONTEXT_REQUIRED"); err != nil {
				return Credential{}, err
			}
			paused = true
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return Credential{}, ctx.Err()
		case <-timer.C:
		}
	}
}
func (b *broker) VerifyToolReceipt(ctx context.Context, call RuntimeToolCall) (RuntimeToolResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if call.Namespace != "" || call.ThreadID != b.run.NativeThreadID || call.TurnID != b.run.NativeTurnID || call.ThreadID == "" || call.TurnID == "" || call.CallID == "" || len(call.CallID) > 200 {
		return RuntimeToolResult{}, domain.ErrToolRejected
	}
	request, args, err := ToolHTTP(b.run, call)
	if err != nil {
		return RuntimeToolResult{}, err
	}
	if _, err = b.waitCredential(ctx); err != nil {
		return RuntimeToolResult{}, err
	}
	evidence := domain.ToolCall{RunID: b.run.ID, OwnerID: b.run.OwnerID, NativeCallID: call.CallID, NativeThreadID: call.ThreadID, NativeTurnID: call.TurnID, Name: call.Name, Namespace: call.Namespace, Arguments: args, ArgumentHash: hashBytes(args), RequestHash: requestHash(request), OperationKey: request.IdempotencyKey}
	stored, err := b.s.store.ToolReceipt(ctx, b.run, evidence)
	if err != nil {
		return RuntimeToolResult{}, err
	}
	return RuntimeToolResult{Success: stored.Success, Output: stored.Result}, nil
}
