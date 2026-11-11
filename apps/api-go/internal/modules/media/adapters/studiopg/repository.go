package studiopg

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	execdomain "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/media/application"
	"studiotv.local/service/api/internal/modules/media/domain"
)

type Repository struct {
	pool  *pgxpool.Pool
	store execution.Store
}

func New(pool *pgxpool.Pool, store execution.Store) (*Repository, error) {
	if pool == nil || store == nil {
		return nil, errors.New("studio repository dependencies required")
	}
	return &Repository{pool, store}, nil
}

const rootSQL = `SELECT s.project_id,s.revision FROM resources.studio_projects s LEFT JOIN public.projects p ON p.id=s.project_id AND p.owner_id=s.owner_id WHERE s.id=$1 AND s.owner_id=$2 AND s.deleted_at IS NULL AND (s.project_id IS NULL OR p.deleted_at IS NULL)`

func (r *Repository) Visible(ctx context.Context, owner, id string) error {
	var project *string
	var revision int64
	err := r.pool.QueryRow(ctx, rootSQL, id, owner).Scan(&project, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return execdomain.ErrNotFound
	}
	return err
}
func (r *Repository) Snapshot(ctx context.Context, owner, id string, expected int64) (domain.StudioBundle, error) {
	b := domain.StudioBundle{ID: id, Files: []domain.StudioFile{}}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return b, err
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, rootSQL+" FOR SHARE OF s", id, owner).Scan(&b.ProjectID, &b.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, execdomain.ErrNotFound
	}
	if err != nil {
		return b, err
	}
	if expected > 0 && b.Revision != expected {
		return b, httpapi.Fail(412, "REVISION_CONFLICT", "项目文件已改变，请刷新后重试。")
	}
	rows, err := tx.Query(ctx, `SELECT path,mime_type,content FROM resources.studio_files WHERE project_id=$1 AND owner_id=$2 ORDER BY path`, id, owner)
	if err != nil {
		return b, err
	}
	total := 0
	for rows.Next() {
		var f domain.StudioFile
		if err = rows.Scan(&f.Path, &f.MimeType, &f.Content); err != nil {
			rows.Close()
			return b, err
		}
		total += len(f.Content)
		if len(b.Files) >= 100 || total > 32<<20 || !domain.ValidPath(f.Path) {
			rows.Close()
			return b, domain.ErrInvalid
		}
		b.Files = append(b.Files, f)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return b, err
	}
	return b, tx.Commit(ctx)
}
func (r *Repository) SaveFile(ctx context.Context, owner, id string, f application.RenderFile) error {
	if len(f.Content) < 1 || len(f.Content) > 536870912 || f.DurationMs <= 0 || !domain.ValidPath(f.Name) {
		return domain.ErrInvalid
	}
	digest := sha256.Sum256(f.Content)
	tag, err := r.pool.Exec(ctx, `INSERT INTO media.studio_outputs(task_id,owner_id,file_name,mime_type,content,duration_ms,width,height,checksum_sha256) SELECT id,owner_id,$3,$4,$5,$6,$7,$8,$9 FROM execution.tasks WHERE id=$1 AND owner_id=$2 AND kind='STUDIO' AND state='RUNNING' ON CONFLICT(task_id) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,content=EXCLUDED.content,duration_ms=EXCLUDED.duration_ms,width=EXCLUDED.width,height=EXCLUDED.height,checksum_sha256=EXCLUDED.checksum_sha256`, id, owner, f.Name, f.MimeType, f.Content, f.DurationMs, f.Width, f.Height, hex.EncodeToString(digest[:]))
	if err == nil && tag.RowsAffected() != 1 {
		return execdomain.ErrNotFound
	}
	return err
}
func (r *Repository) File(ctx context.Context, owner, id string) (application.RenderFile, error) {
	return r.readFile(ctx, owner, id, false)
}
func (r *Repository) Checkpoint(ctx context.Context, owner, id string) (application.RenderFile, error) {
	return r.readFile(ctx, owner, id, true)
}
func (r *Repository) readFile(ctx context.Context, owner, id string, checkpoint bool) (application.RenderFile, error) {
	var f application.RenderFile
	var checksum string
	state := "t.state='SUCCEEDED'"
	if checkpoint {
		state = "t.state='RUNNING'"
	}
	err := r.pool.QueryRow(ctx, `SELECT file_name,mime_type,content,duration_ms,width,height,checksum_sha256 FROM media.studio_outputs o JOIN execution.tasks t ON t.id=o.task_id AND t.owner_id=o.owner_id WHERE o.task_id=$1 AND o.owner_id=$2 AND `+state+` AND t.history_deleted_at IS NULL`, id, owner).Scan(&f.Name, &f.MimeType, &f.Content, &f.DurationMs, &f.Width, &f.Height, &checksum)
	if errors.Is(err, pgx.ErrNoRows) {
		return f, execdomain.ErrNotFound
	}
	if err != nil {
		return f, err
	}
	digest := sha256.Sum256(f.Content)
	if hex.EncodeToString(digest[:]) != checksum {
		return f, httpapi.Fail(503, "STUDIO_OUTPUT_INTEGRITY_FAILED", "渲染文件校验失败。")
	}
	return f, nil
}

func (r *Repository) Renders(ctx context.Context, owner, project string) ([]execdomain.Task, error) {
	if err := r.Visible(ctx, owner, project); err != nil {
		return nil, err
	}
	rows, err := r.pool.Query(ctx, `SELECT id FROM execution.tasks WHERE owner_id=$1 AND kind='STUDIO' AND payload->'task'->>'targetId'=$2 AND history_deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 1001`, owner, project)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(ids) > 1000 {
		return nil, httpapi.Fail(413, "STUDIO_HISTORY_LIMIT", "渲染历史超出单次读取限制。")
	}
	result := []execdomain.Task{}
	for _, id := range ids {
		t, e := r.store.Get(ctx, owner, id)
		if e != nil {
			return nil, e
		}
		result = append(result, t)
	}
	return result, nil
}
func (r *Repository) Hide(ctx context.Context, owner, id string, revision int64) error {
	tag, err := r.pool.Exec(ctx, `UPDATE execution.tasks SET history_deleted_at=now() WHERE id=$1 AND owner_id=$2 AND kind='STUDIO' AND state IN('SUCCEEDED','FAILED','CANCELED') AND revision=$3::bigint`, id, owner, revision)
	if err == nil && tag.RowsAffected() != 1 {
		return httpapi.Fail(412, "REVISION_CONFLICT", "渲染任务已改变，请刷新后重试。")
	}
	return err
}

var _ application.StudioPort = (*Repository)(nil)
