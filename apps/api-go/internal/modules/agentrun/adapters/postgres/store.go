// Package postgres stores Agent evidence using short fenced transactions.
package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/observability"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	canvas "studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type Store struct {
	db       *pgxpool.Pool
	observer *observability.Observer
}

func New(db *pgxpool.Pool) (*Store, error) {
	if db == nil {
		return nil, errors.New("agent postgres pool required")
	}
	return &Store{db: db}, nil
}

var _ application.Store = (*Store)(nil)

func dbError(e error) error {
	if e == nil {
		return nil
	}
	var p *pgconn.PgError
	if errors.As(e, &p) && p.Code == "23505" {
		return domain.ErrActive
	}
	return domain.ErrUnavailable
}
func (s *Store) within(ctx context.Context, f func(pgx.Tx) error) error {
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return domain.ErrUnavailable
	}
	defer tx.Rollback(ctx)
	if e = f(tx); e != nil {
		return e
	}
	return dbError(tx.Commit(ctx))
}

type frozen struct {
	CanvasWriterDigest                                                                          string `json:",omitempty"`
	CapabilityRef, CapabilityVersion, Model, Effort, PromptHash, ToolSchemaHash, ProfileVersion string
	Parameters                                                                                  json.RawMessage
	PromptSpec                                                                                  json.RawMessage
	ExpectedRevision                                                                            int64
}

const columns = `r.id,r.owner_id,r.parent_session_id,r.conversation_id,r.project_id,r.message_id,r.idempotency_key::text,r.request_hash,r.snapshot,r.state,r.credential_epoch::text,r.auth_expires_at,r.runtime_started,r.checkpoint,COALESCE(r.native_thread_id,''),COALESCE(r.native_turn_id,''),COALESCE(r.lease_token::text,''),r.lease_until,r.tool_count,r.assistant_message_id,r.error_code,r.usage,r.deadline,r.created_at,r.updated_at`

type scanner interface{ Scan(...any) error }

func scan(row scanner) (domain.Run, error) {
	var r domain.Run
	var raw []byte
	var until *time.Time
	e := row.Scan(&r.ID, &r.OwnerID, &r.ParentSessionID, &r.ConversationID, &r.ProjectID, &r.MessageID, &r.IdempotencyKey, &r.RequestHash, &raw, &r.State, &r.CredentialEpoch, &r.AuthExpiresAt, &r.RuntimeStarted, &r.Checkpoint, &r.NativeThreadID, &r.NativeTurnID, &r.LeaseToken, &until, &r.ToolCount, &r.AssistantMessageID, &r.ErrorCode, &r.Usage, &r.Deadline, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(e, pgx.ErrNoRows) {
		return r, domain.ErrNotFound
	}
	if e != nil {
		return r, domain.ErrUnavailable
	}
	var f frozen
	if json.Unmarshal(raw, &f) != nil {
		return r, domain.ErrUnavailable
	}
	r.CanvasWriterDigest = f.CanvasWriterDigest
	r.Kind = "AGENT"
	r.CapabilityRef = f.CapabilityRef
	r.CapabilityVersion = f.CapabilityVersion
	r.Model = f.Model
	r.Effort = f.Effort
	r.PromptHash = f.PromptHash
	r.ToolSchemaHash = f.ToolSchemaHash
	r.ProfileVersion = f.ProfileVersion
	r.Parameters = f.Parameters
	r.PromptSpec = f.PromptSpec
	r.ExpectedRevision = f.ExpectedRevision
	if until != nil {
		r.LeaseUntil = *until
	}
	return r, nil
}

const visible = ` JOIN assistant.conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id JOIN public.projects p ON p.id=r.project_id AND collaboration.project_role(p.id,r.owner_id) IS NOT NULL WHERE r.owner_id=$1 AND r.id=$2 AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.internal_kind IS NULL`

func get(ctx context.Context, tx pgx.Tx, owner, id string, lock bool) (domain.Run, error) {
	q := "SELECT " + columns + " FROM assistant.agent_runs r" + visible
	if lock {
		q += " FOR UPDATE OF r"
	}
	v, e := scan(tx.QueryRow(ctx, q, owner, id))
	if e != nil {
		return v, e
	}
	if lock {
		if _, e = collaboration.RequireProject(ctx, tx, owner, v.ProjectID, "EDITOR", true); e != nil {
			return v, e
		}
	}
	return v, nil
}
func event(ctx context.Context, tx pgx.Tx, owner, id, kind string, data any) error {
	raw, e := json.Marshal(data)
	if e != nil {
		return domain.ErrUnavailable
	}
	var seq int64
	e = tx.QueryRow(ctx, `UPDATE assistant.agent_runs SET event_sequence=event_sequence+1,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING event_sequence`, id, owner).Scan(&seq)
	if e != nil {
		return domain.ErrUnavailable
	}
	_, e = tx.Exec(ctx, `INSERT INTO assistant.agent_events(run_id,owner_id,sequence,type,data)VALUES($1,$2,$3,$4,$5)`, id, owner, seq, kind, raw)
	return dbError(e)
}
func (s *Store) Create(ctx context.Context, record application.CreateRecord) (domain.Run, error) {
	r := record.Run
	r.CanvasWriterDigest = collaboration.CanvasDelegationFrom(ctx).Digest()
	var result domain.Run
	e := s.within(ctx, func(tx pgx.Tx) error {
		var pid string
		e := tx.QueryRow(ctx, `SELECT c.canvas_project_id FROM assistant.conversations c WHERE c.id=$1 AND c.owner_id=$2 AND c.business='CANVAS' AND c.deleted_at IS NULL FOR UPDATE`, r.ConversationID, r.OwnerID).Scan(&pid)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		var revision int64
		if _, e = collaboration.RequireProject(ctx, tx, r.OwnerID, pid, "EDITOR", true); e != nil {
			return e
		}
		caller := collaboration.CanvasLeaseRequestFrom(ctx)
		if _, e = collaboration.CheckProjectEditSession(ctx, tx, pid, caller.Identity, caller.ClientID, caller.ClientID != ""); e != nil {
			return e
		}
		e = tx.QueryRow(ctx, `SELECT revision FROM public.projects WHERE id=$1 AND deleted_at IS NULL AND internal_kind IS NULL`, pid).Scan(&revision)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		existing, e := scan(tx.QueryRow(ctx, "SELECT "+columns+" FROM assistant.agent_runs r WHERE owner_id=$1 AND conversation_id=$2 AND idempotency_key=$3", r.OwnerID, r.ConversationID, r.IdempotencyKey))
		if e == nil {
			if existing.RequestHash != r.RequestHash || existing.CanvasWriterDigest != r.CanvasWriterDigest {
				return domain.ErrConflict
			}
			result = existing
			return nil
		}
		if !errors.Is(e, domain.ErrNotFound) {
			return e
		}
		if revision != r.ExpectedRevision {
			return &domain.VersionConflict{Current: revision}
		}
		var eligible bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assistant.messages WHERE id=$1 AND conversation_id=$2 AND owner_id=$3 AND role='USER' AND deleted_at IS NULL)`, r.MessageID, r.ConversationID, r.OwnerID).Scan(&eligible)
		if e != nil {
			return domain.ErrUnavailable
		}
		if !eligible {
			return domain.ErrNotFound
		}
		var busy bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM execution.tasks WHERE owner_id=$1 AND conversation_id=$2 AND state IN('QUEUED','RUNNING')) OR EXISTS(SELECT 1 FROM assistant.agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND state IN('QUEUED','RUNNING','WAITING_FOR_AUTH'))`, r.OwnerID, r.ConversationID).Scan(&busy)
		if e != nil {
			return domain.ErrUnavailable
		}
		if busy {
			return domain.ErrActive
		}
		var session bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now())`, r.ParentSessionID, r.OwnerID).Scan(&session)
		if e != nil {
			return domain.ErrUnavailable
		}
		if !session {
			return domain.ErrAuth
		}
		snapshot, _ := json.Marshal(frozen{r.CanvasWriterDigest, r.CapabilityRef, r.CapabilityVersion, r.Model, r.Effort, r.PromptHash, r.ToolSchemaHash, r.ProfileVersion, r.Parameters, r.PromptSpec, r.ExpectedRevision})
		r.ProjectID = pid
		_, e = tx.Exec(ctx, `INSERT INTO assistant.agent_runs(id,owner_id,parent_session_id,conversation_id,project_id,message_id,idempotency_key,request_hash,snapshot,state,auth_issued_at,auth_token_expires_at,auth_expires_at,deadline,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED',$10,$11,$12,$13,$14,$14)`, r.ID, r.OwnerID, r.ParentSessionID, r.ConversationID, pid, r.MessageID, r.IdempotencyKey, r.RequestHash, snapshot, record.Actor.IssuedAt, record.Actor.AccessExpiresAt, r.AuthExpiresAt, r.Deadline, r.CreatedAt)
		if e != nil {
			return dbError(e)
		}
		if e = event(ctx, tx, r.OwnerID, r.ID, "run.state.changed", map[string]any{"state": r.State}); e != nil {
			return e
		}
		result = r
		return nil
	})
	if e == nil {
		s.record(ctx, result, "ACCEPTED", false)
	}
	return result, e
}
func (s *Store) Get(ctx context.Context, owner, id string) (domain.Run, error) {
	return scan(s.db.QueryRow(ctx, "SELECT "+columns+" FROM assistant.agent_runs r"+visible, owner, id))
}
func (s *Store) ListActive(ctx context.Context, owner, cid string) ([]domain.Run, error) {
	result := []domain.Run{}
	e := s.within(ctx, func(tx pgx.Tx) error {
		var found string
		e := tx.QueryRow(ctx, `SELECT c.id FROM assistant.conversations c JOIN public.projects p ON p.id=c.canvas_project_id AND collaboration.project_role(p.id,c.owner_id) IS NOT NULL WHERE c.id=$1 AND c.owner_id=$2 AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.internal_kind IS NULL`, cid, owner).Scan(&found)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		rows, e := tx.Query(ctx, "SELECT "+columns+" FROM assistant.agent_runs r WHERE owner_id=$1 AND conversation_id=$2 AND state IN('QUEUED','RUNNING','WAITING_FOR_AUTH') ORDER BY created_at,id", owner, cid)
		if e != nil {
			return domain.ErrUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			r, e := scan(rows)
			if e != nil {
				return e
			}
			result = append(result, r)
		}
		return dbError(rows.Err())
	})
	return result, e
}
func (s *Store) Events(ctx context.Context, owner, id string, after int64, limit int) (domain.EventPage, error) {
	result := domain.EventPage{Items: []domain.Event{}, NextCursor: strconv.FormatInt(after, 10)}
	e := s.within(ctx, func(tx pgx.Tx) error {
		r, e := get(ctx, tx, owner, id, false)
		if e != nil {
			return e
		}
		result.Terminal = !r.State.Active()
		rows, e := tx.Query(ctx, `SELECT e.sequence::text,e.type,e.data,e.occurred_at FROM assistant.agent_events e WHERE e.owner_id=$1 AND e.run_id=$2 AND e.sequence>$3 ORDER BY e.sequence LIMIT $4`, owner, id, after, limit)
		if e != nil {
			return domain.ErrUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			v := domain.Event{RunID: id}
			if rows.Scan(&v.Sequence, &v.Type, &v.Data, &v.OccurredAt) != nil {
				return domain.ErrUnavailable
			}
			result.Items = append(result.Items, v)
			result.NextCursor = v.Sequence
		}
		return dbError(rows.Err())
	})
	return result, e
}
func (s *Store) UpdateAuth(ctx context.Context, owner, id, sid, epoch string, issued, tokenExpiry, expiry time.Time) (domain.Run, error) {
	var result domain.Run
	e := s.within(ctx, func(tx pgx.Tx) error {
		r, e := get(ctx, tx, owner, id, true)
		if e != nil {
			return e
		}
		if sid != r.ParentSessionID {
			return domain.ErrParentSession
		}
		if !r.State.Active() {
			result = r
			return nil
		}
		if r.CredentialEpoch != epoch {
			return domain.ErrAuthVersion
		}
		var previousIssued, previousExpiry time.Time
		e = tx.QueryRow(ctx, `SELECT auth_issued_at,auth_token_expires_at FROM assistant.agent_runs WHERE id=$1`, id).Scan(&previousIssued, &previousExpiry)
		if e != nil {
			return domain.ErrUnavailable
		}
		if issued.Before(previousIssued) || tokenExpiry.Before(previousExpiry) {
			return domain.ErrAuthRegression
		}
		if expiry.After(r.Deadline) || !time.Now().Before(expiry) {
			return domain.ErrAuth
		}
		if issued.Equal(previousIssued) && tokenExpiry.Equal(previousExpiry) && r.State != domain.WaitingAuth {
			result = r
			return nil
		}
		_, e = tx.Exec(ctx, `UPDATE assistant.agent_runs SET credential_epoch=credential_epoch+1,auth_issued_at=$3,auth_token_expires_at=$4,auth_expires_at=$5,state=CASE WHEN state='WAITING_FOR_AUTH' THEN CASE WHEN lease_token IS NOT NULL AND lease_until>now() THEN 'RUNNING' ELSE 'QUEUED' END ELSE state END,updated_at=now() WHERE id=$1 AND owner_id=$2`, id, owner, issued, tokenExpiry, expiry)
		if e != nil {
			return domain.ErrUnavailable
		}
		if r.State == domain.WaitingAuth {
			resumeState := domain.Queued
			if r.LeaseToken != "" && time.Now().Before(r.LeaseUntil) {
				resumeState = domain.Running
			}
			if e = event(ctx, tx, owner, id, "run.state.changed", map[string]any{"state": resumeState}); e != nil {
				return e
			}
		}
		result, e = get(ctx, tx, owner, id, false)
		return e
	})
	return result, e
}
func (s *Store) Cancel(ctx context.Context, owner, id string) (domain.Run, error) {
	var result domain.Run
	e := s.within(ctx, func(tx pgx.Tx) error {
		r, e := get(ctx, tx, owner, id, true)
		if e != nil {
			return e
		}
		caller := collaboration.CanvasLeaseRequestFrom(ctx)
		if _, e = collaboration.CheckProjectEditSession(ctx, tx, r.ProjectID, caller.Identity, caller.ClientID, caller.ClientID != ""); e != nil {
			return e
		}
		if !r.State.Active() {
			result = r
			return nil
		}
		_, e = tx.Exec(ctx, `UPDATE assistant.agent_runs SET state='CANCELED',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2`, id, owner)
		if e != nil {
			return domain.ErrUnavailable
		}
		if e = event(ctx, tx, owner, id, "run.state.changed", map[string]any{"state": domain.Canceled}); e != nil {
			return e
		}
		result, e = get(ctx, tx, owner, id, false)
		return e
	})
	return result, e
}
func (s *Store) Recover(ctx context.Context) error {
	return s.within(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT id,owner_id FROM assistant.agent_runs WHERE state IN('QUEUED','RUNNING') OR (state='WAITING_FOR_AUTH' AND lease_token IS NOT NULL) FOR UPDATE`)
		if e != nil {
			return domain.ErrUnavailable
		}
		type item struct{ id, owner string }
		items := []item{}
		for rows.Next() {
			var v item
			if rows.Scan(&v.id, &v.owner) != nil {
				rows.Close()
				return domain.ErrUnavailable
			}
			items = append(items, v)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return domain.ErrUnavailable
		}
		for _, v := range items {
			_, e = tx.Exec(ctx, `UPDATE assistant.agent_runs SET state='WAITING_FOR_AUTH',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, v.id)
			if e != nil {
				return domain.ErrUnavailable
			}
			if e = event(ctx, tx, v.owner, v.id, "run.state.changed", map[string]any{"state": domain.WaitingAuth, "errorCode": "SERVICE_RESTART"}); e != nil {
				return e
			}
		}
		return nil
	})
}
func (s *Store) Claim(ctx context.Context, duration time.Duration) (*domain.Run, error) {
	var result, rejected *domain.Run
	e := s.within(ctx, func(tx pgx.Tx) error {
		r, e := scan(tx.QueryRow(ctx, "SELECT "+columns+` FROM assistant.agent_runs r WHERE state='QUEUED' OR (state='RUNNING' AND lease_until<=now()) OR (state='WAITING_FOR_AUTH' AND deadline<=now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`))
		if errors.Is(e, domain.ErrNotFound) {
			return nil
		}
		if e != nil {
			return e
		}
		if _, e = collaboration.RequireProject(ctx, tx, r.OwnerID, r.ProjectID, "EDITOR", true); e != nil {
			_, e = tx.Exec(ctx, `UPDATE assistant.agent_runs SET state='FAILED',error_code='PROJECT_ACCESS_REVOKED',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, r.ID)
			if e != nil {
				return domain.ErrUnavailable
			}
			r.State = domain.Failed
			code := "PROJECT_ACCESS_REVOKED"
			r.ErrorCode = &code
			rejected = &r
			return event(ctx, tx, r.OwnerID, r.ID, "run.state.changed", map[string]any{"state": domain.Failed, "errorCode": code})
		}
		r.LeaseToken = uuid.NewString()
		r.LeaseUntil = time.Now().Add(duration)
		_, e = tx.Exec(ctx, `UPDATE assistant.agent_runs SET state='RUNNING',lease_token=$2,lease_until=$3,updated_at=now() WHERE id=$1`, r.ID, r.LeaseToken, r.LeaseUntil)
		if e != nil {
			return domain.ErrUnavailable
		}
		r.State = domain.Running
		if e = event(ctx, tx, r.OwnerID, r.ID, "run.state.changed", map[string]any{"state": r.State}); e != nil {
			return e
		}
		result = &r
		return nil
	})
	if e == nil {
		if result != nil {
			s.record(ctx, *result, "RUNNING", false)
		}
		if rejected != nil {
			s.record(ctx, *rejected, "TASK_UPDATED", true)
		}
	}
	return result, e
}
func (s *Store) Renew(ctx context.Context, id, lease string, duration time.Duration) error {
	updated, e := s.db.Exec(ctx, `UPDATE assistant.agent_runs SET lease_until=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state IN('RUNNING','WAITING_FOR_AUTH')`, id, lease, time.Now().Add(duration))
	if e != nil {
		return domain.ErrUnavailable
	}
	if updated.RowsAffected() != 1 {
		return domain.ErrFenced
	}
	return nil
}
func (s *Store) WaitAuth(ctx context.Context, id, lease, reason string) error {
	return s.within(ctx, func(tx pgx.Tx) error {
		var owner string
		e := tx.QueryRow(ctx, `UPDATE assistant.agent_runs SET state='WAITING_FOR_AUTH',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='RUNNING' RETURNING owner_id`, id, lease).Scan(&owner)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrFenced
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		return event(ctx, tx, owner, id, "run.state.changed", map[string]any{"state": domain.WaitingAuth, "errorCode": reason})
	})
}
func (s *Store) MarkRuntimeStarted(ctx context.Context, id, lease string) error {
	updated, e := s.db.Exec(ctx, `UPDATE assistant.agent_runs SET runtime_started=true WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='RUNNING'`, id, lease)
	if e != nil {
		return domain.ErrUnavailable
	}
	if updated.RowsAffected() != 1 {
		return domain.ErrFenced
	}
	return nil
}
func (s *Store) Bind(ctx context.Context, id, lease, thread, turn string) error {
	updated, e := s.db.Exec(ctx, `UPDATE assistant.agent_runs SET native_thread_id=$3,native_turn_id=$4 WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='RUNNING' AND (native_thread_id IS NULL OR native_thread_id=$3) AND (native_turn_id IS NULL OR native_turn_id=$4)`, id, lease, thread, turn)
	if e != nil {
		return domain.ErrUnavailable
	}
	if updated.RowsAffected() != 1 {
		return domain.ErrFenced
	}
	return nil
}
func (s *Store) SaveCheckpoint(ctx context.Context, id, lease string, checkpoint json.RawMessage) error {
	updated, e := s.db.Exec(ctx, `UPDATE assistant.agent_runs SET checkpoint=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='RUNNING'`, id, lease, checkpoint)
	if e != nil {
		return domain.ErrUnavailable
	}
	if updated.RowsAffected() != 1 {
		return domain.ErrFenced
	}
	return nil
}
func (s *Store) History(ctx context.Context, r domain.Run) ([]application.RuntimeMessage, error) {
	result := []application.RuntimeMessage{}
	if _, e := collaboration.RequireProject(ctx, s.db, r.OwnerID, r.ProjectID, "EDITOR", false); e != nil {
		return nil, e
	}
	rows, e := s.db.Query(ctx, `SELECT m.role,m.content FROM assistant.messages m JOIN assistant.conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND m.sequence<=(SELECT sequence FROM assistant.messages WHERE id=$3 AND owner_id=$1 AND conversation_id=$2 AND deleted_at IS NULL) ORDER BY m.sequence DESC LIMIT 100`, r.OwnerID, r.ConversationID, r.MessageID)
	if e != nil {
		return nil, domain.ErrUnavailable
	}
	defer rows.Close()
	size := 0
	for rows.Next() {
		var role string
		var raw []byte
		if rows.Scan(&role, &raw) != nil {
			return nil, domain.ErrUnavailable
		}
		if role != "USER" && role != "ASSISTANT" {
			continue
		}
		var parts []struct{ Type, Text string }
		if json.Unmarshal(raw, &parts) != nil {
			return nil, domain.ErrUnavailable
		}
		texts := []string{}
		for _, p := range parts {
			if p.Type != "TEXT" {
				return nil, domain.ErrInvalid
			}
			safeText, _ := canvas.SafeContextText(p.Text)
			texts = append(texts, safeText)
		}
		text := strings.Join(texts, "\n")
		size += len(text)
		if size > 512000 {
			return nil, domain.ErrInvalid
		}
		result = append(result, application.RuntimeMessage{Role: role, Text: text})
	}
	if rows.Err() != nil {
		return nil, domain.ErrUnavailable
	}
	if len(result) == 0 {
		return nil, domain.ErrNotFound
	}
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result, nil
}
func fenced(ctx context.Context, tx pgx.Tx, r domain.Run) (domain.Run, error) {
	v, e := get(ctx, tx, r.OwnerID, r.ID, true)
	if e != nil {
		return v, e
	}
	if (v.State != domain.Running && v.State != domain.WaitingAuth) || v.LeaseToken != r.LeaseToken || !time.Now().Before(v.LeaseUntil) {
		return v, domain.ErrFenced
	}
	return v, nil
}
func scanTool(row scanner) (domain.ToolCall, error) {
	var c domain.ToolCall
	var status *int
	e := row.Scan(&c.RunID, &c.OwnerID, &c.NativeCallID, &c.NativeThreadID, &c.NativeTurnID, &c.Name, &c.Namespace, &c.Arguments, &c.ArgumentHash, &c.RequestHash, &c.OperationKey, &c.State, &c.Result, &c.Success, &status)
	if errors.Is(e, pgx.ErrNoRows) {
		return c, domain.ErrNotFound
	}
	if e != nil {
		return c, domain.ErrUnavailable
	}
	if status != nil {
		c.Status = *status
	}
	if len(c.Result) > 0 {
		var value any
		decoder := json.NewDecoder(bytes.NewReader(c.Result))
		decoder.UseNumber()
		if decoder.Decode(&value) != nil {
			return c, domain.ErrUnavailable
		}
		normalized, err := json.Marshal(value)
		if err != nil {
			return c, domain.ErrUnavailable
		}
		c.Result = normalized
	}
	return c, nil
}

const toolColumns = `run_id,owner_id,native_call_id,native_thread_id,native_turn_id,tool_name,namespace,arguments,argument_hash,request_hash,operation_key::text,state,result,success,http_status`

func (s *Store) BeginTool(ctx context.Context, r domain.Run, c domain.ToolCall, budget int) (domain.ToolCall, error) {
	var result domain.ToolCall
	e := s.within(ctx, func(tx pgx.Tx) error {
		v, e := fenced(ctx, tx, r)
		if e != nil {
			return e
		}
		if c.OwnerID != v.OwnerID || c.RunID != v.ID || c.NativeThreadID != v.NativeThreadID || c.NativeTurnID != v.NativeTurnID {
			return domain.ErrToolRejected
		}
		previous, e := scanTool(tx.QueryRow(ctx, "SELECT "+toolColumns+" FROM assistant.agent_tool_calls WHERE run_id=$1 AND native_call_id=$2", r.ID, c.NativeCallID))
		if e == nil {
			if previous.ArgumentHash != c.ArgumentHash || previous.RequestHash != c.RequestHash || previous.Name != c.Name || previous.Namespace != c.Namespace || previous.NativeThreadID != c.NativeThreadID || previous.NativeTurnID != c.NativeTurnID || previous.OperationKey != c.OperationKey {
				return domain.ErrConflict
			}
			result = previous
			return nil
		}
		if !errors.Is(e, domain.ErrNotFound) {
			return e
		}
		if v.ToolCount >= budget {
			return domain.ErrBudget
		}
		_, e = tx.Exec(ctx, `INSERT INTO assistant.agent_tool_calls(run_id,owner_id,native_call_id,native_thread_id,native_turn_id,tool_name,namespace,arguments,argument_hash,request_hash,operation_key,state)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`, c.RunID, c.OwnerID, c.NativeCallID, c.NativeThreadID, c.NativeTurnID, c.Name, c.Namespace, c.Arguments, c.ArgumentHash, c.RequestHash, c.OperationKey)
		if e != nil {
			return domain.ErrUnavailable
		}
		_, e = tx.Exec(ctx, `UPDATE assistant.agent_runs SET tool_count=tool_count+1 WHERE id=$1`, r.ID)
		if e != nil {
			return domain.ErrUnavailable
		}
		if e = event(ctx, tx, r.OwnerID, r.ID, "tool.started", map[string]any{"callId": c.OperationKey, "toolName": c.Name}); e != nil {
			return e
		}
		result = c
		return nil
	})
	return result, e
}
func (s *Store) CompleteTool(ctx context.Context, r domain.Run, c domain.ToolCall, response application.ToolResponse) error {
	changed := false
	err := s.within(ctx, func(tx pgx.Tx) error {
		_, e := fenced(ctx, tx, r)
		if e != nil {
			return e
		}
		stored, e := scanTool(tx.QueryRow(ctx, "SELECT "+toolColumns+" FROM assistant.agent_tool_calls WHERE run_id=$1 AND native_call_id=$2 FOR UPDATE", r.ID, c.NativeCallID))
		if e != nil {
			return e
		}
		if stored.RequestHash != c.RequestHash || stored.ArgumentHash != c.ArgumentHash {
			return domain.ErrConflict
		}
		if stored.State != "PENDING" {
			return nil
		}
		changed = true
		success := response.Status >= 200 && response.Status < 300
		state, kind := "FAILED", "tool.failed"
		if success {
			state, kind = "SUCCEEDED", "tool.completed"
		}
		if len(response.Data) == 0 || !json.Valid(response.Data) {
			return domain.ErrInvalid
		}
		_, e = tx.Exec(ctx, `UPDATE assistant.agent_tool_calls SET state=$3,result=$4,success=$5,http_status=$6,completed_at=now() WHERE run_id=$1 AND native_call_id=$2 AND state='PENDING'`, r.ID, c.NativeCallID, state, response.Data, success, response.Status)
		if e != nil {
			return domain.ErrUnavailable
		}
		data := map[string]any{"callId": c.OperationKey, "toolName": c.Name, "success": success, "status": response.Status}
		if response.ErrorCode != "" {
			data["errorCode"] = response.ErrorCode
		}
		if e = event(ctx, tx, r.OwnerID, r.ID, kind, data); e != nil {
			return e
		}
		if success && c.Name == "studio_node_run" {
			var receipt struct {
				TaskID string `json:"taskId"`
				ID     string `json:"id"`
			}
			if json.Unmarshal(response.Data, &receipt) == nil {
				if receipt.TaskID == "" {
					receipt.TaskID = receipt.ID
				}
				if receipt.TaskID != "" {
					return event(ctx, tx, r.OwnerID, r.ID, "task.linked", map[string]any{"callId": c.OperationKey, "taskId": receipt.TaskID})
				}
			}
		}
		return nil
	})
	if err == nil && changed && s.observer != nil {
		state := "SUCCEEDED"
		failed := response.Status < 200 || response.Status >= 300
		if failed {
			state = "FAILED"
		}
		s.observer.Generation(ctx, observability.Generation{ActorID: r.OwnerID, TaskID: r.ID, ProjectID: r.ProjectID, Kind: "AGENT_TOOL", ExecutionID: c.OperationKey, CapabilityRef: c.Name, Stage: "TOOL_COMPLETED", State: state, ErrorCode: response.ErrorCode, Notify: failed})
	}
	return err
}
func (s *Store) Finish(ctx context.Context, r domain.Run, state domain.State, code string, result application.RuntimeResult) error {
	err := s.within(ctx, func(tx pgx.Tx) error {
		v, e := fenced(ctx, tx, r)
		if e != nil {
			return e
		}
		if state.Active() {
			return domain.ErrInvalid
		}
		var messageID *string
		if state == domain.Succeeded {
			if !result.TerminalVerified || len(result.Text) == 0 || len(result.Text) > 200000 || strings.ContainsRune(result.Text, 0) {
				return domain.ErrInvalid
			}
			var sequence int64
			e = tx.QueryRow(ctx, `SELECT next_message_sequence FROM assistant.conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`, v.ConversationID, v.OwnerID).Scan(&sequence)
			if e != nil {
				return domain.ErrUnavailable
			}
			id := "msg_" + strings.ReplaceAll(uuid.NewString(), "-", "")
			messageID = &id
			content, _ := json.Marshal([]map[string]any{{"type": "TEXT", "text": result.Text}})
			_, e = tx.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content)VALUES($1,$2,$3,$4,'ASSISTANT',$5)`, id, v.ConversationID, v.OwnerID, sequence, content)
			if e != nil {
				return domain.ErrUnavailable
			}
			_, e = tx.Exec(ctx, `UPDATE assistant.conversations SET next_message_sequence=next_message_sequence+1,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2`, v.ConversationID, v.OwnerID)
			if e != nil {
				return domain.ErrUnavailable
			}
			if e = event(ctx, tx, v.OwnerID, v.ID, "message.delta", map[string]any{"text": result.Text, "snapshot": true, "messageId": id}); e != nil {
				return e
			}
		}
		var errorCode *string
		if code != "" {
			errorCode = &code
		}
		var usage any
		if len(result.Usage) > 0 && json.Valid(result.Usage) {
			usage = result.Usage
		}
		_, e = tx.Exec(ctx, `UPDATE assistant.agent_runs SET state=$3,assistant_message_id=$4,error_code=$5,usage=$6,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2`, v.ID, v.OwnerID, state, messageID, errorCode, usage)
		if e != nil {
			return domain.ErrUnavailable
		}
		data := map[string]any{"state": state}
		if code != "" {
			data["errorCode"] = code
		}
		return event(ctx, tx, v.OwnerID, v.ID, "run.state.changed", data)
	})
	if err == nil {
		r.State = state
		r.ErrorCode = &code
		s.record(ctx, r, "TASK_UPDATED", state == domain.Failed || state == domain.TimedOut)
	}
	return err
}

func (s *Store) PauseAuth(ctx context.Context, id, lease, reason string) error {
	return s.within(ctx, func(tx pgx.Tx) error {
		var owner string
		var state domain.State
		err := tx.QueryRow(ctx, `SELECT owner_id,state FROM assistant.agent_runs WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state IN('RUNNING','WAITING_FOR_AUTH') FOR UPDATE`, id, lease).Scan(&owner, &state)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrFenced
		}
		if err != nil {
			return domain.ErrUnavailable
		}
		if state == domain.WaitingAuth {
			return nil
		}
		_, err = tx.Exec(ctx, `UPDATE assistant.agent_runs SET state='WAITING_FOR_AUTH',updated_at=now() WHERE id=$1`, id)
		if err != nil {
			return domain.ErrUnavailable
		}
		return event(ctx, tx, owner, id, "run.state.changed", map[string]any{"state": domain.WaitingAuth, "errorCode": reason})
	})
}
func (s *Store) ToolReceipt(ctx context.Context, r domain.Run, c domain.ToolCall) (domain.ToolCall, error) {
	var result domain.ToolCall
	err := s.within(ctx, func(tx pgx.Tx) error {
		v, err := fenced(ctx, tx, r)
		if err != nil {
			return err
		}
		if c.OwnerID != v.OwnerID || c.RunID != v.ID || c.NativeThreadID != v.NativeThreadID || c.NativeTurnID != v.NativeTurnID {
			return domain.ErrToolRejected
		}
		stored, err := scanTool(tx.QueryRow(ctx, "SELECT "+toolColumns+" FROM assistant.agent_tool_calls WHERE run_id=$1 AND native_call_id=$2 AND state IN('SUCCEEDED','FAILED')", r.ID, c.NativeCallID))
		if err != nil {
			return err
		}
		if stored.ArgumentHash != c.ArgumentHash || stored.RequestHash != c.RequestHash || stored.Name != c.Name || stored.Namespace != c.Namespace || stored.OperationKey != c.OperationKey {
			return domain.ErrConflict
		}
		result = stored
		return nil
	})
	return result, err
}
