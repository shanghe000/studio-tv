package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
	"time"
)

var _ application.LifecycleRepositories = (*repository)(nil)
var _ application.ActiveTaskGuard = (*repository)(nil)
var _ application.ClientToolRepositories = (*repository)(nil)

func (r *repository) AssertNoActiveAssistantTask(ctx context.Context, owner, id string) error {
	var busy bool
	e := r.tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM execution.tasks WHERE owner_id=$1 AND conversation_id=$2 AND state IN ('QUEUED','RUNNING')) OR EXISTS(SELECT 1 FROM assistant.agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND state IN ('QUEUED','RUNNING','WAITING_FOR_AUTH'))", owner, id).Scan(&busy)
	if e != nil {
		return domain.ErrUnavailable
	}
	if busy {
		return domain.ErrTaskActive
	}
	return nil
}
func (r *repository) FindDeletionReceipt(ctx context.Context, owner, operation, key string) (*application.MessageDeletionReceipt, error) {
	var hash string
	var status int
	var raw []byte
	e := r.tx.QueryRow(ctx, "SELECT request_hash,response_status,response_body FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3", owner, operation, key).Scan(&hash, &status, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, domain.ErrUnavailable
	}
	var result domain.MessageDeletion
	if status != 200 || len(hash) != 64 || json.Unmarshal(raw, &result) != nil || !domain.ValidID(result.ConversationID) || len(result.DeletedMessageIDs) < 1 || result.ConversationRevision < 2 || result.DeletedAt.IsZero() {
		return nil, domain.ErrUnavailable
	}
	return &application.MessageDeletionReceipt{RequestHash: hash, Result: result}, nil
}
func (r *repository) SaveDeletionReceipt(ctx context.Context, owner, operation, key string, v application.MessageDeletionReceipt) error {
	raw, e := json.Marshal(v.Result)
	if e != nil {
		return domain.ErrUnavailable
	}
	_, e = r.tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,200,$5)", owner, operation, key, v.RequestHash, raw)
	return storageError(e)
}
func (r *repository) ValidateDeletionReceipt(ctx context.Context, owner, id string, v domain.MessageDeletion) error {
	var count int
	e := r.tx.QueryRow(ctx, "SELECT count(*) FROM assistant.messages WHERE owner_id=$1 AND conversation_id=$2 AND id=ANY($3::text[]) AND deleted_at=$4", owner, id, v.DeletedMessageIDs, v.DeletedAt).Scan(&count)
	if e != nil {
		return domain.ErrUnavailable
	}
	if count != len(v.DeletedMessageIDs) {
		return domain.ErrMessageNotFound
	}
	return nil
}
func (r *repository) DeleteMessages(ctx context.Context, c domain.Conversation, target string, turn bool, at time.Time) (domain.MessageDeletion, error) {
	result := domain.MessageDeletion{ConversationID: c.ID, ConversationRevision: c.Revision + 1, DeletedAt: at, DeletedMessageIDs: []string{}}
	var role string
	var sequence int64
	e := r.tx.QueryRow(ctx, "SELECT role,sequence FROM assistant.messages WHERE id=$1 AND conversation_id=$2 AND owner_id=$3 AND deleted_at IS NULL FOR UPDATE", target, c.ID, c.OwnerID).Scan(&role, &sequence)
	if errors.Is(e, pgx.ErrNoRows) {
		return result, domain.ErrMessageNotFound
	}
	if e != nil {
		return result, domain.ErrUnavailable
	}
	if turn && role != "USER" {
		return result, domain.ErrInvalid
	}
	wholeTurn := role == "USER"
	if wholeTurn {
		rows, e := r.tx.Query(ctx, `SELECT id FROM assistant.messages WHERE conversation_id=$1 AND owner_id=$2 AND deleted_at IS NULL AND ((sequence=$3 AND role='USER') OR (sequence>$3 AND role='ASSISTANT' AND sequence<COALESCE((SELECT min(sequence) FROM assistant.messages WHERE conversation_id=$1 AND owner_id=$2 AND role='USER' AND sequence>$3),9223372036854775807))) ORDER BY sequence,id LIMIT $4 FOR UPDATE`, c.ID, c.OwnerID, sequence, domain.MaxDeletionMessages+1)
		if e != nil {
			return result, domain.ErrUnavailable
		}
		for rows.Next() {
			var id string
			if rows.Scan(&id) != nil {
				rows.Close()
				return result, domain.ErrUnavailable
			}
			result.DeletedMessageIDs = append(result.DeletedMessageIDs, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return result, domain.ErrUnavailable
		}
		if len(result.DeletedMessageIDs) > domain.MaxDeletionMessages {
			return result, domain.ErrDeletionTooLarge
		}
	} else {
		result.DeletedMessageIDs = append(result.DeletedMessageIDs, target)
	}
	var affected bool
	e = r.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM execution.tasks t LEFT JOIN execution.assistant_results a ON a.task_id=t.id WHERE t.owner_id=$1 AND t.conversation_id=$2 AND t.state IN('QUEUED','RUNNING') AND (COALESCE(t.payload->'task'->>'messageId','')='' OR t.payload->'task'->>'messageId'=ANY($3::text[]) OR a.message_id=ANY($3::text[]))) OR EXISTS(SELECT 1 FROM assistant.agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND state IN ('QUEUED','RUNNING','WAITING_FOR_AUTH'))`, c.OwnerID, c.ID, result.DeletedMessageIDs).Scan(&affected)
	if e != nil {
		return result, domain.ErrUnavailable
	}
	if affected {
		return result, domain.ErrTaskActive
	}
	changed, e := r.tx.Exec(ctx, "UPDATE assistant.messages SET deleted_at=$4 WHERE owner_id=$1 AND conversation_id=$2 AND id=ANY($3::text[]) AND deleted_at IS NULL", c.OwnerID, c.ID, result.DeletedMessageIDs, at)
	if e != nil || changed.RowsAffected() != int64(len(result.DeletedMessageIDs)) {
		return result, domain.ErrUnavailable
	}
	changed, e = r.tx.Exec(ctx, "UPDATE assistant.conversations SET revision=revision+1,updated_at=$4 WHERE owner_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL", c.OwnerID, c.ID, c.Revision, at)
	if e != nil || changed.RowsAffected() != 1 {
		return result, domain.ErrUnavailable
	}
	return result, nil
}
func (r *repository) HasClientToolEvidence(ctx context.Context, owner, id string) (bool, error) {
	var exists bool
	e := r.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM execution.tasks t WHERE t.owner_id=$1 AND t.conversation_id=$2 AND (
	 jsonb_path_exists(t.payload,'$.task.plans[*] ? (@.state == "WAITING_TOOL")') OR COALESCE(t.payload->'task'->'clientToolCalls' NOT IN('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'false'::jsonb,'""'::jsonb),false) OR COALESCE(t.payload->'task'->'toolCalls' NOT IN('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'false'::jsonb,'""'::jsonb),false)
	 OR EXISTS(SELECT 1 FROM execution.events e WHERE e.task_id=t.id AND e.owner_id=t.owner_id AND (lower(e.type) LIKE '%tool%' OR e.data->>'state'='WAITING_TOOL' OR COALESCE(e.data->'client_tool_call' NOT IN('null'::jsonb,'[]'::jsonb,'{}'::jsonb),false) OR COALESCE(e.data->'tool_call' NOT IN('null'::jsonb,'[]'::jsonb,'{}'::jsonb),false) OR COALESCE(e.data->'toolCalls' NOT IN('null'::jsonb,'[]'::jsonb,'{}'::jsonb),false) OR COALESCE(e.data->'clientToolCalls' NOT IN('null'::jsonb,'[]'::jsonb,'{}'::jsonb),false)))))`, owner, id).Scan(&exists)
	return exists, storageError(e)
}
