package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
)

// The project storage owner stays a. The conversation, credentials and Agent
// evidence all belong to the actual collaborator b; no runtime is invoked.
func sharedAgentDB(t *testing.T) (*Store, *pgxpool.Pool, application.CreateRecord) {
	t.Helper()
	s, db, record := agentDB(t)
	ctx := context.Background()
	for _, query := range []string{
		`INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('p','b','EDITOR','a')`,
		`INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id,title,next_message_sequence,revision) VALUES('cid-shared-b','b','CANVAS','p','B private shared-project chat',2,2)`,
		`INSERT INTO assistant.messages(id,owner_id,conversation_id,sequence,role,content) VALUES('mb-shared','b','cid-shared-b',1,'USER','[{"type":"TEXT","text":"Private"}]')`,
	} {
		if _, err := db.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	record.Run.ID = "agr_shared_b"
	record.Run.OwnerID = "b"
	record.Run.ParentSessionID = "sid-b"
	record.Run.ConversationID = "cid-shared-b"
	record.Run.MessageID = "mb-shared"
	record.Actor.OwnerID = "b"
	record.Actor.SessionID = "sid-b"
	return s, db, record
}

func changeSharedAgentRole(t *testing.T, db *pgxpool.Pool, role string) {
	t.Helper()
	query := `DELETE FROM collaboration.project_members WHERE project_id='p' AND user_id='b'`
	if role == "VIEWER" {
		query = `UPDATE collaboration.project_members SET role='VIEWER' WHERE project_id='p' AND user_id='b'`
	}
	if _, err := db.Exec(context.Background(), query); err != nil {
		t.Fatal(err)
	}
}

func requireSharedAgentDenied(t *testing.T, err error, role string) {
	t.Helper()
	if role == "REMOVED" && errors.Is(err, domain.ErrNotFound) {
		return
	}
	var failure *httpapi.Error
	if errors.As(err, &failure) && (role == "REMOVED" && failure.Status == 404 || role == "VIEWER" && failure.Status == 403) {
		return
	}
	t.Fatalf("%s collaborator mutation was not denied with the resource access error: %v", role, err)
}

func requireNoSharedAgentJobs(t *testing.T, db *pgxpool.Pool) {
	t.Helper()
	var tasks, calls int
	if err := db.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM execution.tasks),(SELECT count(*) FROM assistant.agent_tool_calls)`).Scan(&tasks, &calls); err != nil {
		t.Fatal(err)
	}
	if tasks != 0 || calls != 0 {
		t.Fatalf("Agent authorization produced work: tasks=%d tool calls=%d", tasks, calls)
	}
}

func TestAgentSharedProjectPreservesActorSessionAndPrivateConversation(t *testing.T) {
	s, db, record := sharedAgentDB(t)
	ctx := context.Background()
	wrongParent := record
	wrongParent.Run.ParentSessionID = "sid-a"
	if _, err := s.Create(ctx, wrongParent); !errors.Is(err, domain.ErrAuth) {
		t.Fatal("shared-project Agent accepted the storage owner's session", err)
	}
	created, err := s.Create(ctx, record)
	if err != nil {
		t.Fatal(err)
	}
	if created.OwnerID != "b" || created.ParentSessionID != "sid-b" || created.ProjectID != "p" || created.ConversationID != record.Run.ConversationID || created.MessageID != record.Run.MessageID {
		t.Fatal("shared project replaced the actual Agent principal", created)
	}
	var runOwner, sessionOwner, projectOwner, conversationOwner string
	if err := db.QueryRow(ctx, `SELECT r.owner_id,s.user_id,p.owner_id,c.owner_id FROM assistant.agent_runs r JOIN public.sessions s ON s.id=r.parent_session_id JOIN public.projects p ON p.id=r.project_id JOIN assistant.conversations c ON c.id=r.conversation_id WHERE r.id=$1`, created.ID).Scan(&runOwner, &sessionOwner, &projectOwner, &conversationOwner); err != nil {
		t.Fatal(err)
	}
	if runOwner != "b" || sessionOwner != "b" || projectOwner != "a" || conversationOwner != "b" {
		t.Fatalf("stored ownership/session mismatch: run=%s session=%s project=%s conversation=%s", runOwner, sessionOwner, projectOwner, conversationOwner)
	}
	if _, err := s.Get(ctx, "a", created.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("project owner could read collaborator's private run", err)
	}
	if _, err := s.Events(ctx, "a", created.ID, 0, 100); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("project owner could read collaborator's private events", err)
	}
	if _, err := s.ListActive(ctx, "a", record.Run.ConversationID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("project owner could list collaborator's private conversation", err)
	}
	active, err := s.ListActive(ctx, "b", record.Run.ConversationID)
	if err != nil || len(active) != 1 || active[0].ID != created.ID {
		t.Fatal("actual collaborator cannot find its own run", active, err)
	}
	claimed, err := s.Claim(ctx, time.Minute)
	if err != nil || claimed == nil || claimed.ID != created.ID || claimed.OwnerID != "b" || claimed.ParentSessionID != "sid-b" || claimed.State != domain.Running {
		t.Fatal("claimed run lost the actual actor/session", claimed, err)
	}
	history, err := s.History(ctx, *claimed)
	if err != nil || len(history) != 1 || history[0].Text != "Private" || strings.Contains(history[0].Text, "Create a scene") {
		t.Fatal("Agent history crossed private conversations", history, err)
	}
	page, err := s.Events(ctx, "b", created.ID, 0, 100)
	if err != nil || len(page.Items) != 2 || page.Terminal {
		t.Fatal("actual collaborator cannot read queued/running evidence", page, err)
	}
	requireNoSharedAgentJobs(t, db)
}

func TestAgentSharedProjectQueuedRevocationFailsBeforeWorkerClaim(t *testing.T) {
	for _, role := range []string{"REMOVED", "VIEWER"} {
		t.Run(role, func(t *testing.T) {
			s, db, record := sharedAgentDB(t)
			ctx := context.Background()
			created, err := s.Create(ctx, record)
			if err != nil {
				t.Fatal(err)
			}
			changeSharedAgentRole(t, db, role)
			claimed, err := s.Claim(ctx, time.Minute)
			if err != nil || claimed != nil {
				t.Fatal("worker received a revoked collaborator run", claimed, err)
			}
			var state, code, owner, sid string
			var leased, started bool
			if err := db.QueryRow(ctx, `SELECT state,error_code,owner_id,parent_session_id,lease_token IS NOT NULL,runtime_started FROM assistant.agent_runs WHERE id=$1`, created.ID).Scan(&state, &code, &owner, &sid, &leased, &started); err != nil {
				t.Fatal(err)
			}
			if state != "FAILED" || code != "PROJECT_ACCESS_REVOKED" || owner != "b" || sid != "sid-b" || leased || started {
				t.Fatalf("revocation was not durably failed before runtime: state=%s code=%s owner=%s sid=%s leased=%v started=%v", state, code, owner, sid, leased, started)
			}
			var payload []byte
			if err := db.QueryRow(ctx, `SELECT data FROM assistant.agent_events WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1`, created.ID).Scan(&payload); err != nil {
				t.Fatal(err)
			}
			var evidence struct{ State, ErrorCode string }
			if err := json.Unmarshal(payload, &evidence); err != nil || evidence.State != "FAILED" || evidence.ErrorCode != "PROJECT_ACCESS_REVOKED" {
				t.Fatal("missing durable revocation event", string(payload), err)
			}
			// A terminal receipt and a new operation both recheck write access.
			_, err = s.Create(ctx, record)
			requireSharedAgentDenied(t, err, role)
			record.Run.ID = "agr_after_revocation"
			record.Run.IdempotencyKey = uuid.NewString()
			_, err = s.Create(ctx, record)
			requireSharedAgentDenied(t, err, role)
			_, err = s.Cancel(ctx, "b", created.ID)
			requireSharedAgentDenied(t, err, role)
			if claimed, err := s.Claim(ctx, time.Minute); err != nil || claimed != nil {
				t.Fatal("failed run returned to the worker queue", claimed, err)
			}
			requireNoSharedAgentJobs(t, db)
		})
	}
}

func TestAgentSharedProjectRunningRevocationRejectsToolsAndCredentials(t *testing.T) {
	for _, role := range []string{"REMOVED", "VIEWER"} {
		t.Run(role, func(t *testing.T) {
			s, db, record := sharedAgentDB(t)
			ctx := context.Background()
			if _, err := s.Create(ctx, record); err != nil {
				t.Fatal(err)
			}
			run, err := s.Claim(ctx, time.Minute)
			if err != nil || run == nil {
				t.Fatal(run, err)
			}
			if err := s.Bind(ctx, run.ID, run.LeaseToken, "shared-thread", "shared-turn"); err != nil {
				t.Fatal(err)
			}
			run.NativeThreadID, run.NativeTurnID = "shared-thread", "shared-turn"
			var sequence int64
			if err := db.QueryRow(ctx, `SELECT event_sequence FROM assistant.agent_runs WHERE id=$1`, run.ID).Scan(&sequence); err != nil {
				t.Fatal(err)
			}
			changeSharedAgentRole(t, db, role)
			call := domain.ToolCall{RunID: run.ID, OwnerID: "b", NativeCallID: "denied-model-call", NativeThreadID: run.NativeThreadID, NativeTurnID: run.NativeTurnID, Name: "studio_node_run", Arguments: json.RawMessage(`{"nodeId":"node"}`), ArgumentHash: strings.Repeat("c", 64), RequestHash: strings.Repeat("d", 64), OperationKey: application.OperationKey(run.ID, "denied-model-call"), State: "PENDING"}
			_, err = s.BeginTool(ctx, *run, call, 10)
			requireSharedAgentDenied(t, err, role)
			_, err = s.Cancel(ctx, "b", run.ID)
			requireSharedAgentDenied(t, err, role)
			_, err = s.UpdateAuth(ctx, "b", run.ID, "sid-b", run.CredentialEpoch, record.Actor.IssuedAt.Add(time.Second), record.Actor.AccessExpiresAt.Add(time.Second), run.AuthExpiresAt)
			requireSharedAgentDenied(t, err, role)
			var state, epoch, lease string
			var toolCount int
			var after int64
			if err := db.QueryRow(ctx, `SELECT state,credential_epoch::text,lease_token::text,tool_count,event_sequence FROM assistant.agent_runs WHERE id=$1`, run.ID).Scan(&state, &epoch, &lease, &toolCount, &after); err != nil {
				t.Fatal(err)
			}
			if state != "RUNNING" || epoch != run.CredentialEpoch || lease != run.LeaseToken || toolCount != 0 || after != sequence {
				t.Fatal("denied mutations changed stored run or evidence", state, epoch, lease, toolCount, after)
			}
			requireNoSharedAgentJobs(t, db)
		})
	}
}
