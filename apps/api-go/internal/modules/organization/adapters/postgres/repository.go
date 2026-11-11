// Package postgres provides real organization transactions using only the supplied pool.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/modules/organization/application"
	"studiotv.local/service/api/internal/modules/organization/domain"
	"time"
)

type Repository struct{ pool *pgxpool.Pool }

var _ application.Store = (*Repository)(nil)

func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("organization postgres pool required")
	}
	return &Repository{pool}, nil
}
func unavailable(e error) error {
	if e == nil {
		return nil
	}
	if errors.Is(e, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	var p *pgconn.PgError
	if errors.As(e, &p) && (p.Code == "23514" || p.Code == "23503") {
		return domain.ErrInvalid
	}
	return domain.ErrUnavailable
}
func (r *Repository) within(ctx context.Context, read bool, fn func(pgx.Tx) error) error {
	options := pgx.TxOptions{IsoLevel: pgx.ReadCommitted}
	if read {
		options = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}
	}
	tx, e := r.pool.BeginTx(ctx, options)
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
	return unavailable(tx.Commit(ctx))
}
func lock(ctx context.Context, tx pgx.Tx, a domain.Actor, scope string) error {
	if e := a.Validate(); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "organization:"+scope+":"+a.OwnerID)
	return unavailable(e)
}
func root(ctx context.Context, tx pgx.Tx, a domain.Actor) error {
	if e := lock(ctx, tx, a, "folders"); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "INSERT INTO organization.collections(owner_id) VALUES($1) ON CONFLICT DO NOTHING", a.OwnerID)
	return unavailable(e)
}
func collection(ctx context.Context, tx pgx.Tx, a domain.Actor) (int64, error) {
	var rev int64
	e := tx.QueryRow(ctx, "SELECT COALESCE((SELECT revision FROM organization.collections WHERE owner_id=$1),1)", a.OwnerID).Scan(&rev)
	return rev, unavailable(e)
}
func bump(ctx context.Context, tx pgx.Tx, a domain.Actor, ids ...*string) error {
	unique := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if id != nil && !seen[*id] {
			seen[*id] = true
			unique = append(unique, *id)
		}
	}
	if len(unique) > 0 {
		if e := lockFolders(ctx, tx, a, unique); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM organization.project_folders WHERE owner_id=$1 AND id=ANY($2::text[]) UNION SELECT f.id,f.parent_id FROM organization.project_folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.owner_id=$1) UPDATE organization.project_folders SET revision=revision+1,updated_at=now() WHERE owner_id=$1 AND deleted_at IS NULL AND id IN (SELECT id FROM ancestors)`, a.OwnerID, unique)
		if e != nil {
			return unavailable(e)
		}
	}
	_, e := tx.Exec(ctx, "UPDATE organization.collections SET revision=revision+1 WHERE owner_id=$1", a.OwnerID)
	return unavailable(e)
}

// Core project/asset transactions invalidate ancestor revisions in id order.
// Organization writers take those same row locks before mutation or revision
// comparison, without requiring a core transaction to take the owner mutex.
func lockFolders(ctx context.Context, tx pgx.Tx, a domain.Actor, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	rows, e := tx.Query(ctx, `WITH RECURSIVE ancestors(id,parent_id) AS(SELECT id,parent_id FROM organization.project_folders WHERE owner_id=$1 AND id=ANY($2::text[]) UNION SELECT f.id,f.parent_id FROM organization.project_folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.owner_id=$1) SELECT f.id FROM organization.project_folders f WHERE f.owner_id=$1 AND f.id IN(SELECT id FROM ancestors) ORDER BY f.id FOR UPDATE OF f`, a.OwnerID, ids)
	if e != nil {
		return unavailable(e)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil {
			return domain.ErrUnavailable
		}
	}
	return unavailable(rows.Err())
}
func receipt(ctx context.Context, tx pgx.Tx, a domain.Actor, op string, m application.Mutation, out any) (bool, error) {
	if application.Key(m.Key) != nil || len(m.Hash) != 64 {
		return false, domain.ErrInvalid
	}
	var hash string
	var raw []byte
	e := tx.QueryRow(ctx, "SELECT request_hash,response_body FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3", a.OwnerID, "organization:"+op, m.Key).Scan(&hash, &raw)
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
func saveReceipt(ctx context.Context, tx pgx.Tx, a domain.Actor, op string, m application.Mutation, status int, out any) error {
	raw, e := json.Marshal(out)
	if e != nil {
		return domain.ErrUnavailable
	}
	_, e = tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,$5,$6)", a.OwnerID, "organization:"+op, m.Key, m.Hash, status, raw)
	return unavailable(e)
}

const projectSize = `(octet_length(p.graph::text)::bigint+COALESCE((SELECT sum(a.byte_size) FROM public.assets a WHERE a.project_id=p.id AND a.owner_id=p.owner_id AND a.state='READY' AND a.deleted_at IS NULL),0))`
const folderSize = `(WITH RECURSIVE children(id) AS(SELECT f.id UNION ALL SELECT c.id FROM organization.visible_folders c JOIN children p ON c.parent_id=p.id WHERE c.owner_id=f.owner_id) SELECT COALESCE(sum(` + projectSize + `),0)::bigint FROM public.projects p JOIN organization.project_memberships m ON m.project_id=p.id AND m.owner_id=p.owner_id WHERE p.owner_id=f.owner_id AND p.deleted_at IS NULL AND p.internal_kind IS NULL AND m.folder_id IN(SELECT id FROM children))`
const folderFields = `f.id,f.parent_id,f.name,f.revision,f.level,f.created_at,f.updated_at,
 (SELECT count(*) FROM organization.visible_folders c WHERE c.owner_id=f.owner_id AND c.parent_id=f.id)+(SELECT count(*) FROM public.projects p JOIN organization.project_memberships m ON m.project_id=p.id AND m.owner_id=p.owner_id WHERE p.owner_id=f.owner_id AND p.deleted_at IS NULL AND p.internal_kind IS NULL AND m.folder_id=f.id),
 (WITH RECURSIVE children(id) AS(SELECT f.id UNION ALL SELECT c.id FROM organization.visible_folders c JOIN children p ON c.parent_id=p.id WHERE c.owner_id=f.owner_id) SELECT count(*) FROM public.projects p JOIN organization.project_memberships m ON m.project_id=p.id AND m.owner_id=p.owner_id WHERE p.owner_id=f.owner_id AND p.deleted_at IS NULL AND p.internal_kind IS NULL AND m.folder_id IN(SELECT id FROM children)),` + folderSize + ` AS byte_size`

func scanFolder(row pgx.Row) (domain.Folder, error) {
	var f domain.Folder
	e := row.Scan(&f.ID, &f.ParentID, &f.Name, &f.Revision, &f.Level, &f.CreatedAt, &f.UpdatedAt, &f.ItemCount, &f.Total, &f.ByteSize)
	f.MaxLevel = domain.MaxLevel
	f.AllowCreateSubFolder = f.Level < domain.MaxLevel
	f.CreatedAt, f.UpdatedAt = f.CreatedAt.UTC(), f.UpdatedAt.UTC()
	return f, unavailable(e)
}
func folder(ctx context.Context, tx pgx.Tx, a domain.Actor, id string) (domain.Folder, error) {
	return scanFolder(tx.QueryRow(ctx, "SELECT "+folderFields+" FROM organization.visible_folders f WHERE f.id=$1 AND f.owner_id=$2", id, a.OwnerID))
}
func (r *Repository) Folder(ctx context.Context, a domain.Actor, id string) (domain.Folder, error) {
	var f domain.Folder
	e := r.within(ctx, true, func(tx pgx.Tx) error { var e error; f, e = folder(ctx, tx, a, id); return e })
	return f, e
}
func (r *Repository) CreateFolder(ctx context.Context, a domain.Actor, i domain.FolderInput, m application.Mutation) (domain.Folder, error) {
	var f domain.Folder
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := root(ctx, tx, a); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "folder:create", m, &f)
		if e != nil {
			return e
		}
		if replayed {
			_, e = folder(ctx, tx, a, f.ID)
			return e
		}
		if i.ParentID != nil {
			p, e := folder(ctx, tx, a, *i.ParentID)
			if e != nil {
				return e
			}
			if !p.AllowCreateSubFolder {
				return domain.ErrInvalid
			}
		}
		id := "pfolder_" + uuid.NewString()
		_, e = tx.Exec(ctx, "INSERT INTO organization.project_folders(id,owner_id,parent_id,name) VALUES($1,$2,$3,$4)", id, a.OwnerID, i.ParentID, i.Name)
		if e != nil {
			return unavailable(e)
		}
		if e = bump(ctx, tx, a, i.ParentID); e != nil {
			return e
		}
		f, e = folder(ctx, tx, a, id)
		if e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, "folder:create", m, 201, f)
	})
	return f, e
}
func (r *Repository) RenameFolder(ctx context.Context, a domain.Actor, id, name string, m application.Mutation) (domain.Folder, error) {
	var f domain.Folder
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := root(ctx, tx, a); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "folder:rename:"+id, m, &f)
		if e != nil || replayed {
			return e
		}
		if e = lockFolders(ctx, tx, a, []string{id}); e != nil {
			return e
		}
		prior, e := folder(ctx, tx, a, id)
		if e != nil {
			return e
		}
		if prior.Revision != m.Expected {
			return &domain.VersionConflict{Current: prior.Revision}
		}
		_, e = tx.Exec(ctx, "UPDATE organization.project_folders SET name=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2", id, a.OwnerID, name)
		if e != nil {
			return unavailable(e)
		}
		if e = bump(ctx, tx, a, prior.ParentID); e != nil {
			return e
		}
		f, e = folder(ctx, tx, a, id)
		if e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, "folder:rename:"+id, m, 200, f)
	})
	return f, e
}
func (r *Repository) DeleteFolder(ctx context.Context, a domain.Actor, id string, m application.Mutation) (domain.Deletion, error) {
	var v domain.Deletion
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := root(ctx, tx, a); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "folder:delete:"+id, m, &v)
		if e != nil || replayed {
			return e
		}
		f, e := folder(ctx, tx, a, id)
		if e != nil {
			return e
		}
		if f.Revision != m.Expected {
			return &domain.VersionConflict{Current: f.Revision}
		}
		v = domain.Deletion{ID: id, Revision: f.Revision + 1, DeletedFolderIDs: []string{}, DeletedProjectIDs: []string{}}
		if e = tx.QueryRow(ctx, "SELECT now()").Scan(&v.DeletedAt); e != nil {
			return unavailable(e)
		}
		rows, e := tx.Query(ctx, `WITH RECURSIVE children(id) AS(SELECT id FROM organization.visible_folders WHERE id=$1 AND owner_id=$2 UNION ALL SELECT f.id FROM organization.visible_folders f JOIN children p ON f.parent_id=p.id WHERE f.owner_id=$2) SELECT id FROM children ORDER BY id`, id, a.OwnerID)
		if e != nil {
			return unavailable(e)
		}
		for rows.Next() {
			var child string
			if e = rows.Scan(&child); e != nil {
				rows.Close()
				return unavailable(e)
			}
			v.DeletedFolderIDs = append(v.DeletedFolderIDs, child)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return unavailable(e)
		}
		rows, e = tx.Query(ctx, `SELECT p.id FROM public.projects p JOIN organization.project_memberships m ON m.project_id=p.id AND m.owner_id=p.owner_id WHERE p.owner_id=$1 AND p.deleted_at IS NULL AND p.internal_kind IS NULL AND m.folder_id=ANY($2::text[]) ORDER BY p.id FOR UPDATE OF p`, a.OwnerID, v.DeletedFolderIDs)
		if e != nil {
			return unavailable(e)
		}
		for rows.Next() {
			var project string
			if e = rows.Scan(&project); e != nil {
				rows.Close()
				return unavailable(e)
			}
			v.DeletedProjectIDs = append(v.DeletedProjectIDs, project)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return unavailable(e)
		}
		if e = lockFolders(ctx, tx, a, v.DeletedFolderIDs); e != nil {
			return e
		}
		f, e = folder(ctx, tx, a, id)
		if e != nil {
			return e
		}
		if f.Revision != m.Expected {
			return &domain.VersionConflict{Current: f.Revision}
		}
		if len(v.DeletedProjectIDs) > 0 {
			_, e = tx.Exec(ctx, "UPDATE public.projects SET deleted_at=$3,updated_at=$3,revision=revision+1 WHERE owner_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL AND internal_kind IS NULL", a.OwnerID, v.DeletedProjectIDs, v.DeletedAt)
			if e != nil {
				return unavailable(e)
			}
		}
		_, e = tx.Exec(ctx, "UPDATE organization.project_folders SET deleted_at=$3,updated_at=$3,revision=revision+1 WHERE owner_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL", a.OwnerID, v.DeletedFolderIDs, v.DeletedAt)
		if e != nil {
			return unavailable(e)
		}
		if e = tx.QueryRow(ctx, "SELECT revision FROM organization.project_folders WHERE id=$1 AND owner_id=$2", id, a.OwnerID).Scan(&v.Revision); e != nil {
			return unavailable(e)
		}
		if e = bump(ctx, tx, a, f.ParentID); e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, "folder:delete:"+id, m, 200, v)
	})
	return v, e
}
func search(s string) any {
	if s == "" {
		return nil
	}
	return "%" + escapeLike(s) + "%"
}
func escapeLike(s string) string {
	out := ""
	for _, r := range s {
		if r == '%' || r == '_' || r == '\\' {
			out += "\\"
		}
		out += string(r)
	}
	return out
}
func sortBy(s string) string {
	switch s {
	case "SIZE_ASC":
		return "byte_size ASC"
	case "SIZE_DESC":
		return "byte_size DESC"
	case "UPDATED_ASC":
		return "updated_at ASC"
	case "CREATED_DESC":
		return "created_at DESC"
	case "CREATED_ASC":
		return "created_at ASC"
	case "NAME_ASC":
		return "name COLLATE \"C\" ASC"
	case "NAME_DESC":
		return "name COLLATE \"C\" DESC"
	}
	return "updated_at DESC"
}
func (r *Repository) Folders(ctx context.Context, a domain.Actor, q domain.Query) (domain.Page, error) {
	var v domain.Page
	e := r.within(ctx, true, func(tx pgx.Tx) error {
		if q.ParentID != nil {
			if _, e := folder(ctx, tx, a, *q.ParentID); e != nil {
				return e
			}
		}
		var total int64
		e := tx.QueryRow(ctx, `SELECT count(*) FROM organization.visible_folders f WHERE owner_id=$1 AND parent_id IS NOT DISTINCT FROM $2::text AND ($3::text IS NULL OR name ILIKE $3)`, a.OwnerID, q.ParentID, search(q.Keyword)).Scan(&total)
		if e != nil {
			return unavailable(e)
		}
		rows, e := tx.Query(ctx, "SELECT "+folderFields+" FROM organization.visible_folders f WHERE owner_id=$1 AND parent_id IS NOT DISTINCT FROM $2::text AND ($3::text IS NULL OR name ILIKE $3) ORDER BY "+sortBy(q.Sort)+",id LIMIT $4 OFFSET $5", a.OwnerID, q.ParentID, search(q.Keyword), q.Size, q.Offset())
		if e != nil {
			return unavailable(e)
		}
		records := []domain.Entry{}
		for rows.Next() {
			f, e := scanFolder(rows)
			if e != nil {
				rows.Close()
				return e
			}
			records = append(records, domain.Entry{Type: "FOLDER", Folder: &f})
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return unavailable(e)
		}
		rev, e := collection(ctx, tx, a)
		if e != nil {
			return e
		}
		v = domain.NewPage(q, records, total, rev)
		return nil
	})
	return v, e
}

const projectFields = "p.id,p.owner_id,p.name,p.cover_asset_id,p.pinned,p.revision,p.created_at,p.updated_at"

func scanProject(row pgx.Row) (domain.Project, error) {
	var p domain.Project
	e := row.Scan(&p.ID, &p.OwnerID, &p.Name, &p.CoverAssetID, &p.Pinned, &p.Revision, &p.CreatedAt, &p.UpdatedAt)
	p.CreatedAt, p.UpdatedAt = p.CreatedAt.UTC(), p.UpdatedAt.UTC()
	return p, unavailable(e)
}
func project(ctx context.Context, tx pgx.Tx, a domain.Actor, id string, write bool) (domain.Project, error) {
	suffix := ""
	if write {
		suffix = " FOR UPDATE"
	}
	return scanProject(tx.QueryRow(ctx, "SELECT "+projectFields+" FROM public.projects p WHERE p.id=$1 AND p.owner_id=$2 AND p.deleted_at IS NULL AND p.internal_kind IS NULL"+suffix, id, a.OwnerID))
}
func membership(ctx context.Context, tx pgx.Tx, a domain.Actor, p domain.Project) (domain.Membership, error) {
	v := domain.Membership{ProjectID: p.ID, Revision: p.Revision}
	e := tx.QueryRow(ctx, "SELECT folder_id FROM organization.project_memberships WHERE project_id=$1 AND owner_id=$2", p.ID, a.OwnerID).Scan(&v.FolderID)
	if errors.Is(e, pgx.ErrNoRows) {
		return v, nil
	}
	if e != nil {
		return v, unavailable(e)
	}
	if _, e = folder(ctx, tx, a, *v.FolderID); e != nil {
		return v, e
	}
	return v, nil
}
func (r *Repository) Membership(ctx context.Context, a domain.Actor, id string) (domain.Membership, error) {
	var v domain.Membership
	e := r.within(ctx, true, func(tx pgx.Tx) error {
		p, e := project(ctx, tx, a, id, false)
		if e != nil {
			return e
		}
		v, e = membership(ctx, tx, a, p)
		return e
	})
	return v, e
}
func equal(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func (r *Repository) Move(ctx context.Context, a domain.Actor, id string, target *string, m application.Mutation) (domain.Membership, error) {
	var v domain.Membership
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := root(ctx, tx, a); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "project:move:"+id, m, &v)
		if e != nil || replayed {
			return e
		}
		p, e := project(ctx, tx, a, id, true)
		if e != nil {
			return e
		}
		if p.Revision != m.Expected {
			return &domain.VersionConflict{Current: p.Revision}
		}
		prior, e := membership(ctx, tx, a, p)
		if e != nil {
			return e
		}
		if target != nil {
			if _, e = folder(ctx, tx, a, *target); e != nil {
				return e
			}
		}
		affected := []string{}
		if prior.FolderID != nil {
			affected = append(affected, *prior.FolderID)
		}
		if target != nil {
			affected = append(affected, *target)
		}
		if e = lockFolders(ctx, tx, a, affected); e != nil {
			return e
		}
		v = prior
		if !equal(prior.FolderID, target) {
			if target == nil {
				_, e = tx.Exec(ctx, "DELETE FROM organization.project_memberships WHERE project_id=$1 AND owner_id=$2", id, a.OwnerID)
			} else {
				_, e = tx.Exec(ctx, "INSERT INTO organization.project_memberships(project_id,owner_id,folder_id) VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET folder_id=EXCLUDED.folder_id,updated_at=now()", id, a.OwnerID, *target)
			}
			if e != nil {
				return unavailable(e)
			}
			e = tx.QueryRow(ctx, "UPDATE public.projects SET revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING revision", id, a.OwnerID).Scan(&v.Revision)
			if e != nil {
				return unavailable(e)
			}
			v.FolderID = target
			if e = bump(ctx, tx, a, prior.FolderID, target); e != nil {
				return e
			}
		}
		return saveReceipt(ctx, tx, a, "project:move:"+id, m, 200, v)
	})
	return v, e
}
func (r *Repository) CreateProject(ctx context.Context, a domain.Actor, name string, target *string, m application.Mutation) (domain.Project, error) {
	var v domain.Project
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := root(ctx, tx, a); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "project:create", m, &v)
		if e != nil {
			return e
		}
		if replayed {
			_, e = project(ctx, tx, a, v.ID, false)
			return e
		}
		if target != nil {
			if _, e = folder(ctx, tx, a, *target); e != nil {
				return e
			}
			if e = lockFolders(ctx, tx, a, []string{*target}); e != nil {
				return e
			}
		}
		id := "prj_" + uuid.NewString()
		v, e = scanProject(tx.QueryRow(ctx, "INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,$3) RETURNING id,owner_id,name,cover_asset_id,pinned,revision,created_at,updated_at", id, a.OwnerID, name))
		if e != nil {
			return e
		}
		if target != nil {
			_, e = tx.Exec(ctx, "INSERT INTO organization.project_memberships(project_id,owner_id,folder_id) VALUES($1,$2,$3)", id, a.OwnerID, *target)
			if e != nil {
				return unavailable(e)
			}
		}
		if e = bump(ctx, tx, a, target); e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, "project:create", m, 201, v)
	})
	return v, e
}
