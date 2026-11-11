// Package postgres implements real transactional resource persistence. No default DSN or environment access.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"math/big"
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"strings"
	"time"
)

type Repository struct{ pool *pgxpool.Pool }

var _ application.Store = (*Repository)(nil)

func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("resource postgres pool is required")
	}
	return &Repository{pool}, nil
}
func (r *Repository) within(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, e := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if e != nil {
		return domain.ErrUnavailable
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(c)
	}()
	if e = fn(tx); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return domain.ErrUnavailable
	}
	return nil
}
func unavailable(e error) error {
	if e != nil {
		return domain.ErrUnavailable
	}
	return nil
}
func lockOwner(ctx context.Context, tx pgx.Tx, owner, scope string) error {
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner+":"+scope)
	return unavailable(e)
}
func receipt(ctx context.Context, tx pgx.Tx, a domain.Actor, op string, m application.Mutation, out any) (bool, error) {
	if m.Key == "" {
		return false, nil
	}
	if application.Key(m.Key) != nil {
		return false, domain.ErrInvalid
	}
	if e := lockOwner(ctx, tx, a.OwnerID, op+":"+m.Key); e != nil {
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
		return false, domain.ErrConflict
	}
	if json.Unmarshal(raw, out) != nil {
		return false, domain.ErrUnavailable
	}
	return true, nil
}
func saveReceipt(ctx context.Context, tx pgx.Tx, a domain.Actor, op string, m application.Mutation, out any) error {
	if m.Key == "" {
		return nil
	}
	raw, e := json.Marshal(out)
	if e != nil {
		return domain.ErrUnavailable
	}
	_, e = tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,200,$5)", a.OwnerID, op, m.Key, m.Hash, raw)
	return unavailable(e)
}
func readyAssets(ctx context.Context, tx pgx.Tx, owner string, refs []domain.AssetRef) error {
	for _, ref := range refs {
		var kind, mimeType, fileName string
		e := tx.QueryRow(ctx, `SELECT a.kind,a.mime_type,a.file_name FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=$1 AND a.owner_id=$2 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL FOR SHARE OF a,p`, ref.ID, owner).Scan(&kind, &mimeType, &fileName)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		if ref.Kind != "" && ref.Kind != kind && !(ref.Kind == "MODEL" && kind == "FILE" && validModelFile(mimeType, fileName)) {
			return domain.ErrNotFound
		}
	}
	return nil
}
func activeProject(ctx context.Context, tx pgx.Tx, owner string, id *string) error {
	if id == nil {
		return nil
	}
	var got string
	e := tx.QueryRow(ctx, "SELECT id FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR SHARE", *id, owner).Scan(&got)
	if errors.Is(e, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	return unavailable(e)
}

const columns = `i.id,i.family,i.owner_id,i.scope,i.name,i.description,i.content,i.category_ids,i.cover_asset_id,i.cover_url,i.revision,i.version,i.created_at,i.updated_at,COALESCE(f.favorited,false)`

func scanResource(row pgx.Row) (domain.Resource, error) {
	var v domain.Resource
	e := row.Scan(&v.ID, &v.Family, &v.OwnerID, &v.Scope, &v.Name, &v.Description, &v.Content, &v.CategoryIDs, &v.CoverAssetID, &v.CoverURL, &v.Revision, &v.Version, &v.CreatedAt, &v.UpdatedAt, &v.Favorited)
	if errors.Is(e, pgx.ErrNoRows) {
		return v, domain.ErrNotFound
	}
	return v, unavailable(e)
}
func get(ctx context.Context, tx pgx.Tx, a domain.Actor, family domain.Family, id string, lock bool) (domain.Resource, error) {
	sql := `SELECT ` + columns + ` FROM resources.items i LEFT JOIN resources.favorites f ON f.resource_id=i.id AND f.owner_id=$1 WHERE i.id=$2 AND i.family=$3 AND i.deleted_at IS NULL AND (i.owner_id=$1 OR i.scope='SYSTEM')`
	if !lock {
		sql += ` AND NOT EXISTS(SELECT 1 FROM resources.asset_refs ar LEFT JOIN public.assets a ON a.id=ar.asset_id AND a.owner_id=ar.owner_id LEFT JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE ar.resource_id=i.id AND (a.id IS NULL OR a.state<>'READY' OR a.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL))`
	}
	if lock {
		sql += ` FOR UPDATE OF i`
	}
	return scanResource(tx.QueryRow(ctx, sql, a.OwnerID, id, family))
}
func (r *Repository) Get(ctx context.Context, a domain.Actor, f domain.Family, id string) (domain.Resource, error) {
	var v domain.Resource
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		var e error
		v, e = get(ctx, tx, a, f, id, false)
		return e
	})
	return v, e
}
func like(s string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s) + "%"
}
func (r *Repository) List(ctx context.Context, a domain.Actor, f domain.Family, q domain.Query) (domain.Page, error) {
	var p domain.Page
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		var e error
		p, e = list(ctx, tx, a, string(f), q)
		return e
	})
	return p, e
}
func list(ctx context.Context, tx pgx.Tx, a domain.Actor, f string, q domain.Query) (domain.Page, error) {
	if q.CategoryIDs == nil {
		q.CategoryIDs = []string{}
	}
	if q.SceneIDs == nil {
		q.SceneIDs = []string{}
	}
	if q.Keys == nil {
		q.Keys = []string{}
	}
	scope := q.Scope
	if scope == "COMMON" {
		scope = "SYSTEM"
	}
	filters, _ := json.Marshal(q.Filters)
	fields, _ := json.Marshal(q.Fields)
	if string(fields) == "null" {
		fields = []byte("{}")
	}
	if string(filters) == "null" {
		filters = []byte("[]")
	}
	args := []any{a.OwnerID, f, scope, like(q.Keyword), q.CategoryIDs, q.FavoriteOnly, q.RecentOnly, filters, fields, q.SceneIDs, q.Keys, q.Size, int64(q.Page-1) * int64(q.Size)}
	predicate := `NOT EXISTS(SELECT 1 FROM resources.asset_refs ar LEFT JOIN public.assets a ON a.id=ar.asset_id AND a.owner_id=ar.owner_id LEFT JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE ar.resource_id=i.id AND (a.id IS NULL OR a.state<>'READY' OR a.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL)) AND i.family=$2 AND i.deleted_at IS NULL AND (i.owner_id=$1 OR i.scope='SYSTEM') AND ($3='' OR i.scope=$3) AND (i.name ILIKE $4 OR i.description ILIKE $4) AND (cardinality($5::text[])=0 OR i.category_ids && $5 OR (i.scope='SYSTEM' AND i.family='PROMPT' AND i.source_version IN ('studio-style-library-1','studio-image-recipes-1') AND EXISTS(SELECT 1 FROM resources.categories pc WHERE pc.namespace='PROMPT' AND pc.id=ANY($5) AND pc.source_version='studio-image-preset-categories-1' AND pc.content->'resourceIds' ? i.id))) AND (NOT $6 OR COALESCE(f.favorited,false)) AND (NOT $7 OR EXISTS(SELECT 1 FROM resources.usage_records u WHERE u.resource_id=i.id AND u.owner_id=$1)) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($8::jsonb) fl WHERE NOT COALESCE(i.content->'attributes'->(fl->>'categoryCode')->>'optionCode'=ANY(ARRAY(SELECT jsonb_array_elements_text(fl->'optionCodes'))),false)) AND NOT EXISTS(SELECT 1 FROM jsonb_each_text($9::jsonb) x WHERE x.value<>'' AND x.key NOT IN('sort','days','recommended','type','category') AND NOT COALESCE(i.content->>x.key=x.value,false)) AND (NOT ($9::jsonb ? 'type') OR $9::jsonb->>'type' IN('','COMMON','USER') OR i.content->>'type'=$9::jsonb->>'type') AND (NOT ($9::jsonb ? 'category') OR $9::jsonb->>'category'='' OR i.content->>'category'=$9::jsonb->>'category') AND (NOT ($9::jsonb ? 'recommended') OR $9::jsonb->>'recommended'<>'true' OR COALESCE((i.content->>'isRecommend')::boolean,(i.content->>'recommended')::boolean,false)) AND (cardinality($10::text[])=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(i.content->'sceneIdList','[]')) s WHERE s=ANY($10))) AND (cardinality($11::text[])=0 OR i.content->>'key'=ANY($11)) AND (NOT ($9::jsonb ? 'days') OR i.created_at>=now()-make_interval(days=>($9::jsonb->>'days')::integer))`
	from := ` FROM resources.items i LEFT JOIN resources.favorites f ON f.resource_id=i.id AND f.owner_id=$1 WHERE ` + predicate
	var total int64
	if e := tx.QueryRow(ctx, `SELECT count(*)`+from, args[:11]...).Scan(&total); e != nil {
		return domain.Page{}, domain.ErrUnavailable
	}
	// Only actual stored catalog ordering/count fields participate; imported vendor popularity is never a local execution counter.
	order := `i.updated_at DESC,i.id`
	if q.RecentOnly {
		order = `(SELECT max(u.created_at) FROM resources.usage_records u WHERE u.owner_id=$1 AND u.resource_id=i.id) DESC,i.id`
	}
	switch q.Fields["sort"] {
	case "HOTTEST":
		order = `(SELECT count(*) FROM resources.usage_records u WHERE u.resource_id=i.id) DESC,(CASE WHEN COALESCE(i.content->'statisticsInfo'->>'useCount',i.content->>'useCount','')~'^[0-9]{1,18}$' THEN COALESCE(i.content->'statisticsInfo'->>'useCount',i.content->>'useCount')::numeric ELSE 0 END) DESC,i.updated_at DESC,i.id`
	case "REPUTATION":
		order = `(SELECT count(*) FROM resources.favorites rf WHERE rf.resource_id=i.id AND rf.favorited) DESC,(CASE WHEN COALESCE(i.content->'statisticsInfo'->>'likeCount','')~'^[0-9]{1,18}$' THEN (i.content->'statisticsInfo'->>'likeCount')::numeric ELSE 0 END) DESC,i.updated_at DESC,i.id`
	case "RECOMMEND":
		order = `CASE WHEN i.content->>'carefullyChosen'='true' OR i.content->>'isRecommend'='true' OR i.content->>'recommended'='true' THEN 0 ELSE 1 END,CASE WHEN COALESCE(i.content->>'seq','')~'^[0-9]{1,18}$' THEN (i.content->>'seq')::numeric ELSE 0 END,i.updated_at DESC,i.id`
	case "NEWEST":
		order = `i.created_at DESC,i.id`
	}
	rows, e := tx.Query(ctx, `SELECT `+columns+from+` ORDER BY `+order+` LIMIT $12 OFFSET $13`, args...)
	if e != nil {
		return domain.Page{}, domain.ErrUnavailable
	}
	defer rows.Close()
	records := []domain.Resource{}
	for rows.Next() {
		v, e := scanResource(rows)
		if e != nil {
			return domain.Page{}, e
		}
		records = append(records, v)
	}
	if e = rows.Err(); e != nil {
		return domain.Page{}, domain.ErrUnavailable
	}
	return domain.NewPage(q, records, total), nil
}
func (r *Repository) Save(ctx context.Context, a domain.Actor, f domain.Family, id string, i domain.Input, m application.Mutation) (domain.Resource, error) {
	var result domain.Resource
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		op := "resourceCreate:" + string(f)
		if id != "" {
			op = "resourceUpdate:" + id
		}
		ok, e := receipt(ctx, tx, a, op, m, &result)
		if e != nil {
			return e
		}
		if ok {
			_, e = get(ctx, tx, a, f, result.ID, false)
			return e
		}
		if e = lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		refs, e := i.AssetRefs(f)
		if e != nil {
			return e
		}
		if e = readyAssets(ctx, tx, a.OwnerID, refs); e != nil {
			return e
		}
		if id == "" {
			id = "res_" + strings.ReplaceAll(uuid.NewString(), "-", "")
			if f == domain.Skill {
				v := uuid.New()
				id = new(big.Int).SetBytes(v[:]).String()
			}
			_, e = tx.Exec(ctx, `INSERT INTO resources.items(id,family,owner_id,scope,name,description,content,category_ids,cover_asset_id) VALUES($1,$2,$3,'USER',$4,$5,$6,$7,$8)`, id, f, a.OwnerID, i.Name, i.Description, i.Content, i.CategoryIDs, i.CoverAssetID)
		} else {
			g, e := get(ctx, tx, a, f, id, true)
			if e != nil {
				return e
			}
			if g.OwnerID == nil || *g.OwnerID != a.OwnerID {
				return domain.ErrNotFound
			}
			if g.Revision != m.Expected {
				return &domain.VersionConflict{Current: g.Revision}
			}
			_, e = tx.Exec(ctx, `UPDATE resources.items SET name=$3,description=$4,content=$5,category_ids=$6,cover_asset_id=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2`, id, a.OwnerID, i.Name, i.Description, i.Content, i.CategoryIDs, i.CoverAssetID)
			if e != nil {
				return domain.ErrUnavailable
			}
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		if _, e = tx.Exec(ctx, "DELETE FROM resources.asset_refs WHERE resource_id=$1", id); e != nil {
			return domain.ErrUnavailable
		}
		for _, ref := range refs {
			if _, e = tx.Exec(ctx, "INSERT INTO resources.asset_refs(resource_id,owner_id,asset_id) VALUES($1,$2,$3)", id, a.OwnerID, ref.ID); e != nil {
				return domain.ErrUnavailable
			}
		}
		result, e = get(ctx, tx, a, f, id, false)
		if e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, op, m, result)
	})
	return result, e
}
func (r *Repository) Delete(ctx context.Context, a domain.Actor, f domain.Family, id string, m application.Mutation) (int64, error) {
	var rev int64
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		v, e := get(ctx, tx, a, f, id, true)
		if e != nil {
			return e
		}
		if v.OwnerID == nil || *v.OwnerID != a.OwnerID {
			return domain.ErrNotFound
		}
		if v.Revision != m.Expected {
			return &domain.VersionConflict{Current: v.Revision}
		}
		e = tx.QueryRow(ctx, "UPDATE resources.items SET revision=revision+1,deleted_at=now(),updated_at=now() WHERE id=$1 RETURNING revision", id).Scan(&rev)
		return unavailable(e)
	})
	return rev, e
}
func (r *Repository) Favorite(ctx context.Context, a domain.Actor, f domain.Family, id string, value bool, m application.Mutation) (domain.Resource, error) {
	var result domain.Resource
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		v, e := get(ctx, tx, a, f, id, true)
		if e != nil {
			return e
		}
		if v.Revision != m.Expected {
			return &domain.VersionConflict{Current: v.Revision}
		}
		_, e = tx.Exec(ctx, `INSERT INTO resources.favorites(owner_id,resource_id,favorited) VALUES($1,$2,$3) ON CONFLICT(owner_id,resource_id) DO UPDATE SET favorited=EXCLUDED.favorited,revision=resources.favorites.revision+1,updated_at=now()`, a.OwnerID, id, value)
		if e != nil {
			return domain.ErrUnavailable
		}
		refs, e := v.Input.AssetRefs(f)
		if e != nil {
			return e
		}
		if v.OwnerID != nil {
			if e = readyAssets(ctx, tx, a.OwnerID, refs); e != nil {
				return e
			}
		}
		v.Favorited = value
		result = v
		return nil
	})
	return result, e
}
func (r *Repository) Use(ctx context.Context, a domain.Actor, f domain.Family, id string, project, node *string, m application.Mutation) (domain.Usage, error) {
	var result domain.Usage
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		op := "resourceUse:" + id
		ok, e := receipt(ctx, tx, a, op, m, &result)
		if e != nil {
			return e
		}
		if _, e = get(ctx, tx, a, f, id, true); e != nil {
			return e
		}
		if e = activeProject(ctx, tx, a.OwnerID, project); e != nil {
			return e
		}
		if ok {
			return nil
		}
		result = domain.Usage{ID: "use_" + uuid.NewString(), ResourceID: id, ProjectID: project, NodeID: node}
		e = tx.QueryRow(ctx, `INSERT INTO resources.usage_records(id,owner_id,resource_id,project_id,node_id) VALUES($1,$2,$3,$4,$5) RETURNING created_at`, result.ID, a.OwnerID, id, project, node).Scan(&result.CreatedAt)
		if e != nil {
			return domain.ErrUnavailable
		}
		return saveReceipt(ctx, tx, a, op, m, result)
	})
	return result, e
}
func (r *Repository) History(ctx context.Context, a domain.Actor, id string, q domain.Query) ([]domain.Usage, int64, error) {
	records := []domain.Usage{}
	var total int64
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "resources"); e != nil {
			return e
		}
		if _, e := get(ctx, tx, a, domain.App, id, false); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "SELECT count(*) FROM resources.usage_records WHERE owner_id=$1 AND resource_id=$2", a.OwnerID, id).Scan(&total); e != nil {
			return domain.ErrUnavailable
		}
		rows, e := tx.Query(ctx, "SELECT id,resource_id,project_id,node_id,created_at FROM resources.usage_records WHERE owner_id=$1 AND resource_id=$2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4", a.OwnerID, id, q.Size, (q.Page-1)*q.Size)
		if e != nil {
			return domain.ErrUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			var v domain.Usage
			if rows.Scan(&v.ID, &v.ResourceID, &v.ProjectID, &v.NodeID, &v.CreatedAt) != nil {
				return domain.ErrUnavailable
			}
			records = append(records, v)
		}
		return unavailable(rows.Err())
	})
	return records, total, e
}

func validModelFile(mimeType, name string) bool {
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
