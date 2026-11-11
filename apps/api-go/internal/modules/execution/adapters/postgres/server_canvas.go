package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/principal"
)

func (s *Store) CanvasSnapshot(ctx context.Context, owner, project string) (json.RawMessage, int64, error) {
	var graph json.RawMessage
	var revision int64
	err := s.pool.QueryRow(ctx, `SELECT graph,revision FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND internal_kind IS NULL`, project, owner).Scan(&graph, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		err = domain.ErrNotFound
	}
	return graph, revision, err
}
func (s *Store) CanvasReceipt(ctx context.Context, owner, key, hash string) (domain.Task, bool, error) {
	var id, stored string
	err := s.pool.QueryRow(ctx, `SELECT id,request_hash FROM execution.tasks WHERE owner_id=$1 AND kind='CANVAS' AND idempotency_key=$2`, owner, key).Scan(&id, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Task{}, false, nil
	}
	if err != nil {
		return domain.Task{}, false, err
	}
	t, err := s.Get(ctx, principal.Actor(ctx, owner), id)
	if err != nil {
		return domain.Task{}, false, err
	}
	if stored != hash || taskActor(t) != principal.Actor(ctx, owner) {
		return domain.Task{}, false, domain.ErrConflict
	}
	return t, true, nil
}
