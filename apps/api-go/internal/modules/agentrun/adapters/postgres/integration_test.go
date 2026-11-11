package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/adapters/pfhttp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	assistantPG "studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	assistantApp "studiotv.local/service/api/internal/modules/assistant/application"
	assistantDomain "studiotv.local/service/api/internal/modules/assistant/domain"
	"studiotv.local/service/api/internal/testdb"
)

func agentDB(t *testing.T) (*Store, *pgxpool.Pool, application.CreateRecord) {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if e := database.Migrate(ctx, db); e != nil {
			t.Fatal(e)
		}
	}
	for _, sql := range []string{
		`INSERT INTO users(id,email,display_name)VALUES('a','agent-a@example.test','A'),('b','agent-b@example.test','B')`,
		`INSERT INTO projects(id,owner_id,name)VALUES('p','a','P'),('pb','b','PB')`,
		`INSERT INTO sessions(id,user_id,expires_at)VALUES('sid-a','a',now()+interval '1 hour'),('sid-b','b',now()+interval '1 hour'),('sid-new','a',now()+interval '1 hour')`,
		`INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id,title,next_message_sequence,revision)VALUES('cid','a','CANVAS','p','A',2,2),('cid-b','b','CANVAS','pb','B',2,2)`,
		`INSERT INTO assistant.messages(id,owner_id,conversation_id,sequence,role,content)VALUES('m','a','cid',1,'USER','[{"type":"TEXT","text":"Create a scene /storage/assets/a?token=SIGNED_HISTORY_SECRET and https://reference.example/scene?style=blue"}]'),('mb','b','cid-b',1,'USER','[{"type":"TEXT","text":"Private"}]')`,
	} {
		if _, e := db.Exec(ctx, sql); e != nil {
			t.Fatal(e)
		}
	}
	s, _ := New(db)
	now := time.Now().UTC().Truncate(time.Second)
	r := domain.Run{ID: "agr_test", Kind: "AGENT", OwnerID: "a", ParentSessionID: "sid-a", ConversationID: "cid", MessageID: "m", IdempotencyKey: uuid.NewString(), RequestHash: strings.Repeat("a", 64), CapabilityRef: application.CapabilityRef, CapabilityVersion: application.CapabilityVersion, Parameters: json.RawMessage(`{}`), ExpectedRevision: 1, State: domain.Queued, CredentialEpoch: "1", AuthExpiresAt: now.Add(5 * time.Minute), CreatedAt: now, UpdatedAt: now, Deadline: now.Add(10 * time.Minute), Model: "gpt-6.1-sol", Effort: "low", PromptHash: strings.Repeat("b", 64), ToolSchemaHash: application.SchemaHash(), ProfileVersion: application.ProfileVersion, PromptSpec: json.RawMessage(`{"schemaVersion":"1"}`)}
	a := application.Actor{OwnerID: "a", SessionID: "sid-a", IssuedAt: now.Add(-time.Minute), AccessExpiresAt: now.Add(5 * time.Minute), SessionExpiresAt: now.Add(time.Hour)}
	return s, db, application.CreateRecord{Run: r, Actor: a}
}
func TestAgentStoreOwnershipOneActiveAndStableCreateReceipt(t *testing.T) {
	s, db, record := agentDB(t)
	ctx := context.Background()
	r, e := s.Create(ctx, record)
	if e != nil || r.ProjectID != "p" {
		t.Fatal(r, e)
	}
	assistantUOW, _ := assistantPG.New(db)
	assistantService, _ := assistantApp.New(assistantUOW)
	if _, err := assistantService.Delete(ctx, assistantDomain.VerifiedActor{OwnerID: "a"}, "cid", 2); !errors.Is(err, assistantDomain.ErrTaskActive) {
		t.Fatal("active Agent conversation deleted", err)
	}
	var deleted *time.Time
	if err := db.QueryRow(ctx, `SELECT deleted_at FROM assistant.conversations WHERE id='cid'`).Scan(&deleted); err != nil || deleted != nil {
		t.Fatal("failed delete changed conversation", deleted, err)
	}
	replay, e := s.Create(ctx, record)
	if e != nil || replay.ID != r.ID {
		t.Fatal("creation replay", replay, e)
	}
	other := record
	other.Run.ID = "agr_another"
	other.Run.IdempotencyKey = uuid.NewString()
	if _, e = s.Create(ctx, other); !errors.Is(e, domain.ErrActive) {
		t.Fatal("two active same conversation", e)
	}
	if _, e = s.Get(ctx, "b", r.ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("cross owner run access", e)
	}
	if _, e = s.Events(ctx, "b", r.ID, 0, 100); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("cross owner event access", e)
	}
	other = record
	other.Run.RequestHash = strings.Repeat("f", 64)
	if _, e = s.Create(ctx, other); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("same key changed request", e)
	}
	if _, e = db.Exec(ctx, `UPDATE assistant.agent_runs SET parent_session_id='sid-new' WHERE id=$1`, r.ID); e == nil {
		t.Fatal("binding trigger allowed parent transfer")
	}
	wrong := record
	wrong.Run.ID = "agr_bad"
	wrong.Run.ParentSessionID = "sid-b"
	wrong.Run.IdempotencyKey = uuid.NewString()
	_, _ = s.Cancel(ctx, "a", r.ID)
	if _, e = s.Create(ctx, wrong); !errors.Is(e, domain.ErrAuth) {
		t.Fatal("parent foreign owner", e)
	}
}
func TestAgentToolsPersistNativeBindingCanonicalHashAndReceipts(t *testing.T) {
	s, db, record := agentDB(t)
	ctx := context.Background()
	if _, e := s.Create(ctx, record); e != nil {
		t.Fatal(e)
	}
	r, e := s.Claim(ctx, 30*time.Second)
	if e != nil || r == nil {
		t.Fatal(r, e)
	}
	history, historyErr := s.History(ctx, *r)
	if historyErr != nil || len(history) != 1 || strings.Contains(history[0].Text, "SIGNED_HISTORY_SECRET") || strings.Contains(history[0].Text, "/storage/assets/") || !strings.Contains(history[0].Text, "Create a scene") || !strings.Contains(history[0].Text, "https://reference.example/scene?style=blue") {
		t.Fatal("history projection leaked signed link or changed ordinary creative URL", history, historyErr)
	}
	var storedContent []byte
	if err := db.QueryRow(ctx, `SELECT content FROM assistant.messages WHERE id='m'`).Scan(&storedContent); err != nil || !strings.Contains(string(storedContent), "SIGNED_HISTORY_SECRET") {
		t.Fatal("history projection altered persisted user message", err)
	}

	if e = s.MarkRuntimeStarted(ctx, r.ID, r.LeaseToken); e != nil {
		t.Fatal(e)
	}
	if e = s.Bind(ctx, r.ID, r.LeaseToken, "native-thread", "native-turn"); e != nil {
		t.Fatal(e)
	}
	r.NativeThreadID = "native-thread"
	r.NativeTurnID = "native-turn"
	call := domain.ToolCall{RunID: r.ID, OwnerID: r.OwnerID, NativeCallID: "native-call", NativeThreadID: r.NativeThreadID, NativeTurnID: r.NativeTurnID, Name: "studio_canvas_read", Arguments: json.RawMessage(`{}`), ArgumentHash: strings.Repeat("c", 64), RequestHash: strings.Repeat("d", 64), OperationKey: application.OperationKey(r.ID, "native-call"), State: "PENDING"}
	stored, e := s.BeginTool(ctx, *r, call, 1)
	if e != nil || stored.State != "PENDING" {
		t.Fatal(stored, e)
	}
	response := application.ToolResponse{Status: 200, Data: json.RawMessage(`{"graphRevision":1}`)}
	if e = s.CompleteTool(ctx, *r, call, response); e != nil {
		t.Fatal(e)
	}
	replay, e := s.BeginTool(ctx, *r, call, 1)
	if e != nil || replay.State != "SUCCEEDED" || string(replay.Result) != `{"graphRevision":1}` {
		t.Fatal("durable normalized exact native receipt replay", replay, e)
	}
	verified, e := s.ToolReceipt(ctx, *r, call)
	if e != nil || string(verified.Result) != string(response.Data) {
		t.Fatal("JSONB whitespace changed native tool receipt", verified, e)
	}

	different := call
	different.ArgumentHash = strings.Repeat("e", 64)
	if _, e = s.BeginTool(ctx, *r, different, 1); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("same native call changed arguments", e)
	}
	different = call
	different.NativeCallID = "new-call"
	different.OperationKey = application.OperationKey(r.ID, "new-call")
	if _, e = s.BeginTool(ctx, *r, different, 1); !errors.Is(e, domain.ErrBudget) {
		t.Fatal("tool budget not durable", e)
	}
	if _, e = db.Exec(ctx, `UPDATE assistant.agent_tool_calls SET result='{}' WHERE run_id=$1`, r.ID); e == nil {
		t.Fatal("rewrote committed tool evidence")
	}
	if e = s.SaveCheckpoint(ctx, r.ID, r.LeaseToken, json.RawMessage(`{"private":"native-only"}`)); e != nil {
		t.Fatal(e)
	}
	page, e := s.Events(ctx, "a", r.ID, 0, 100)
	if e != nil || len(page.Items) != 4 {
		t.Fatal("real event history", page, e)
	}
	for _, item := range page.Items {
		if strings.Contains(string(item.Data), "native-thread") || strings.Contains(string(item.Data), "native-only") {
			t.Fatal("private origin in events")
		}
	}
	if e = s.Finish(ctx, *r, domain.Succeeded, "", application.RuntimeResult{Text: "Created the scene using the tool receipt.", TerminalVerified: true}); e != nil {
		t.Fatal(e)
	}
	done, e := s.Get(ctx, "a", r.ID)
	if e != nil || done.State != domain.Succeeded || done.AssistantMessageID == nil {
		t.Fatal(done, e)
	}
	var text string
	var content []byte
	if e = db.QueryRow(ctx, `SELECT content FROM assistant.messages WHERE id=$1 AND owner_id='a'`, *done.AssistantMessageID).Scan(&content); e != nil {
		t.Fatal(e)
	}
	text = string(content)
	if !strings.Contains(text, "Created the scene") {
		t.Fatal("assistant history absent")
	}
	if _, e = db.Exec(ctx, `DELETE FROM assistant.agent_events WHERE run_id=$1`, r.ID); e == nil {
		t.Fatal("deleted durable events")
	}
}

func TestAgentEventsPageInNumericSequenceAcrossNineToTen(t *testing.T) {
	s, _, record := agentDB(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, record); err != nil {
		t.Fatal(err)
	}
	run, err := s.Claim(ctx, 45*time.Second)
	if err != nil || run == nil {
		t.Fatal(run, err)
	}
	if err := s.Bind(ctx, run.ID, run.LeaseToken, "native-thread", "native-turn"); err != nil {
		t.Fatal(err)
	}
	run.NativeThreadID, run.NativeTurnID = "native-thread", "native-turn"
	for i := 0; i < 10; i++ {
		callID := "native-call-" + strconv.Itoa(i)
		call := domain.ToolCall{RunID: run.ID, OwnerID: run.OwnerID, NativeCallID: callID, NativeThreadID: run.NativeThreadID, NativeTurnID: run.NativeTurnID, Name: "studio_canvas_read", Arguments: json.RawMessage(`{}`), ArgumentHash: strings.Repeat("c", 64), RequestHash: strings.Repeat("d", 64), OperationKey: application.OperationKey(run.ID, callID), State: "PENDING"}
		if _, err := s.BeginTool(ctx, *run, call, 32); err != nil {
			t.Fatal(err)
		}
		if err := s.CompleteTool(ctx, *run, call, application.ToolResponse{Status: 200, Data: json.RawMessage(`{"graphRevision":1}`)}); err != nil {
			t.Fatal(err)
		}
	}
	assertPage := func(after int64, limit, first, last int, terminal bool) {
		t.Helper()
		page, err := s.Events(ctx, run.OwnerID, run.ID, after, limit)
		if err != nil || page.Terminal != terminal || len(page.Items) != last-first+1 {
			t.Fatalf("unexpected page after %d: %+v, %v", after, page, err)
		}
		for i, item := range page.Items {
			if want := strconv.Itoa(first + i); item.Sequence != want {
				t.Fatalf("page after %d has sequence %s at %d, want %s", after, item.Sequence, i, want)
			}
		}
		wantCursor := strconv.FormatInt(after, 10)
		if len(page.Items) > 0 {
			wantCursor = strconv.Itoa(last)
		}
		if page.NextCursor != wantCursor {
			t.Fatalf("page after %d cursor %s, want %s", after, page.NextCursor, wantCursor)
		}
	}
	assertPage(0, 9, 1, 9, false)
	assertPage(9, 1, 10, 10, false)
	assertPage(9, 9, 10, 18, false)
	assertPage(18, 9, 19, 22, false)
	if err := s.Finish(ctx, *run, domain.Succeeded, "", application.RuntimeResult{Text: "Completed tools.", TerminalVerified: true}); err != nil {
		t.Fatal(err)
	}
	assertPage(18, 9, 19, 24, true)
	assertPage(24, 9, 25, 24, true)
}
func TestAgentRestartWaitsForSameParentAndRejectsCredentialRegression(t *testing.T) {
	s, _, record := agentDB(t)
	ctx := context.Background()
	created, e := s.Create(ctx, record)
	if e != nil {
		t.Fatal(e)
	}
	run, e := s.Claim(ctx, 30*time.Second)
	if e != nil || run == nil {
		t.Fatal(e)
	}
	if e = s.MarkRuntimeStarted(ctx, run.ID, run.LeaseToken); e != nil {
		t.Fatal(e)
	}
	if e = s.SaveCheckpoint(ctx, run.ID, run.LeaseToken, json.RawMessage(`{"submitted":true}`)); e != nil {
		t.Fatal(e)
	}
	if e = s.Recover(ctx); e != nil {
		t.Fatal(e)
	}
	waiting, e := s.Get(ctx, "a", run.ID)
	if e != nil || waiting.State != domain.WaitingAuth || !waiting.RuntimeStarted || waiting.LeaseToken != "" || len(waiting.Checkpoint) == 0 {
		t.Fatal(waiting, e)
	}
	if e = s.Renew(ctx, run.ID, run.LeaseToken, time.Minute); !errors.Is(e, domain.ErrFenced) {
		t.Fatal("restart failed to fence old worker", e)
	}
	a := record.Actor
	if _, e = s.UpdateAuth(ctx, "a", run.ID, "sid-new", "1", a.IssuedAt, a.AccessExpiresAt, created.AuthExpiresAt); !errors.Is(e, domain.ErrParentSession) {
		t.Fatal("new login adopted old run", e)
	}
	if _, e = s.UpdateAuth(ctx, "a", run.ID, "sid-a", "1", a.IssuedAt.Add(-time.Second), a.AccessExpiresAt, created.AuthExpiresAt); !errors.Is(e, domain.ErrAuthRegression) {
		t.Fatal("old token accepted", e)
	}
	ready, e := s.UpdateAuth(ctx, "a", run.ID, "sid-a", "1", a.IssuedAt, a.AccessExpiresAt, created.AuthExpiresAt)
	if e != nil || ready.CredentialEpoch != "2" || ready.State != domain.Queued {
		t.Fatal(ready, e)
	}
	if _, e = s.UpdateAuth(ctx, "a", run.ID, "sid-a", "1", a.IssuedAt, a.AccessExpiresAt, created.AuthExpiresAt); !errors.Is(e, domain.ErrAuthVersion) {
		t.Fatal("stale epoch accepted", e)
	}
	cancel, e := s.Cancel(ctx, "a", run.ID)
	if e != nil || cancel.State != domain.Canceled {
		t.Fatal(cancel, e)
	}
}

func TestAgentLiveAuthPauseRetainsLeaseAndResumesSameNativeTurn(t *testing.T) {
	s, _, record := agentDB(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, record); err != nil {
		t.Fatal(err)
	}
	run, err := s.Claim(ctx, 30*time.Second)
	if err != nil || run == nil {
		t.Fatal(err)
	}
	if err = s.Bind(ctx, run.ID, run.LeaseToken, "thread-live", "turn-live"); err != nil {
		t.Fatal(err)
	}
	if err = s.PauseAuth(ctx, run.ID, run.LeaseToken, "AUTH_CONTEXT_REQUIRED"); err != nil {
		t.Fatal(err)
	}
	waiting, err := s.Get(ctx, "a", run.ID)
	if err != nil || waiting.State != domain.WaitingAuth || waiting.LeaseToken != run.LeaseToken {
		t.Fatal("live pause released execution lease", waiting, err)
	}
	if err = s.Renew(ctx, run.ID, run.LeaseToken, 30*time.Second); err != nil {
		t.Fatal("waiting callback lost heartbeat", err)
	}
	a := record.Actor
	resumed, err := s.UpdateAuth(ctx, "a", run.ID, "sid-a", "1", a.IssuedAt.Add(time.Second), a.AccessExpiresAt.Add(time.Second), run.AuthExpiresAt.Add(time.Second))
	if err != nil || resumed.State != domain.Running || resumed.LeaseToken != run.LeaseToken || resumed.NativeTurnID != "turn-live" {
		t.Fatal("refresh restarted native turn", resumed, err)
	}
	if claimed, err := s.Claim(ctx, 30*time.Second); err != nil || claimed != nil {
		t.Fatal("second worker claimed paused in-flight run", claimed, err)
	}
}

func TestAgentAuthRefreshCannotRebindCanvasWriter(t *testing.T) {
	store, db, rec := agentDB(t)
	ctx := context.Background()
	proof, term := "test-private-agent-run-page-proof-for-studio-canvas", uuid.NewString()
	newTerm := uuid.NewString()
	page := func(lease string) context.Context {
		r := httptest.NewRequest("POST", "/", nil)
		r.Header.Set(collaboration.CanvasProofHeader, proof)
		r.Header.Set(collaboration.CanvasLeaseHeader, lease)
		return collaboration.WithCanvasLeaseRequest(collaboration.ContextWithCanvasProof(r), httpapi.Identity{UserID: "a", SessionID: "sid-a"}, "agent-page")
	}
	if _, e := db.Exec(ctx, `INSERT INTO collaboration.canvas_edit_sessions(project_id,actor_id,session_id,client_id,page_hash,lease_id,expires_at)
 VALUES('p','a','sid-a','agent-page',$1,$2,now()+interval '10 minutes')`, collaboration.CanvasProofDigest(proof), term); e != nil {
		t.Fatal(e)
	}
	if _, e := store.Create(page(newTerm), rec); e == nil {
		t.Fatal("non-holder queued an Agent")
	}
	run, e := store.Create(page(term), rec)
	if e != nil {
		t.Fatal(e)
	}
	var snapshot string
	if e = db.QueryRow(ctx, `SELECT snapshot::text FROM assistant.agent_runs WHERE id=$1`, run.ID).Scan(&snapshot); e != nil {
		t.Fatal(e)
	}
	if run.CanvasWriterDigest == "" || !strings.Contains(snapshot, run.CanvasWriterDigest) || strings.Contains(snapshot, proof) || strings.Contains(snapshot, term) {
		t.Fatal("did not persist only the delegation digest")
	}
	public, _ := json.Marshal(run)
	if strings.Contains(string(public), run.CanvasWriterDigest) {
		t.Fatal("private digest visible in run resource")
	}
	if _, e = db.Exec(ctx, `UPDATE collaboration.canvas_edit_sessions SET lease_id=$1 WHERE project_id='p'`, newTerm); e != nil {
		t.Fatal(e)
	}
	if _, e = store.Create(page(newTerm), rec); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("an idempotent creation replay rebound the agent", e)
	}
	// A fresh process has no in-memory page proof. It can restore the original
	// binding from its caller, but a newer tenure cannot adopt the same run.
	transport, e := pfhttp.New("http://unused.example.test", nil, func(context.Context, string) (application.Actor, error) { return rec.Actor, nil })
	if e != nil {
		t.Fatal(e)
	}
	service, e := application.New(store, nil, transport, application.Config{})
	if e != nil {
		t.Fatal(e)
	}
	var mismatch *httpapi.Error
	if _, e = service.UpdateAuth(page(newTerm), rec.Actor, "test-token", run.ID, "1"); !errors.As(e, &mismatch) || mismatch.Code != "EDIT_SESSION_EXPIRED" {
		t.Fatal("auth renewal borrowed a new tenure", e)
	}
	if _, e = service.UpdateAuth(page(term), rec.Actor, "test-token", run.ID, "1"); e != nil {
		t.Fatal(e)
	}
	if _, e = store.Cancel(page(term), "a", run.ID); !errors.As(e, &mismatch) || mismatch.Code != "EDIT_SESSION_EXPIRED" {
		t.Fatal("stale page canceled a canvas agent", e)
	}
	if _, e = store.Cancel(page(newTerm), "a", run.ID); e != nil {
		t.Fatal(e)
	}
}
