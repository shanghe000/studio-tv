package postgres

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"path"
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"strings"
	"unicode/utf8"
)

func studio(ctx context.Context, tx pgx.Tx, a domain.Actor, id string, lock bool) (domain.StudioProject, error) {
	var p domain.StudioProject
	sql := `SELECT s.id,s.owner_id,s.title,s.project_id,s.revision,s.created_at,s.updated_at FROM resources.studio_projects s LEFT JOIN public.projects p ON p.id=s.project_id AND p.owner_id=s.owner_id WHERE s.id=$1 AND s.owner_id=$2 AND s.deleted_at IS NULL AND (s.project_id IS NULL OR p.deleted_at IS NULL)`
	if lock {
		sql += " FOR UPDATE OF s"
	}
	e := tx.QueryRow(ctx, sql, id, a.OwnerID).Scan(&p.ID, &p.OwnerID, &p.Title, &p.ProjectID, &p.Revision, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(e, pgx.ErrNoRows) {
		return p, domain.ErrNotFound
	}
	if e != nil {
		return p, domain.ErrUnavailable
	}
	p.Files = []string{}
	rows, e := tx.Query(ctx, "SELECT path FROM resources.studio_files WHERE project_id=$1 AND owner_id=$2 ORDER BY path", id, a.OwnerID)
	if e != nil {
		return p, domain.ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) != nil {
			return p, domain.ErrUnavailable
		}
		p.Files = append(p.Files, name)
	}
	return p, unavailable(rows.Err())
}
func (r *Repository) StudioGet(ctx context.Context, a domain.Actor, id string) (domain.StudioProject, error) {
	var p domain.StudioProject
	e := r.within(ctx, func(tx pgx.Tx) error { var e error; p, e = studio(ctx, tx, a, id, false); return e })
	return p, e
}
func (r *Repository) StudioList(ctx context.Context, a domain.Actor, q domain.Query) ([]domain.StudioProject, int64, error) {
	records := []domain.StudioProject{}
	var total int64
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "studio"); e != nil {
			return e
		}
		sql := ` FROM resources.studio_projects s LEFT JOIN public.projects p ON p.id=s.project_id AND p.owner_id=s.owner_id WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND (s.project_id IS NULL OR p.deleted_at IS NULL) AND s.title ILIKE $2`
		if e := tx.QueryRow(ctx, "SELECT count(*)"+sql, a.OwnerID, like(q.Keyword)).Scan(&total); e != nil {
			return domain.ErrUnavailable
		}
		rows, e := tx.Query(ctx, `SELECT s.id,s.owner_id,s.title,s.project_id,s.revision,s.created_at,s.updated_at`+sql+` ORDER BY s.updated_at DESC,s.id LIMIT $3 OFFSET $4`, a.OwnerID, like(q.Keyword), q.Size, (q.Page-1)*q.Size)
		if e != nil {
			return domain.ErrUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			var p domain.StudioProject
			if rows.Scan(&p.ID, &p.OwnerID, &p.Title, &p.ProjectID, &p.Revision, &p.CreatedAt, &p.UpdatedAt) != nil {
				return domain.ErrUnavailable
			}
			p.Files = []string{}
			records = append(records, p)
		}
		return unavailable(rows.Err())
	})
	return records, total, e
}
func (r *Repository) StudioSave(ctx context.Context, a domain.Actor, id string, i domain.StudioInput, m application.Mutation) (domain.StudioProject, error) {
	var p domain.StudioProject
	if i.Validate() != nil {
		return p, domain.ErrInvalid
	}
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "studio"); e != nil {
			return e
		}
		op := "studioCreate"
		if id != "" {
			op = "studioUpdate:" + id
		}
		ok, e := receipt(ctx, tx, a, op, m, &p)
		if e != nil {
			return e
		}
		if ok {
			_, e = studio(ctx, tx, a, p.ID, false)
			return e
		}
		if e = activeProject(ctx, tx, a.OwnerID, i.ProjectID); e != nil {
			return e
		}
		if id == "" {
			id = i.ID
			if id == "" {
				id = "hf_" + uuid.NewString()
			}
			var exists bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM resources.studio_projects WHERE id=$1)", id).Scan(&exists); e != nil {
				return domain.ErrUnavailable
			}
			if exists {
				return domain.ErrNotFound
			}
			_, e = tx.Exec(ctx, "INSERT INTO resources.studio_projects(id,owner_id,project_id,title) VALUES($1,$2,$3,$4)", id, a.OwnerID, i.ProjectID, i.Title)
		} else {
			current, e := studio(ctx, tx, a, id, true)
			if e != nil {
				return e
			}
			if current.Revision != m.Expected {
				return &domain.VersionConflict{Current: current.Revision}
			}
			_, e = tx.Exec(ctx, "UPDATE resources.studio_projects SET title=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2", id, a.OwnerID, i.Title)
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		p, e = studio(ctx, tx, a, id, false)
		if e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, op, m, p)
	})
	return p, e
}
func (r *Repository) StudioDelete(ctx context.Context, a domain.Actor, id string, m application.Mutation) (int64, error) {
	var rev int64
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "studio"); e != nil {
			return e
		}
		p, e := studio(ctx, tx, a, id, true)
		if e != nil {
			return e
		}
		if p.Revision != m.Expected {
			return &domain.VersionConflict{Current: p.Revision}
		}
		e = tx.QueryRow(ctx, "UPDATE resources.studio_projects SET deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING revision", id, a.OwnerID).Scan(&rev)
		return unavailable(e)
	})
	return rev, e
}
func (r *Repository) File(ctx context.Context, a domain.Actor, id, name string) (domain.StudioFile, error) {
	var f domain.StudioFile
	if domain.ValidPath(name) != nil {
		return f, domain.ErrInvalid
	}
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "studio"); e != nil {
			return e
		}
		p, e := studio(ctx, tx, a, id, false)
		if e != nil {
			return e
		}
		var raw []byte
		e = tx.QueryRow(ctx, "SELECT content,mime_type FROM resources.studio_files WHERE project_id=$1 AND owner_id=$2 AND path=$3", id, a.OwnerID, name).Scan(&raw, &f.MimeType)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		f.Path = name
		f.Revision = p.Revision
		if utf8.Valid(raw) && (strings.HasPrefix(f.MimeType, "text/") || strings.Contains(f.MimeType, "json") || strings.Contains(f.MimeType, "javascript") || strings.Contains(f.MimeType, "xml")) {
			f.Content = string(raw)
			f.Encoding = "utf8"
		} else {
			f.Content = base64.StdEncoding.EncodeToString(raw)
			f.Encoding = "base64"
		}
		return nil
	})
	return f, e
}
func (r *Repository) WriteFiles(ctx context.Context, a domain.Actor, id, op string, files []domain.FileWrite, newPath string, m application.Mutation) (domain.StudioProject, error) {
	var p domain.StudioProject
	if len(files) == 0 || len(files) > 100 {
		return p, domain.ErrInvalid
	}
	seen := map[string]bool{}
	for _, f := range files {
		if domain.ValidPath(f.Path) != nil || seen[f.Path] {
			return p, domain.ErrInvalid
		}
		seen[f.Path] = true
	}
	if op == "rename" && domain.ValidPath(newPath) != nil {
		return p, domain.ErrInvalid
	}
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "studio"); e != nil {
			return e
		}
		written := []string{}
		operation := "studioFiles:" + id + ":" + op
		ok, e := receipt(ctx, tx, a, operation, m, &p)
		if e != nil {
			return e
		}
		current, e := studio(ctx, tx, a, id, true)
		if e != nil {
			return e
		}
		if ok {
			return nil
		}
		if current.Revision != m.Expected {
			return &domain.VersionConflict{Current: current.Revision}
		}
		next := current.Revision + 1
		for _, f := range files {
			var exists bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM resources.studio_files WHERE project_id=$1 AND path=$2)", id, f.Path).Scan(&exists); e != nil {
				return domain.ErrUnavailable
			}
			switch op {
			case "create", "write", "upload", "install":
				if op == "create" && exists {
					return domain.ErrConflict
				}
				raw, e := f.Input.Bytes()
				if e != nil {
					return e
				}
				_, e = tx.Exec(ctx, `INSERT INTO resources.studio_files(project_id,owner_id,path,content,mime_type,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,path) DO UPDATE SET content=EXCLUDED.content,mime_type=EXCLUDED.mime_type,revision=EXCLUDED.revision,updated_at=now()`, id, a.OwnerID, f.Path, raw, f.Input.MimeType, next)
				if e != nil {
					return domain.ErrUnavailable
				}
			case "delete":
				result, e := tx.Exec(ctx, "DELETE FROM resources.studio_files WHERE project_id=$1 AND owner_id=$2 AND (path=$3 OR left(path,length($3)+1)=$3||'/')", id, a.OwnerID, f.Path)
				if e != nil {
					return domain.ErrUnavailable
				}
				if result.RowsAffected() == 0 {
					return domain.ErrNotFound
				}

			case "rename", "duplicate":
				target := newPath
				if op == "duplicate" {
					if !exists {
						return domain.ErrNotFound
					}
					ext := path.Ext(f.Path)
					base := strings.TrimSuffix(f.Path, ext)
					target = base + "-copy-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:8] + ext
				}
				if domain.ValidPath(target) != nil || target == f.Path || strings.HasPrefix(target, f.Path+"/") {
					return domain.ErrInvalid
				}
				var targetExists bool
				if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM resources.studio_files WHERE project_id=$1 AND (path=$2 OR left(path,length($2)+1)=$2||'/'))", id, target).Scan(&targetExists); e != nil {
					return domain.ErrUnavailable
				}
				if targetExists {
					return domain.ErrConflict
				}
				if op == "rename" {
					result, e := tx.Exec(ctx, "UPDATE resources.studio_files SET path=$4||substring(path FROM length($3)+1),revision=$5,updated_at=now() WHERE project_id=$1 AND owner_id=$2 AND (path=$3 OR left(path,length($3)+1)=$3||'/')", id, a.OwnerID, f.Path, target, next)
					if e != nil {
						return domain.ErrUnavailable
					}
					if result.RowsAffected() == 0 {
						return domain.ErrNotFound
					}
				} else {
					_, e = tx.Exec(ctx, "INSERT INTO resources.studio_files(project_id,owner_id,path,content,mime_type,revision) SELECT project_id,owner_id,$4,content,mime_type,$5 FROM resources.studio_files WHERE project_id=$1 AND owner_id=$2 AND path=$3", id, a.OwnerID, f.Path, target, next)
					if e != nil {
						return domain.ErrUnavailable
					}
				}
				written = append(written, target)
				if e = studioEvent(ctx, tx, a, id, target, next); e != nil {
					return e
				}

			default:
				return domain.ErrInvalid
			}
		}
		for _, f := range files {
			if op == "write" || op == "create" || op == "upload" || op == "install" {
				written = append(written, f.Path)
			}
			if e = studioEvent(ctx, tx, a, id, f.Path, next); e != nil {
				return e
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE resources.studio_projects SET revision=$3,updated_at=now() WHERE id=$1 AND owner_id=$2", id, a.OwnerID, next); e != nil {
			return domain.ErrUnavailable
		}
		p, e = studio(ctx, tx, a, id, false)
		if e != nil {
			return e
		}
		p.WrittenPaths = written
		return saveReceipt(ctx, tx, a, operation, m, p)
	})
	return p, e
}
func (r *Repository) StudioSessions(ctx context.Context, a domain.Actor, id string) ([]json.RawMessage, error) {
	result := []json.RawMessage{}
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "studio"); e != nil {
			return e
		}
		if _, e := studio(ctx, tx, a, id, false); e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT jsonb_build_object('sessionId',c.id,'title',c.title,'updatedTime',c.updated_at,'lastTurnTime',c.updated_at) FROM resources.studio_sessions s JOIN assistant.conversations c ON c.id=s.session_id AND c.owner_id=s.owner_id WHERE s.project_id=$1 AND s.owner_id=$2 AND c.deleted_at IS NULL ORDER BY c.updated_at DESC,c.id`, id, a.OwnerID)
		if e != nil {
			return domain.ErrUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			var raw []byte
			if rows.Scan(&raw) != nil {
				return domain.ErrUnavailable
			}
			result = append(result, json.RawMessage(raw))
		}
		return unavailable(rows.Err())
	})
	return result, e
}
func (r *Repository) BindSession(ctx context.Context, a domain.Actor, id, session string, m application.Mutation) error {
	return r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, a.OwnerID, "studio"); e != nil {
			return e
		}
		var result map[string]any
		ok, e := receipt(ctx, tx, a, "studioSession:"+id, m, &result)
		if e != nil {
			return e
		}
		if _, e = studio(ctx, tx, a, id, true); e != nil {
			return e
		}
		var business string
		var hf *string
		e = tx.QueryRow(ctx, "SELECT business,hf_project_id FROM assistant.conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE", session, a.OwnerID).Scan(&business, &hf)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		if business != "HF" && business != "HYPER_FRAMES" {
			return domain.ErrInvalid
		}
		if hf != nil && *hf != id {
			return domain.ErrNotFound
		}
		if ok {
			return nil
		}
		if hf == nil {
			if _, e = tx.Exec(ctx, "UPDATE assistant.conversations SET hf_project_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND hf_project_id IS NULL", session, a.OwnerID, id); e != nil {
				return domain.ErrUnavailable
			}
		}
		_, e = tx.Exec(ctx, "INSERT INTO resources.studio_sessions(project_id,owner_id,session_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", id, a.OwnerID, session)
		if e != nil {
			return domain.ErrUnavailable
		}
		return saveReceipt(ctx, tx, a, "studioSession:"+id, m, map[string]any{"accepted": true})
	})
}

func studioEvent(ctx context.Context, tx pgx.Tx, a domain.Actor, id, name string, rev int64) error {
	_, e := tx.Exec(ctx, "INSERT INTO resources.studio_events(owner_id,project_id,path,event,revision) VALUES($1,$2,$3,'file-change',$4)", a.OwnerID, id, name, rev)
	return unavailable(e)
}
func (r *Repository) StudioEvents(ctx context.Context, a domain.Actor, after int64) ([]json.RawMessage, bool, error) {
	result := []json.RawMessage{}
	rows, e := r.pool.Query(ctx, "SELECT jsonb_build_object('seq',e.seq,'projectId',e.project_id,'path',e.path,'event',e.event,'revision',e.revision) FROM resources.studio_events e JOIN resources.studio_projects p ON p.id=e.project_id AND p.owner_id=e.owner_id WHERE e.owner_id=$1 AND e.seq>$2 AND p.deleted_at IS NULL ORDER BY e.seq LIMIT 101", a.OwnerID, after)
	if e != nil {
		return nil, false, domain.ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if rows.Scan(&raw) != nil {
			return nil, false, domain.ErrUnavailable
		}
		result = append(result, json.RawMessage(raw))
	}
	if rows.Err() != nil {
		return nil, false, domain.ErrUnavailable
	}
	more := len(result) > 100
	if more {
		result = result[:100]
	}
	return result, more, nil
}
func (r *Repository) Fonts(ctx context.Context, a domain.Actor, google bool) ([]string, error) {
	result := []string{}
	if google {
		rows, e := r.pool.Query(ctx, "SELECT key FROM resources.catalog_values WHERE namespace='STUDIO_GOOGLE_FONT' ORDER BY key")
		if e != nil {
			return nil, domain.ErrUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if rows.Scan(&name) != nil {
				return nil, domain.ErrUnavailable
			}
			result = append(result, name)
		}
		return result, unavailable(rows.Err())
	}
	rows, e := r.pool.Query(ctx, "SELECT DISTINCT f.path FROM resources.studio_files f JOIN resources.studio_projects p ON p.id=f.project_id AND p.owner_id=f.owner_id WHERE f.owner_id=$1 AND p.deleted_at IS NULL AND (f.mime_type LIKE 'font/%' OR f.path~* '\\.(woff2?|ttf|otf)$') ORDER BY f.path", a.OwnerID)
	if e != nil {
		return nil, domain.ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) != nil {
			return nil, domain.ErrUnavailable
		}
		result = append(result, name)
	}
	return result, unavailable(rows.Err())
}
