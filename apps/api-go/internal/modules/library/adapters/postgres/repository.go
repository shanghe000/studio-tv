// Package postgres binds private gallery repositories to a real transaction.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"strings"
	"time"
)

type UnitOfWork struct{ pool *pgxpool.Pool }

var _ application.UnitOfWork = (*UnitOfWork)(nil)

func New(pool *pgxpool.Pool) (*UnitOfWork, error) {
	if pool == nil {
		return nil, errors.New("library postgres pool is required")
	}
	return &UnitOfWork{pool}, nil
}
func (u *UnitOfWork) Within(ctx context.Context, fn func(application.Repositories) error) error {
	tx, e := u.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if e != nil {
		return domain.ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if e = fn(&repository{tx}); e != nil {
		return e
	}
	return storageError(tx.Commit(ctx))
}

type repository struct{ tx pgx.Tx }

var _ application.Repositories = (*repository)(nil)

func (r *repository) LockCollection(ctx context.Context, owner string) error {
	if _, e := r.tx.Exec(ctx, "INSERT INTO library.collections(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING", owner); e != nil {
		return domain.ErrUnavailable
	}
	var revision int64
	return storageError(r.tx.QueryRow(ctx, "SELECT revision FROM library.collections WHERE owner_id=$1 FOR UPDATE", owner).Scan(&revision))
}
func (r *repository) AdvanceCollection(ctx context.Context, owner string) error {
	_, e := r.tx.Exec(ctx, "UPDATE library.collections SET revision=revision+1,updated_at=now() WHERE owner_id=$1", owner)
	return storageError(e)
}
func (r *repository) LockIdempotency(ctx context.Context, owner, op, key string) error {
	_, e := r.tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner+":"+op+":"+key)
	return storageError(e)
}

type receiptBody struct {
	ID string `json:"id"`
	domain.Input
	Revision  int64     `json:"revision"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (r *repository) FindReceipt(ctx context.Context, owner, op, key string) (*application.Receipt, error) {
	var hash string
	var status int
	var raw []byte
	e := r.tx.QueryRow(ctx, "SELECT request_hash,response_status,response_body FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3", owner, op, key).Scan(&hash, &status, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, domain.ErrUnavailable
	}
	var body receiptBody
	if status != 201 || json.Unmarshal(raw, &body) != nil || body.Input.Validate() != nil || !domain.ValidID(body.ID) || body.Revision < 1 || body.CreatedAt.IsZero() || body.UpdatedAt.IsZero() {
		return nil, domain.ErrUnavailable
	}
	return &application.Receipt{RequestHash: hash, Gallery: domain.Gallery{ID: body.ID, OwnerID: owner, Input: body.Input, Revision: body.Revision, CreatedAt: body.CreatedAt, UpdatedAt: body.UpdatedAt}}, nil
}
func (r *repository) SaveReceipt(ctx context.Context, owner, op, key string, receipt application.Receipt) error {
	g := receipt.Gallery
	raw, e := json.Marshal(receiptBody{g.ID, g.Input, g.Revision, g.CreatedAt.UTC().Truncate(time.Millisecond), g.UpdatedAt.UTC().Truncate(time.Millisecond)})
	if e != nil {
		return domain.ErrUnavailable
	}
	_, e = r.tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,201,$5)", owner, op, key, receipt.RequestHash, raw)
	return storageError(e)
}
func (r *repository) VisibleAssets(ctx context.Context, owner string, ids []string, lock bool) ([]string, error) {
	result := []string{}
	if len(ids) == 0 {
		return result, nil
	}
	query := "SELECT a.id FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.owner_id=$1 AND a.id=ANY($2::text[]) AND a.state='READY' AND a.deleted_at IS NULL AND a.kind='IMAGE' AND p.deleted_at IS NULL ORDER BY a.id"
	if lock {
		query += " FOR SHARE OF a,p"
	}
	rows, e := r.tx.Query(ctx, query, owner, ids)
	if e != nil {
		return nil, domain.ErrUnavailable
	}
	defer rows.Close()
	visible := map[string]bool{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil {
			return nil, domain.ErrUnavailable
		}
		visible[id] = true
	}
	if e = rows.Err(); e != nil {
		return nil, domain.ErrUnavailable
	}
	for _, id := range ids {
		if visible[id] {
			result = append(result, id)
		}
	}
	return result, nil
}
func (r *repository) CreateGallery(ctx context.Context, g domain.Gallery) error {
	_, e := r.tx.Exec(ctx, `INSERT INTO library.items(id,owner_id,title,description,kind,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, g.ID, g.OwnerID, g.Title, g.Description, g.Kind, g.Revision, g.CreatedAt, g.UpdatedAt)
	if e != nil {
		return domain.ErrUnavailable
	}
	return r.replaceRefs(ctx, g)
}

const galleryColumns = "id,owner_id,title,description,kind,revision,created_at,updated_at,deleted_at,category_code,folder_id"

func (r *repository) Gallery(ctx context.Context, owner, id string, write bool) (domain.Gallery, error) {
	query := "SELECT " + galleryColumns + " FROM library.items i WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND (folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=i.folder_id AND f.owner_id=i.owner_id))"
	if write {
		query += " FOR UPDATE"
	} else {
		query += " FOR SHARE"
	}
	var g domain.Gallery
	e := r.tx.QueryRow(ctx, query, owner, id).Scan(&g.ID, &g.OwnerID, &g.Title, &g.Description, &g.Kind, &g.Revision, &g.CreatedAt, &g.UpdatedAt, &g.DeletedAt, &g.CategoryCode, &g.FolderID)
	if errors.Is(e, pgx.ErrNoRows) {
		return g, domain.ErrNotFound
	}
	if e != nil {
		return g, domain.ErrUnavailable
	}
	rows, e := r.tx.Query(ctx, "SELECT asset_id,is_main FROM library.item_media_refs WHERE item_id=$1 AND owner_id=$2 ORDER BY sort_order,asset_id", id, owner)
	if e != nil {
		return g, domain.ErrUnavailable
	}
	defer rows.Close()
	g.AssetIDs = []string{}
	for rows.Next() {
		var aid string
		var main bool
		if rows.Scan(&aid, &main) != nil {
			return g, domain.ErrUnavailable
		}
		g.AssetIDs = append(g.AssetIDs, aid)
		if main {
			v := aid
			g.MainAssetID = &v
		}
	}
	return g, storageError(rows.Err())
}
func (r *repository) SaveGallery(ctx context.Context, g domain.Gallery, expected int64) error {
	result, e := r.tx.Exec(ctx, `UPDATE library.items SET title=$4,description=$5,revision=$6,updated_at=$7,deleted_at=$8 WHERE id=$1 AND owner_id=$2 AND revision=$3 AND deleted_at IS NULL`, g.ID, g.OwnerID, expected, g.Title, g.Description, g.Revision, g.UpdatedAt, g.DeletedAt)
	if e != nil {
		return domain.ErrUnavailable
	}
	if result.RowsAffected() != 1 {
		return domain.ErrNotFound
	}
	if g.DeletedAt != nil {
		return nil
	}
	return r.replaceRefs(ctx, g)
}
func (r *repository) replaceRefs(ctx context.Context, g domain.Gallery) error {
	if _, e := r.tx.Exec(ctx, "DELETE FROM library.item_media_refs WHERE item_id=$1 AND owner_id=$2", g.ID, g.OwnerID); e != nil {
		return domain.ErrUnavailable
	}
	for order, id := range g.AssetIDs {
		main := g.MainAssetID != nil && *g.MainAssetID == id
		if _, e := r.tx.Exec(ctx, "INSERT INTO library.item_media_refs(item_id,owner_id,asset_id,sort_order,is_main) VALUES($1,$2,$3,$4,$5)", g.ID, g.OwnerID, id, order, main); e != nil {
			return domain.ErrUnavailable
		}
	}
	return nil
}

type galleryRecord struct {
	CategoryCode string      `json:"category_code"`
	FolderID     *string     `json:"folder_id"`
	ID           string      `json:"id"`
	OwnerID      string      `json:"owner_id"`
	Title        string      `json:"title"`
	Description  string      `json:"description"`
	Kind         domain.Kind `json:"kind"`
	Revision     int64       `json:"revision"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
	AssetIDs     []string    `json:"asset_ids"`
	MainAssetID  *string     `json:"main_asset_id"`
}

func (r *repository) Galleries(ctx context.Context, owner string, q domain.Query) (domain.Page, error) {
	var total int64
	var raw []byte
	// Count and IDs are selected in one snapshot. Ref aggregation only runs for
	// the ID page, so multi-image galleries cannot duplicate records or totals.
	e := r.tx.QueryRow(ctx, `WITH filtered AS MATERIALIZED (
 SELECT `+galleryColumns+` FROM library.items i WHERE owner_id=$1 AND deleted_at IS NULL AND (folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=i.folder_id AND f.owner_id=i.owner_id))
 AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR title ILIKE $3 OR description ILIKE $3)),
 page AS (SELECT * FROM filtered ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5),
 enriched AS (SELECT page.*,COALESCE(refs.asset_ids,'[]'::jsonb) AS asset_ids,refs.main_asset_id FROM page
 LEFT JOIN LATERAL (SELECT jsonb_agg(asset_id ORDER BY sort_order,asset_id) AS asset_ids,
 max(asset_id) FILTER(WHERE is_main) AS main_asset_id FROM library.item_media_refs WHERE item_id=page.id AND owner_id=page.owner_id) refs ON true),
 total AS (SELECT count(*) AS n FROM filtered)
 SELECT total.n,COALESCE(jsonb_agg(to_jsonb(enriched) ORDER BY enriched.updated_at DESC,enriched.id) FILTER(WHERE enriched.id IS NOT NULL),'[]'::jsonb)
 FROM total LEFT JOIN enriched ON true GROUP BY total.n`, owner, q.Kind, search(q.Keyword), q.Size, q.Offset()).Scan(&total, &raw)
	if e != nil {
		return domain.Page{}, domain.ErrUnavailable
	}
	var records []galleryRecord
	if json.Unmarshal(raw, &records) != nil {
		return domain.Page{}, domain.ErrUnavailable
	}
	roots := make([]domain.Gallery, 0, len(records))
	for _, g := range records {
		roots = append(roots, domain.Gallery{ID: g.ID, OwnerID: g.OwnerID, CategoryCode: g.CategoryCode, FolderID: g.FolderID, Input: domain.Input{Title: g.Title, Description: g.Description, Kind: g.Kind, AssetIDs: g.AssetIDs, MainAssetID: g.MainAssetID}, Revision: g.Revision, CreatedAt: g.CreatedAt, UpdatedAt: g.UpdatedAt})
	}
	return domain.NewPage(q, roots, total), nil
}
func search(v string) any {
	if v == "" {
		return nil
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(v) + "%"
}
func storageError(e error) error {
	if e != nil {
		return domain.ErrUnavailable
	}
	return nil
}
