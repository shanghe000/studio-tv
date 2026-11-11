package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

func (s *Store) Heartbeat(ctx context.Context, id, lease string) (bool, error) {
	tag, err := s.pool.Exec(ctx, "UPDATE execution.tasks SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND state IN ('QUEUED','RUNNING')", id, lease)
	return tag.RowsAffected() == 1, err
}
func (s *Store) BindInputs(ctx context.Context, t domain.Task, lease string, grants []application.Grant) (bool, error) {
	return retryTransaction(ctx, func() (bool, error) {
		return s.bindInputsOnce(ctx, t, lease, grants)
	})
}

func (s *Store) bindInputsOnce(ctx context.Context, t domain.Task, lease string, grants []application.Grant) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var id string
	// Match Save/Cancel: acquire the task before any parent project lock.
	err = tx.QueryRow(ctx, "SELECT t.id FROM execution.tasks t WHERE "+visible+" AND t.id=$2 AND t.lease_token=$3 AND t.state IN ('QUEUED','RUNNING') FOR UPDATE", taskActor(t), t.ID, lease).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err = validateHistoryInputs(ctx, tx, t); err != nil {
		return false, err
	}
	if err = authorizeTaskWrite(ctx, tx, taskActor(t), t); err != nil {
		return false, err
	}
	// Recheck already frozen media too, including inputs accepted before the
	// private manifest existed. Source-project deletion invalidates new use.
	checked := map[string]bool{}
	for _, plan := range t.Plans {
		var request struct {
			Attachments []struct{ SourceRef, SourceVersion string }
		}
		if json.Unmarshal(plan.Request, &request) != nil {
			return false, domain.ErrInvalid
		}
		for _, a := range request.Attachments {
			if !checked[a.SourceRef] {
				if err = authorizeTaskAssets(ctx, tx, t, []string{a.SourceRef}); err != nil {
					return false, err
				}
				if err = validateInputAsset(ctx, tx, t.OwnerID, a.SourceRef, a.SourceVersion); err != nil {
					return false, err
				}
				checked[a.SourceRef] = true
			}
		}
	}
	for _, g := range grants {
		if err = authorizeTaskAssets(ctx, tx, t, []string{g.AssetID}); err != nil {
			return false, err
		}
		var checksum string
		err = tx.QueryRow(ctx, "SELECT a.checksum_sha256 FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=$1 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL FOR SHARE OF a,p", g.AssetID).Scan(&checksum)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, domain.ErrNotFound
		}
		if err != nil {
			return false, err
		}
		if checksum != g.SHA256 || g.Version != "sha256:"+checksum {
			return false, domain.ErrConflict
		}
		_, err = tx.Exec(ctx, "INSERT INTO execution.task_assets(task_id,owner_id,asset_id,direction)VALUES($1,$2,$3,'INPUT') ON CONFLICT DO NOTHING", t.ID, t.OwnerID, g.AssetID)
		if err != nil {
			return false, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO execution.read_grants(id,task_id,owner_id,asset_id,source_version,checksum_sha256,expires_at)VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')", g.ID, t.ID, t.OwnerID, g.AssetID, g.Version, g.SHA256)
		if err != nil {
			return false, err
		}
	}
	return true, tx.Commit(ctx)
}
