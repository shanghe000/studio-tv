package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

// withinLive reads ownership, graph and head from one committed database
// snapshot. A writer committing between the two HTTP reads remains replayable.
func (r *Repository) withinLive(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.pool == nil {
		return domain.ErrLiveUnavailable
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return domain.ErrLiveUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if err = fn(tx); err != nil {
		return err
	}
	if tx.Commit(ctx) != nil {
		return domain.ErrLiveUnavailable
	}
	return nil
}

func (r *Repository) OwnedLiveSnapshot(ctx context.Context, owner, project string) (domain.LiveSnapshot, error) {
	value := domain.LiveSnapshot{SchemaVersion: "1", ProjectID: project, NodeStates: []domain.NodeExecutionState{}, NodeExecutionAvailable: true}
	err := r.withinLive(ctx, func(tx pgx.Tx) error {
		scope, e := collaboration.RequireProject(ctx, tx, owner, project, "VIEWER", false)
		if e != nil {
			return projectAccessError(e)
		}
		owner = scope.StorageOwnerID
		var sequence int64
		err := tx.QueryRow(ctx, `SELECT graph,revision,event_sequence,updated_at FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND internal_kind IS NULL`, project, owner).Scan(&value.Graph, &value.GraphRevision, &sequence, &value.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil || value.GraphRevision < 1 || sequence < 0 || !json.Valid(value.Graph) {
			return domain.ErrLiveUnavailable
		}
		value.EventCursor = strconv.FormatInt(sequence, 10)
		value.UpdatedAt = value.UpdatedAt.UTC()
		// A binding belongs to one incarnation of a node. A deletion, recreation
		// or input change must not resurrect an older task's authority. Read the
		// binding, task evidence and graph from this same committed snapshot.
		rows, err := tx.Query(ctx, `SELECT b.node_id,b.task_id,b.execution_id,b.state,b.application_state,coalesce(b.reason,'')
		 FROM canvas.node_execution_bindings b
		 JOIN canvas.node_versions v ON v.project_id=b.project_id AND v.owner_id=b.owner_id AND v.node_id=b.node_id AND v.version=b.node_version AND v.present
		 JOIN execution.tasks t ON t.id=b.task_id AND t.owner_id=b.owner_id AND t.project_id=b.project_id AND t.kind='CANVAS'
		 WHERE b.project_id=$1 AND b.owner_id=$2
		 AND t.payload->'task'->>'canvasManaged'='true'
		 AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'task'->'plans') plan
		  WHERE plan->>'nodeId'=b.node_id AND plan->>'executionId'=b.execution_id AND plan->>'state'=b.state)
		 AND EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb->'nodes') node WHERE node->>'id'=b.node_id)
		 ORDER BY b.node_id`, project, owner, value.Graph)
		if err != nil {
			return domain.ErrLiveUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			var state domain.NodeExecutionState
			if rows.Scan(&state.NodeID, &state.TaskID, &state.ExecutionID, &state.State, &state.ApplicationState, &state.Reason) != nil || state.Validate() != nil {
				return domain.ErrLiveUnavailable
			}
			value.NodeStates = append(value.NodeStates, state)
		}
		if rows.Err() != nil {
			return domain.ErrLiveUnavailable
		}
		return nil
	})
	return value, err
}

func (r *Repository) OwnedProjectEvents(ctx context.Context, owner, project string, after int64, limit int) (domain.EventPage, error) {
	value := domain.EventPage{ProjectID: project, Events: []json.RawMessage{}, NextCursor: strconv.FormatInt(after, 10)}
	err := r.withinLive(ctx, func(tx pgx.Tx) error {
		scope, e := collaboration.RequireProject(ctx, tx, owner, project, "VIEWER", false)
		if e != nil {
			return projectAccessError(e)
		}
		owner = scope.StorageOwnerID
		var head int64
		err := tx.QueryRow(ctx, `SELECT event_sequence FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND internal_kind IS NULL`, project, owner).Scan(&head)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil || head < 0 {
			return domain.ErrLiveUnavailable
		}
		if after > head {
			return domain.ErrEventCursorAhead
		}
		value.EventCursor = strconv.FormatInt(head, 10)
		// The byte bound is applied in PostgreSQL before payload transfer.
		// Immutable historical changed events may exceed the new insert bound;
		// their replay projection is a same-sequence invalidation instead.
		rows, err := tx.Query(ctx, `WITH candidates AS (
		 SELECT sequence,CASE WHEN type='canvas.changed' AND octet_length(payload::text)>$5 THEN
		  jsonb_build_object('schemaVersion','1','projectId',project_id,'sequence',sequence::text,'occurredAt',occurred_at,
		   'source',payload->'source','type','canvas.invalidated','data',jsonb_build_object(
		    'commandId',payload->'data'->'commandId','baseRevision',payload->'data'->'baseRevision',
		    'graphRevision',payload->'data'->'graphRevision','reason','DELTA_TOO_LARGE'))
		  ELSE payload END AS replay_payload
		 FROM canvas.project_events WHERE project_id=$1 AND owner_id=$2 AND sequence>$3 AND sequence<=$4 ORDER BY sequence LIMIT $6
		), bounded AS (
		 SELECT sequence,replay_payload,sum(octet_length(replay_payload::text)) OVER(ORDER BY sequence) AS bytes FROM candidates
		) SELECT sequence,replay_payload FROM bounded WHERE bytes<=$7 ORDER BY sequence`, project, owner, after, head, domain.MaxEventBytes, limit, domain.MaxEventPageBytes)
		if err != nil {
			return domain.ErrLiveUnavailable
		}
		defer rows.Close()
		last := after
		bytes := 0
		for rows.Next() {
			var sequence int64
			var raw json.RawMessage
			if rows.Scan(&sequence, &raw) != nil || sequence != last+1 {
				return domain.ErrLiveUnavailable
			}
			raw, err = domain.ReplayProjectEvent(raw, project, sequence)
			if err != nil {
				return err
			}
			if bytes+len(raw) > domain.MaxEventPageBytes {
				break
			}
			value.Events = append(value.Events, raw)
			bytes += len(raw)
			last = sequence
		}
		if rows.Err() != nil || (last == after && after < head) {
			// There is no retention/pruning policy. Missing evidence is an
			// unavailable read, never a made-up expired-cursor response.
			return domain.ErrLiveUnavailable
		}
		value.NextCursor = strconv.FormatInt(last, 10)
		value.HasMore = last < head
		return nil
	})
	return value, err
}
