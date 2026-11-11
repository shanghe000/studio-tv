package postgres

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type CommandUnitOfWork struct{ pool *pgxpool.Pool }

func NewCommandUnitOfWork(pool *pgxpool.Pool) *CommandUnitOfWork {
	return &CommandUnitOfWork{pool: pool}
}

var _ application.CommandUnitOfWork = (*CommandUnitOfWork)(nil)

func (u *CommandUnitOfWork) WithinCommands(ctx context.Context, fn func(application.CommandRepositories) error) error {
	if u.pool == nil {
		return domain.ErrCommandUnavailable
	}
	tx, err := u.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.ErrCommandUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if err = fn(&commandRepository{tx: tx}); err != nil {
		return err
	}
	if tx.Commit(ctx) != nil {
		return domain.ErrCommandUnavailable
	}
	return nil
}

type commandRepository struct {
	tx    pgx.Tx
	scope *collaboration.ProjectAccess
}

var _ application.CommandRepositories = (*commandRepository)(nil)

func (r *commandRepository) LockCommandKey(ctx context.Context, owner, project, operation, key string) error {
	_, err := r.tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner+":"+project+":"+operation+":"+key)
	if err != nil {
		return domain.ErrCommandUnavailable
	}
	return nil
}
func (r *commandRepository) OwnedCommandSnapshot(ctx context.Context, owner, project string, write bool) (application.CommandSnapshot, error) {
	var result application.CommandSnapshot
	role := "VIEWER"
	if write {
		role = "EDITOR"
	}
	scope, e := collaboration.RequireProject(ctx, r.tx, owner, project, role, write)
	if e != nil {
		return result, projectAccessError(e)
	}
	r.scope = &scope
	owner = scope.StorageOwnerID
	query := `SELECT revision,event_sequence,graph FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND internal_kind IS NULL`
	if write {
		query += " FOR UPDATE"
	} else {
		query += " FOR SHARE"
	}
	err := r.tx.QueryRow(ctx, query, project, owner).Scan(&result.Revision, &result.EventSequence, &result.Graph)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrNotFound
	}
	if err != nil {
		return result, domain.ErrCommandUnavailable
	}
	return result, nil
}
func validStoredCommandReceipt(raw []byte, project string) (domain.CommandReceipt, error) {
	var receipt domain.CommandReceipt
	if json.Unmarshal(raw, &receipt) != nil || !domain.ValidCommandID(receipt.CommandID) || receipt.ProjectID != project || receipt.State != "COMMITTED" || receipt.BaseRevision < 1 || receipt.GraphRevision != receipt.BaseRevision+1 || receipt.CommittedAt.IsZero() || receipt.Delta.NodesUpsert == nil || receipt.Delta.NodesRemoved == nil || receipt.Delta.EdgesUpsert == nil || receipt.Delta.EdgesRemoved == nil {
		return receipt, domain.ErrCommandUnavailable
	}
	sequence, err := strconv.ParseInt(receipt.EventCursor, 10, 64)
	if err != nil || sequence < 1 || strconv.FormatInt(sequence, 10) != receipt.EventCursor {
		return receipt, domain.ErrCommandUnavailable
	}
	return receipt, nil
}
func (r *commandRepository) FindCommandReceipt(ctx context.Context, owner, project, operation, key string) (*application.StoredCommandReceipt, error) {
	var raw []byte
	var hash string
	err := r.tx.QueryRow(ctx, `SELECT request_hash,receipt FROM canvas.command_receipts WHERE coalesce(actor_id,owner_id)=$1 AND project_id=$2 AND operation=$3 AND key=$4`, owner, project, operation, key).Scan(&hash, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, domain.ErrCommandUnavailable
	}
	receipt, err := validStoredCommandReceipt(raw, project)
	digest, hashErr := hex.DecodeString(hash)
	if err != nil || hashErr != nil || len(digest) != 32 {
		return nil, domain.ErrCommandUnavailable
	}
	return &application.StoredCommandReceipt{RequestHash: hash, Receipt: receipt}, nil
}
func (r *commandRepository) CommandReceipt(ctx context.Context, owner, project, id string) (domain.CommandReceipt, error) {
	var raw []byte
	err := r.tx.QueryRow(ctx, `SELECT receipt FROM canvas.command_receipts WHERE coalesce(actor_id,owner_id)=$1 AND project_id=$2 AND command_id=$3`, owner, project, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.CommandReceipt{}, domain.ErrCommandReceiptNotFound
	}
	if err != nil {
		return domain.CommandReceipt{}, domain.ErrCommandUnavailable
	}
	return validStoredCommandReceipt(raw, project)
}
func (r *commandRepository) AuthorizeCommandAssets(ctx context.Context, owner string, refs []string) error {
	if r.scope == nil {
		return domain.ErrCommandUnavailable
	}
	return collaboration.AuthorizeProjectAssets(ctx, r.tx, owner, r.scope.ProjectID, refs)
}
func (r *commandRepository) CommitCanvasCommand(ctx context.Context, owner, project string, current application.CommandSnapshot, graph json.RawMessage, key, hash string, receipt domain.CommandReceipt) error {
	if r.scope == nil || r.scope.ActorID != owner || r.scope.ProjectID != project {
		return domain.ErrCommandUnavailable
	}
	actor := owner
	owner = r.scope.StorageOwnerID
	sequence := current.EventSequence + 1
	if receipt.ProjectID != project || receipt.BaseRevision != current.Revision || receipt.GraphRevision != current.Revision+1 || receipt.EventCursor != strconv.FormatInt(sequence, 10) {
		return domain.ErrCommandUnavailable
	}
	changed, err := collaboration.ChangedNodeIDs(current.Graph, graph)
	if err != nil {
		return err
	}
	caller := collaboration.CanvasLeaseRequestFrom(ctx)
	if caller.Identity.UserID == "" {
		caller.Identity.UserID = actor
	} else if caller.Identity.UserID != actor {
		return httpapi.Fail(403, "AUTHORIZATION_DENIED", "画布操作人与当前登录账号不一致。")
	}
	if err = collaboration.CheckNodeLeases(ctx, r.tx, project, caller.Identity, caller.ClientID, changed); err != nil {
		return err
	}
	var committed json.RawMessage
	err = r.tx.QueryRow(ctx, `UPDATE public.projects SET graph=$1,revision=revision+1,event_sequence=event_sequence+1,updated_at=$2 WHERE id=$3 AND owner_id=$4 AND revision=$5 AND event_sequence=$6 AND deleted_at IS NULL AND internal_kind IS NULL RETURNING graph`, graph, receipt.CommittedAt, project, owner, current.Revision, current.EventSequence).Scan(&committed)
	if err != nil {
		return domain.ErrCommandUnavailable
	}
	receipt.Delta, err = domain.CommittedDelta(current.Graph, committed)
	if err != nil {
		return domain.ErrCommandUnavailable
	}
	event := map[string]any{"schemaVersion": "1", "projectId": project, "sequence": receipt.EventCursor, "occurredAt": receipt.CommittedAt, "source": map[string]string{"kind": "API", "actorId": actor}, "type": "canvas.changed", "data": map[string]any{"commandId": receipt.CommandID, "baseRevision": receipt.BaseRevision, "graphRevision": receipt.GraphRevision, "delta": receipt.Delta}}
	eventJSON, err := json.Marshal(event)
	if err != nil {
		return domain.ErrCommandUnavailable
	}
	eventType := "canvas.changed"
	var oversized bool
	if r.tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)>$2`, eventJSON, domain.MaxEventBytes).Scan(&oversized) != nil {
		return domain.ErrCommandUnavailable
	}
	if oversized || len(eventJSON) > domain.MaxEventBytes {
		eventType = "canvas.invalidated"
		event["type"] = eventType
		event["data"] = map[string]any{"commandId": receipt.CommandID, "baseRevision": receipt.BaseRevision, "graphRevision": receipt.GraphRevision, "reason": "DELTA_TOO_LARGE"}
		eventJSON, err = json.Marshal(event)
		if err != nil {
			return domain.ErrCommandUnavailable
		}
	}
	if _, err = r.tx.Exec(ctx, `INSERT INTO canvas.project_events(project_id,owner_id,sequence,type,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6)`, project, owner, sequence, eventType, eventJSON, receipt.CommittedAt); err != nil {
		return domain.ErrCommandUnavailable
	}
	raw, err := json.Marshal(receipt)
	if err != nil {
		return domain.ErrCommandUnavailable
	}
	_, err = r.tx.Exec(ctx, `INSERT INTO canvas.command_receipts(command_id,owner_id,project_id,operation,key,request_hash,base_revision,graph_revision,event_sequence,receipt,committed_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, receipt.CommandID, owner, project, application.SubmitCanvasCommandOperation, key, hash, receipt.BaseRevision, receipt.GraphRevision, sequence, raw, receipt.CommittedAt, actor)
	if err != nil {
		return domain.ErrCommandUnavailable
	}
	return nil
}
