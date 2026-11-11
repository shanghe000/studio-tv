package postgres

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type Repository struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool} }
func (s *Repository) OwnedSnapshot(ctx context.Context, owner, project string) (application.Snapshot, error) {
	var snapshot application.Snapshot
	scope, e := collaboration.RequireProject(ctx, s.pool, owner, project, "VIEWER", false)
	if e != nil {
		return snapshot, projectAccessError(e)
	}
	owner = scope.StorageOwnerID
	err := s.pool.QueryRow(ctx, `SELECT revision,graph FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND internal_kind IS NULL`, project, owner).Scan(&snapshot.Revision, &snapshot.Graph)
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshot, domain.ErrNotFound
	}
	return snapshot, err
}

func projectAccessError(err error) error {
	var api *httpapi.Error
	if errors.As(err, &api) && api.Status == 404 {
		return domain.ErrNotFound
	}
	return err
}
