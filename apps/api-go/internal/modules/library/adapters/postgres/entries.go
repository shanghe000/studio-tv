package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	resource "studiotv.local/service/api/internal/modules/resources/domain"
	"strings"
	"time"
)

type EntryRepository struct{ pool *pgxpool.Pool }

var _ application.EntryRepository = (*EntryRepository)(nil)

func NewEntries(pool *pgxpool.Pool) (*EntryRepository, error) {
	if pool == nil {
		return nil, errors.New("library entry pool required")
	}
	return &EntryRepository{pool}, nil
}
func (r *EntryRepository) within(ctx context.Context, a domain.VerifiedActor, fn func(pgx.Tx, int64) error) error {
	if e := a.Validate(); e != nil {
		return e
	}
	tx, e := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if e != nil {
		return domain.ErrUnavailable
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(c)
	}()
	repo := repository{tx}
	if e = repo.LockCollection(ctx, a.OwnerID); e != nil {
		return e
	}
	var rev int64
	if e = tx.QueryRow(ctx, "SELECT revision FROM library.collections WHERE owner_id=$1", a.OwnerID).Scan(&rev); e != nil {
		return domain.ErrUnavailable
	}
	if e = fn(tx, rev); e != nil {
		return e
	}
	return storageError(tx.Commit(ctx))
}
func entryReceipt(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor, op string, m application.EntryMutation, out any) (bool, error) {
	if m.Key == "" {
		return false, nil
	}
	if _, e := application.NormalizeKey(m.Key); e != nil {
		return false, e
	}
	var hash string
	var raw []byte
	e := tx.QueryRow(ctx, "SELECT request_hash,response_body FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3", a.OwnerID, op, m.Key).Scan(&hash, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, domain.ErrUnavailable
	}
	if hash != m.Hash {
		return false, domain.ErrIdempotencyConflict
	}
	if json.Unmarshal(raw, out) != nil {
		return false, domain.ErrUnavailable
	}
	return true, nil
}
func entrySaveReceipt(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor, op string, m application.EntryMutation, out any) error {
	if m.Key == "" {
		return nil
	}
	raw, e := json.Marshal(out)
	if e != nil {
		return domain.ErrUnavailable
	}
	_, e = tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,200,$5)", a.OwnerID, op, m.Key, m.Hash, raw)
	return storageError(e)
}
func advance(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor) (int64, error) {
	var rev int64
	e := tx.QueryRow(ctx, "UPDATE library.collections SET revision=revision+1,updated_at=now() WHERE owner_id=$1 RETURNING revision", a.OwnerID).Scan(&rev)
	return rev, storageError(e)
}
func ensureFolder(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor, id *string, category string) error {
	if id == nil {
		return nil
	}
	var code string
	e := tx.QueryRow(ctx, "SELECT category_code FROM library.visible_folders WHERE id=$1 AND owner_id=$2", *id, a.OwnerID).Scan(&code)
	if errors.Is(e, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if e != nil {
		return domain.ErrUnavailable
	}
	if category != "" && code != category {
		return domain.ErrInvalid
	}
	return nil
}
func entryAssets(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor, refs []resource.AssetRef) error {
	for _, ref := range refs {
		var kind, mimeType, fileName string
		e := tx.QueryRow(ctx, `SELECT a.kind,a.mime_type,a.file_name FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=$1 AND a.owner_id=$2 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL FOR SHARE OF a,p`, ref.ID, a.OwnerID).Scan(&kind, &mimeType, &fileName)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrAssetNotFound
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		if ref.Kind != "" && kind != ref.Kind && !(ref.Kind == "MODEL" && kind == "FILE" && validNodeModel(mimeType, fileName)) {
			return domain.ErrAssetNotFound
		}
	}
	return nil
}
func (r *EntryRepository) State(ctx context.Context, a domain.VerifiedActor) (int64, error) {
	var rev int64
	e := r.within(ctx, a, func(_ pgx.Tx, n int64) error { rev = n; return nil })
	return rev, e
}
func folder(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor, id string) (domain.Folder, error) {
	var f domain.Folder
	e := tx.QueryRow(ctx, `SELECT id,name,kind,category_code,parent_id,revision,created_at,updated_at FROM library.visible_folders WHERE id=$1 AND owner_id=$2`, id, a.OwnerID).Scan(&f.ID, &f.Name, &f.Kind, &f.CategoryCode, &f.ParentID, &f.Revision, &f.CreatedAt, &f.UpdatedAt)
	if errors.Is(e, pgx.ErrNoRows) {
		return f, domain.ErrNotFound
	}
	if e != nil {
		return f, domain.ErrUnavailable
	}
	f.ThumbnailAssetIDs = []string{}
	rows, e := tx.Query(ctx, `SELECT r.asset_id FROM library.folder_media_refs r JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.owner_id JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE r.folder_id=$1 AND r.owner_id=$2 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY r.sort_order`, id, a.OwnerID)
	if e != nil {
		return f, domain.ErrUnavailable
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil {
			rows.Close()
			return f, domain.ErrUnavailable
		}
		f.ThumbnailAssetIDs = append(f.ThumbnailAssetIDs, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return f, domain.ErrUnavailable
	}
	e = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM library.visible_folders WHERE parent_id=$1 AND owner_id=$2)+(SELECT count(*) FROM library.nodes WHERE folder_id=$1 AND owner_id=$2 AND deleted_at IS NULL)+(SELECT count(*) FROM library.items WHERE folder_id=$1 AND owner_id=$2 AND deleted_at IS NULL)`, id, a.OwnerID).Scan(&f.ItemCount)
	return f, storageError(e)
}
func (r *EntryRepository) Folder(ctx context.Context, a domain.VerifiedActor, id string) (domain.Folder, error) {
	var f domain.Folder
	e := r.within(ctx, a, func(tx pgx.Tx, _ int64) error { var e error; f, e = folder(ctx, tx, a, id); return e })
	return f, e
}
func (r *EntryRepository) CreateFolder(ctx context.Context, a domain.VerifiedActor, i domain.FolderInput, m application.EntryMutation) (domain.Folder, error) {
	var result domain.Folder
	if e := i.Validate(); e != nil {
		return result, e
	}
	if _, e := application.NormalizeKey(m.Key); e != nil {
		return result, e
	}
	e := r.within(ctx, a, func(tx pgx.Tx, _ int64) error {
		ok, e := entryReceipt(ctx, tx, a, "libraryCreateFolder", m, &result)
		if e != nil {
			return e
		}
		if ok {
			_, e = folder(ctx, tx, a, result.ID)
			return e
		}
		if e = ensureFolder(ctx, tx, a, i.ParentID, i.CategoryCode); e != nil {
			return e
		}
		id := "fld_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		_, e = tx.Exec(ctx, `INSERT INTO library.folders(id,owner_id,name,category_code,parent_id) VALUES($1,$2,$3,$4,$5)`, id, a.OwnerID, i.Name, i.CategoryCode, i.ParentID)
		if e != nil {
			return domain.ErrUnavailable
		}
		if _, e = advance(ctx, tx, a); e != nil {
			return e
		}
		result, e = folder(ctx, tx, a, id)
		if e != nil {
			return e
		}
		return entrySaveReceipt(ctx, tx, a, "libraryCreateFolder", m, result)
	})
	return result, e
}
func (r *EntryRepository) UpdateFolder(ctx context.Context, a domain.VerifiedActor, id string, i domain.FolderPatch, m application.EntryMutation) (domain.Folder, error) {
	var result domain.Folder
	if e := i.Validate(); e != nil {
		return result, e
	}
	e := r.within(ctx, a, func(tx pgx.Tx, _ int64) error {
		f, e := folder(ctx, tx, a, id)
		if e != nil {
			return e
		}
		if f.Revision != m.Expected {
			return &domain.VersionConflict{Current: f.Revision}
		}
		name := f.Name
		if i.Name != nil {
			name = *i.Name
		}
		if i.ThumbnailAssetIDs != nil {
			refs := []resource.AssetRef{}
			for _, id := range i.ThumbnailAssetIDs {
				refs = append(refs, resource.AssetRef{ID: id, Kind: "IMAGE"})
			}
			if e = entryAssets(ctx, tx, a, refs); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, "DELETE FROM library.folder_media_refs WHERE folder_id=$1 AND owner_id=$2", id, a.OwnerID); e != nil {
				return domain.ErrUnavailable
			}
			for n, aid := range i.ThumbnailAssetIDs {
				if _, e = tx.Exec(ctx, "INSERT INTO library.folder_media_refs(folder_id,owner_id,asset_id,sort_order) VALUES($1,$2,$3,$4)", id, a.OwnerID, aid, n); e != nil {
					return domain.ErrUnavailable
				}
			}
		}
		_, e = tx.Exec(ctx, "UPDATE library.folders SET name=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2", id, a.OwnerID, name)
		if e != nil {
			return domain.ErrUnavailable
		}
		if _, e = advance(ctx, tx, a); e != nil {
			return e
		}
		result, e = folder(ctx, tx, a, id)
		return e
	})
	return result, e
}
func (r *EntryRepository) Folders(ctx context.Context, a domain.VerifiedActor, q domain.EntryQuery) (domain.EntriesPage, error) {
	q.FoldersOnly = true
	return r.Entries(ctx, a, q)
}
func (r *EntryRepository) Entries(ctx context.Context, a domain.VerifiedActor, q domain.EntryQuery) (domain.EntriesPage, error) {
	var result domain.EntriesPage
	if q.NodeTypes == nil {
		q.NodeTypes = []string{}
	}
	if e := q.Validate(); e != nil {
		return result, e
	}
	e := r.within(ctx, a, func(tx pgx.Tx, _ int64) error {
		if e := ensureFolder(ctx, tx, a, q.ParentID, ""); e != nil {
			return e
		}
		var raw []byte
		sql := `WITH RECURSIVE subtree(id) AS (SELECT id FROM library.visible_folders WHERE id=$2 AND owner_id=$1 UNION ALL SELECT f.id FROM library.visible_folders f JOIN subtree s ON s.id=f.parent_id WHERE f.owner_id=$1), all_entries AS (
 SELECT f.id,f.parent_id AS parent_id,f.category_code,f.name,f.kind,'FOLDER'::text AS item_type,f.created_at,f.updated_at,jsonb_build_object('id',f.id,'name',f.name,'kind',f.kind,'itemType','FOLDER','categoryCode',f.category_code,'parentId',f.parent_id,'revision',f.revision,'createdAt',f.created_at,'updatedAt',f.updated_at,'thumbnailAssetIds',COALESCE((SELECT jsonb_agg(r.asset_id ORDER BY r.sort_order) FROM library.folder_media_refs r JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.owner_id JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE r.folder_id=f.id AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL),'[]'::jsonb),'itemCount',(SELECT count(*) FROM library.nodes n WHERE n.folder_id=f.id AND n.deleted_at IS NULL)+(SELECT count(*) FROM library.items i WHERE i.folder_id=f.id AND i.deleted_at IS NULL)+(SELECT count(*) FROM library.visible_folders c WHERE c.parent_id=f.id)) AS body FROM library.visible_folders f WHERE f.owner_id=$1
 UNION ALL SELECT n.id,n.folder_id,n.category_code,n.name,n.kind,'NODE',n.created_at,n.updated_at,jsonb_build_object('id',n.id,'name',n.name,'kind',n.kind,'itemType','NODE','categoryCode',n.category_code,'folderId',n.folder_id,'content',n.content,'thumbnailAssetId',n.thumbnail_asset_id,'revision',n.revision,'createdAt',n.created_at,'updatedAt',n.updated_at) FROM library.nodes n WHERE n.owner_id=$1 AND n.deleted_at IS NULL AND (n.folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=n.folder_id AND f.owner_id=n.owner_id)) AND NOT EXISTS(SELECT 1 FROM library.node_asset_refs r LEFT JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.owner_id LEFT JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE r.node_id=n.id AND (a.id IS NULL OR a.state<>'READY' OR a.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL))
 UNION ALL SELECT i.id,i.folder_id,i.category_code,i.title,i.kind,CASE WHEN i.kind='ROLE' THEN 'ROLE_GALLERY' ELSE 'SCENE_GALLERY' END,i.created_at,i.updated_at,jsonb_build_object('id',i.id,'title',i.title,'name',i.title,'description',i.description,'kind',i.kind,'itemType',CASE WHEN i.kind='ROLE' THEN 'ROLE_GALLERY' ELSE 'SCENE_GALLERY' END,'categoryCode',i.category_code,'folderId',i.folder_id,'revision',i.revision,'createdAt',i.created_at,'updatedAt',i.updated_at,'assetIds',COALESCE((SELECT jsonb_agg(r.asset_id ORDER BY r.sort_order) FROM library.item_media_refs r JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.owner_id JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE r.item_id=i.id AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL),'[]'::jsonb),'mainAssetId',(SELECT r.asset_id FROM library.item_media_refs r JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.owner_id JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE r.item_id=i.id AND r.is_main AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL)) FROM library.items i WHERE i.owner_id=$1 AND i.deleted_at IS NULL AND (i.folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=i.folder_id AND f.owner_id=i.owner_id))), filtered AS MATERIALIZED(SELECT * FROM all_entries WHERE (($3 AND ($2::text IS NULL OR parent_id IN(SELECT id FROM subtree))) OR (NOT $3 AND parent_id IS NOT DISTINCT FROM $2)) AND ($4='' OR category_code=$4) AND name ILIKE $5 AND ($6='' OR kind=$6) AND ($7='' OR item_type=$7) AND ($8::timestamptz IS NULL OR created_at>=$8) AND ($9::timestamptz IS NULL OR created_at<=$9) AND (NOT $10 OR item_type='FOLDER') AND (cardinality($13::text[])=0 OR kind=ANY($13) OR body->'content'->>'nodeType'=ANY($13)) AND ($14='' OR ($14='ITEM' AND item_type<>'FOLDER') OR ($14='GROUP' AND item_type='FOLDER') OR ($14 NOT IN('ITEM','GROUP') AND COALESCE(body->'content'->'nodeContent'->>'nodeKind',body->'content'->'nodeContent'->'data'->>'nodeKind',body->'content'->'nodeContent'->'data'->>'subType')=$14))), page AS(SELECT * FROM filtered ORDER BY updated_at DESC,id LIMIT $11 OFFSET $12), total AS(SELECT count(*) n FROM filtered) SELECT total.n,COALESCE(jsonb_agg(CASE WHEN $10 THEN page.body WHEN page.item_type='FOLDER' THEN jsonb_build_object('type','FOLDER','folder',page.body) ELSE jsonb_build_object('type','ITEM','item',page.body) END ORDER BY page.updated_at DESC,page.id) FILTER(WHERE page.id IS NOT NULL),'[]'::jsonb) FROM total LEFT JOIN page ON true GROUP BY total.n`
		if e := tx.QueryRow(ctx, sql, a.OwnerID, q.ParentID, q.Recursive, q.CategoryCode, searchPattern(q.Keyword), q.Kind, q.ItemType, q.AfterTime, q.BeforeTime, q.FoldersOnly, q.Size, (q.Page-1)*q.Size, q.NodeTypes, q.NodeKind).Scan(&result.Total, &raw); e != nil {
			return domain.ErrUnavailable
		}
		if json.Unmarshal(raw, &result.Records) != nil {
			return domain.ErrUnavailable
		}
		result.Page = q.Page
		result.Current = q.Page
		result.Size = q.Size
		result.Pages = (result.Total + int64(q.Size) - 1) / int64(q.Size)
		result.HasNext = int64(q.Page) < result.Pages
		return nil
	})
	return result, e
}
func searchPattern(s string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s) + "%"
}
func node(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor, id string) (domain.Node, error) {
	var n domain.Node
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT n.id,n.name,n.kind,n.category_code,n.folder_id,n.content,n.thumbnail_asset_id,n.revision,n.created_at,n.updated_at FROM library.nodes n WHERE n.id=$1 AND n.owner_id=$2 AND n.deleted_at IS NULL AND (n.folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=n.folder_id AND f.owner_id=n.owner_id))`, id, a.OwnerID).Scan(&n.ID, &n.Name, &n.Kind, &n.CategoryCode, &n.FolderID, &raw, &n.ThumbnailAssetID, &n.Revision, &n.CreatedAt, &n.UpdatedAt)
	if errors.Is(e, pgx.ErrNoRows) {
		return n, domain.ErrNotFound
	}
	if e != nil || json.Unmarshal(raw, &n.Content) != nil {
		return n, domain.ErrUnavailable
	}
	n.ItemType = "NODE"
	refs, e := n.NodeInput.Refs()
	if e != nil {
		return n, domain.ErrUnavailable
	}
	if e = entryAssets(ctx, tx, a, refs); e != nil {
		return n, e
	}
	return n, nil
}
func (r *EntryRepository) Node(ctx context.Context, a domain.VerifiedActor, id string) (domain.Node, error) {
	var n domain.Node
	e := r.within(ctx, a, func(tx pgx.Tx, _ int64) error { var e error; n, e = node(ctx, tx, a, id); return e })
	return n, e
}
func saveNode(ctx context.Context, tx pgx.Tx, a domain.VerifiedActor, id string, i domain.NodeInput, create bool) error {
	if e := ensureFolder(ctx, tx, a, i.FolderID, i.CategoryCode); e != nil {
		return e
	}
	refs, e := i.Refs()
	if e != nil {
		return e
	}
	if e = entryAssets(ctx, tx, a, refs); e != nil {
		return e
	}
	raw, e := json.Marshal(i.Content)
	if e != nil {
		return domain.ErrInvalid
	}
	if create {
		_, e = tx.Exec(ctx, `INSERT INTO library.nodes(id,owner_id,name,kind,category_code,folder_id,content,thumbnail_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, a.OwnerID, i.Name, i.Kind, i.CategoryCode, i.FolderID, raw, i.ThumbnailAssetID)
	} else {
		_, e = tx.Exec(ctx, `UPDATE library.nodes SET name=$3,kind=$4,category_code=$5,folder_id=$6,content=$7,thumbnail_asset_id=$8,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2`, id, a.OwnerID, i.Name, i.Kind, i.CategoryCode, i.FolderID, raw, i.ThumbnailAssetID)
	}
	if e != nil {
		return domain.ErrUnavailable
	}
	if _, e = tx.Exec(ctx, "DELETE FROM library.node_asset_refs WHERE node_id=$1 AND owner_id=$2", id, a.OwnerID); e != nil {
		return domain.ErrUnavailable
	}
	for _, ref := range refs {
		if _, e = tx.Exec(ctx, "INSERT INTO library.node_asset_refs(node_id,owner_id,asset_id) VALUES($1,$2,$3)", id, a.OwnerID, ref.ID); e != nil {
			return domain.ErrUnavailable
		}
	}
	return nil
}
func (r *EntryRepository) UpdateNode(ctx context.Context, a domain.VerifiedActor, id string, i domain.NodeInput, m application.EntryMutation) (domain.Node, error) {
	var n domain.Node
	if e := i.Validate(); e != nil {
		return n, e
	}
	e := r.within(ctx, a, func(tx pgx.Tx, _ int64) error {
		old, e := node(ctx, tx, a, id)
		if e != nil {
			return e
		}
		if old.Revision != m.Expected {
			return &domain.VersionConflict{Current: old.Revision}
		}
		if e = saveNode(ctx, tx, a, id, i, false); e != nil {
			return e
		}
		if _, e = advance(ctx, tx, a); e != nil {
			return e
		}
		n, e = node(ctx, tx, a, id)
		return e
	})
	return n, e
}
func (r *EntryRepository) BatchCreate(ctx context.Context, a domain.VerifiedActor, b domain.BatchCreate, m application.EntryMutation) (domain.BatchResult, error) {
	var result domain.BatchResult
	if e := b.Validate(); e != nil {
		return result, e
	}
	if _, e := application.NormalizeKey(m.Key); e != nil {
		return result, e
	}
	e := r.within(ctx, a, func(tx pgx.Tx, revision int64) error {
		ok, e := entryReceipt(ctx, tx, a, "libraryBatchCreate", m, &result)
		if e != nil {
			return e
		}
		if ok {
			for _, n := range result.Items {
				if _, e = node(ctx, tx, a, n.ID); e != nil {
					return e
				}
			}
			return nil
		}
		if revision != b.ExpectedCollectionRevision {
			return &domain.VersionConflict{Current: revision}
		}
		result.ChangedIDs = []string{}
		result.Items = []domain.Node{}
		for _, i := range b.Items {
			id := "node_" + strings.ReplaceAll(uuid.NewString(), "-", "")
			if e = saveNode(ctx, tx, a, id, i, true); e != nil {
				return e
			}
			n, e := node(ctx, tx, a, id)
			if e != nil {
				return e
			}
			result.ChangedIDs = append(result.ChangedIDs, id)
			result.Items = append(result.Items, n)
		}
		result.Revision, e = advance(ctx, tx, a)
		if e != nil {
			return e
		}
		return entrySaveReceipt(ctx, tx, a, "libraryBatchCreate", m, result)
	})
	return result, e
}
func (r *EntryRepository) BatchMutate(ctx context.Context, a domain.VerifiedActor, b domain.BatchMutation, move bool, m application.EntryMutation) (domain.BatchResult, error) {
	var result domain.BatchResult
	if e := b.Validate(move); e != nil {
		return result, e
	}
	if _, e := application.NormalizeKey(m.Key); e != nil {
		return result, e
	}
	e := r.within(ctx, a, func(tx pgx.Tx, revision int64) error {
		op := "libraryBatchDelete"
		if move {
			op = "libraryMove"
		}
		ok, e := entryReceipt(ctx, tx, a, op, m, &result)
		if e != nil {
			return e
		}
		if ok {
			return nil
		}
		for _, id := range b.FolderIDs {
			if e = ensureFolder(ctx, tx, a, &id, ""); e != nil {
				return e
			}
		}
		nodes := []string{}
		galleries := []string{}
		for _, id := range b.ItemIDs {
			var kind string
			e = tx.QueryRow(ctx, `SELECT 'NODE' FROM library.nodes n WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND (folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=n.folder_id AND f.owner_id=n.owner_id)) UNION ALL SELECT 'GALLERY' FROM library.items i WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND (folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=i.folder_id AND f.owner_id=i.owner_id))`, id, a.OwnerID).Scan(&kind)
			if errors.Is(e, pgx.ErrNoRows) {
				return domain.ErrNotFound
			}
			if e != nil {
				return domain.ErrUnavailable
			}
			if kind == "NODE" {
				nodes = append(nodes, id)
			} else {
				galleries = append(galleries, id)
			}
		}
		folders := []string{}
		rows, e := tx.Query(ctx, `WITH RECURSIVE tree(id) AS(SELECT id FROM library.visible_folders WHERE owner_id=$1 AND id=ANY($2::text[]) UNION SELECT f.id FROM library.visible_folders f JOIN tree p ON p.id=f.parent_id WHERE f.owner_id=$1) SELECT id FROM tree ORDER BY id`, a.OwnerID, b.FolderIDs)
		if e != nil {
			return domain.ErrUnavailable
		}
		for rows.Next() {
			var id string
			if rows.Scan(&id) != nil {
				rows.Close()
				return domain.ErrUnavailable
			}
			folders = append(folders, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return domain.ErrUnavailable
		}
		if move {
			if e = ensureFolder(ctx, tx, a, b.TargetFolderID, b.TargetCategoryCode); e != nil {
				return e
			}
			if b.TargetFolderID != nil {
				for _, id := range folders {
					if id == *b.TargetFolderID {
						return domain.ErrInvalid
					}
				}
			}
		}
		if revision != b.ExpectedCollectionRevision {
			return &domain.VersionConflict{Current: revision}
		}
		if len(folders) > 0 {
			for _, table := range []string{"nodes", "items"} {
				rs, e := tx.Query(ctx, "SELECT id FROM library."+table+" WHERE owner_id=$1 AND folder_id=ANY($2::text[]) AND deleted_at IS NULL", a.OwnerID, folders)
				if e != nil {
					return domain.ErrUnavailable
				}
				for rs.Next() {
					var id string
					if rs.Scan(&id) != nil {
						rs.Close()
						return domain.ErrUnavailable
					}
					if table == "nodes" {
						nodes = append(nodes, id)
					} else {
						galleries = append(galleries, id)
					}
				}
				e = rs.Err()
				rs.Close()
				if e != nil {
					return domain.ErrUnavailable
				}
			}
		}
		nodes = uniqueIDs(nodes)
		galleries = uniqueIDs(galleries)
		result.ChangedIDs = uniqueIDs(append(append(append([]string{}, folders...), nodes...), galleries...))
		if move {
			if len(folders) > 0 {
				_, e = tx.Exec(ctx, `UPDATE library.folders SET category_code=$3,revision=revision+1,updated_at=now(),parent_id=CASE WHEN id=ANY($4::text[]) THEN $5 ELSE parent_id END WHERE owner_id=$1 AND id=ANY($2::text[])`, a.OwnerID, folders, b.TargetCategoryCode, b.FolderIDs, b.TargetFolderID)
				if e != nil {
					return domain.ErrUnavailable
				}
			}
			for _, pair := range []struct {
				table string
				ids   []string
			}{{"nodes", nodes}, {"items", galleries}} {
				if len(pair.ids) == 0 {
					continue
				}
				_, e = tx.Exec(ctx, `UPDATE library.`+pair.table+` SET category_code=$3,revision=revision+1,updated_at=now(),folder_id=CASE WHEN id=ANY($4::text[]) THEN $5 ELSE folder_id END WHERE owner_id=$1 AND id=ANY($2::text[])`, a.OwnerID, pair.ids, b.TargetCategoryCode, b.ItemIDs, b.TargetFolderID)
				if e != nil {
					return domain.ErrUnavailable
				}
			}
		} else {
			for _, pair := range []struct {
				table string
				ids   []string
			}{{"nodes", nodes}, {"items", galleries}, {"folders", folders}} {
				if len(pair.ids) == 0 {
					continue
				}
				_, e = tx.Exec(ctx, "UPDATE library."+pair.table+" SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE owner_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL", a.OwnerID, pair.ids)
				if e != nil {
					return domain.ErrUnavailable
				}
			}
		}
		result.Revision, e = advance(ctx, tx, a)
		if e != nil {
			return e
		}
		return entrySaveReceipt(ctx, tx, a, op, m, result)
	})
	return result, e
}
func uniqueIDs(ids []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	return out
}

func validNodeModel(mimeType, name string) bool {
	lower := strings.ToLower(name)
	if !(strings.HasSuffix(lower, ".glb") || strings.HasSuffix(lower, ".gltf") || strings.HasSuffix(lower, ".obj") || strings.HasSuffix(lower, ".fbx")) {
		return false
	}
	switch mimeType {
	case "model/gltf-binary", "model/gltf+json", "model/obj", "application/octet-stream", "application/x-fbx", "application/vnd.autodesk.fbx", "text/plain":
		return true
	}
	return false
}
