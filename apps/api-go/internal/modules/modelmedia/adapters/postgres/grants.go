package postgres

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	edomain "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/modelmedia/application"
	"strings"
)

type Visibility interface {
	Get(context.Context, string, string) (edomain.Task, error)
}
type Grants struct {
	pool       *pgxpool.Pool
	visibility Visibility
}

func New(pool *pgxpool.Pool, v Visibility) *Grants { return &Grants{pool, v} }
func (s *Grants) Resolve(ctx context.Context, r application.Request) (application.Asset, error) {
	if strings.HasPrefix(r.ReadGrantRef, "lfg_") {
		return s.resolveLongform(ctx, r)
	}
	var a application.Asset
	var task string
	err := s.pool.QueryRow(ctx, `SELECT a.id,a.storage_key,a.mime_type,a.checksum_sha256,a.byte_size,a.width,a.height,round(a.duration_seconds*1000)::bigint,g.task_id
 FROM execution.read_grants g JOIN public.assets a ON a.id=g.asset_id
 JOIN execution.tasks t ON t.id=g.task_id AND t.owner_id=g.owner_id
 JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
 WHERE g.id=$1 AND coalesce(t.initiated_by,t.owner_id)=$2 AND g.asset_id=$3 AND g.source_version=$4 AND g.checksum_sha256=$5
 AND g.expires_at>now() AND a.checksum_sha256=g.checksum_sha256 AND a.state='READY' AND a.deleted_at IS NULL`, r.ReadGrantRef, r.SubjectRef, r.SourceRef, r.SourceVersion, r.SHA256).Scan(&a.ID, &a.StorageKey, &a.MimeType, &a.SHA256, &a.ByteSize, &a.Width, &a.Height, &a.DurationMs, &task)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, application.ErrNotFound
	}
	if err != nil {
		return a, err
	}
	visible, err := s.visibility.Get(ctx, r.SubjectRef, task)
	if err != nil {
		if errors.Is(err, edomain.ErrNotFound) {
			err = application.ErrNotFound
		}
		return a, err
	}
	// Model read grants bind immutable content, not perpetual resource access.
	// Recheck the original initiator's local source grant on every fetch.
	if visible.Kind == "CANVAS" && visible.ProjectID != nil {
		err = collaboration.AuthorizeProjectAssets(ctx, s.pool, r.SubjectRef, *visible.ProjectID, []string{a.ID})
	} else {
		err = collaboration.RequireAssetProjectRead(ctx, s.pool, r.SubjectRef, a.ID)
		if err != nil {
			var api *httpapi.Error
			if errors.As(err, &api) && api.Status == 404 {
				err = collaboration.RequireAssetGrant(ctx, s.pool, r.SubjectRef, a.ID)
			}
		}
	}
	if err != nil {
		var api *httpapi.Error
		if errors.As(err, &api) && (api.Status == 404 || api.Status == 422) {
			return a, application.ErrNotFound
		}
		return a, err
	}
	return a, nil
}

// Longform imports use the same media reader and immutable content contract;
// their scoped grants bind the real initiator and live canvas/source access.
func (s *Grants) resolveLongform(ctx context.Context, r application.Request) (application.Asset, error) {
	var a application.Asset
	var canvas string
	err := s.pool.QueryRow(ctx, `SELECT a.id,a.storage_key,a.mime_type,a.checksum_sha256,a.byte_size,a.width,a.height,round(a.duration_seconds*1000)::bigint,l.canvas_id
 FROM longform.read_grants g JOIN longform.projects l ON l.id=g.project_id AND l.actor_id=g.actor_id
 JOIN public.assets a ON a.id=g.asset_id
 JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
 WHERE g.id=$1 AND g.actor_id=$2 AND g.asset_id=$3 AND g.source_version=$4 AND g.checksum_sha256=$5
 AND g.expires_at>now() AND a.checksum_sha256=g.checksum_sha256 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL`, r.ReadGrantRef, r.SubjectRef, r.SourceRef, r.SourceVersion, r.SHA256).Scan(&a.ID, &a.StorageKey, &a.MimeType, &a.SHA256, &a.ByteSize, &a.Width, &a.Height, &a.DurationMs, &canvas)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, application.ErrNotFound
	}
	if err != nil {
		return a, err
	}
	if _, err = collaboration.RequireProject(ctx, s.pool, r.SubjectRef, canvas, "EDITOR", false); err != nil {
		return a, application.ErrNotFound
	}
	if err = collaboration.AuthorizeProjectAssets(ctx, s.pool, r.SubjectRef, canvas, []string{a.ID}); err != nil {
		return a, application.ErrNotFound
	}
	return a, nil
}
