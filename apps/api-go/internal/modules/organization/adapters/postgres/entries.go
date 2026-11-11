package postgres

import (
	"context"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/organization/domain"
)

const entryFilter = `WITH filtered AS MATERIALIZED (
 SELECT f.id,'FOLDER'::text type,f.name,f.created_at,f.updated_at,false pinned,` + folderSize + ` byte_size FROM organization.visible_folders f WHERE f.owner_id=$1 AND $3<>'CANVAS' AND f.parent_id IS NOT DISTINCT FROM $2::text AND ($4::text IS NULL OR f.name ILIKE $4)
 UNION ALL SELECT p.id,'CANVAS',p.name,p.created_at,p.updated_at,p.pinned,` + projectSize + ` FROM public.projects p LEFT JOIN organization.project_memberships m ON m.project_id=p.id AND m.owner_id=p.owner_id LEFT JOIN organization.visible_folders f ON f.id=m.folder_id AND f.owner_id=m.owner_id
 WHERE p.owner_id=$1 AND p.deleted_at IS NULL AND p.internal_kind IS NULL AND $3<>'FOLDER' AND (m.project_id IS NULL OR f.id IS NOT NULL) AND ($4::text IS NULL OR p.name ILIKE $4)
 AND (($2::text IS NULL AND ($3='CANVAS' OR m.project_id IS NULL)) OR ($2::text IS NOT NULL AND m.folder_id=$2))
) `

func (r *Repository) Entries(ctx context.Context, a domain.Actor, q domain.Query) (domain.Page, error) {
	var v domain.Page
	e := r.within(ctx, true, func(tx pgx.Tx) error {
		if q.ParentID != nil {
			if _, e := folder(ctx, tx, a, *q.ParentID); e != nil {
				return e
			}
		}
		var total int64
		e := tx.QueryRow(ctx, entryFilter+"SELECT count(*) FROM filtered", a.OwnerID, q.ParentID, q.Scope, search(q.Keyword)).Scan(&total)
		if e != nil {
			return unavailable(e)
		}
		rows, e := tx.Query(ctx, entryFilter+"SELECT id,type,byte_size FROM filtered ORDER BY pinned DESC,"+sortBy(q.Sort)+",id LIMIT $5 OFFSET $6", a.OwnerID, q.ParentID, q.Scope, search(q.Keyword), q.Size, q.Offset())
		if e != nil {
			return unavailable(e)
		}
		type selected struct {
			id, kind string
			size     int64
		}
		selectedRows := []selected{}
		for rows.Next() {
			var v selected
			if e = rows.Scan(&v.id, &v.kind, &v.size); e != nil {
				rows.Close()
				return unavailable(e)
			}
			selectedRows = append(selectedRows, v)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return unavailable(e)
		}
		records := []domain.Entry{}
		for _, s := range selectedRows {
			if s.kind == "FOLDER" {
				f, e := folder(ctx, tx, a, s.id)
				if e != nil {
					return e
				}
				records = append(records, domain.Entry{Type: s.kind, Folder: &f, ByteSize: s.size})
			} else {
				p, e := project(ctx, tx, a, s.id, false)
				if e != nil {
					return e
				}
				m, e := membership(ctx, tx, a, p)
				if e != nil {
					return e
				}
				records = append(records, domain.Entry{Type: s.kind, Project: &p, FolderID: m.FolderID, ByteSize: s.size})
			}
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
func (r *Repository) Tree(ctx context.Context, a domain.Actor, projectID string) (domain.Tree, error) {
	var v domain.Tree
	e := r.within(ctx, true, func(tx pgx.Tx) error {
		if _, e := project(ctx, tx, a, projectID, false); e != nil {
			return e
		}
		root := &domain.TreeNode{Type: "ROOT", MaxLevel: domain.MaxLevel, AllowCreateSubFolder: true, ChildList: []*domain.TreeNode{}}
		byID := map[string]*domain.TreeNode{}
		folders := []domain.Folder{}
		rows, e := tx.Query(ctx, "SELECT "+folderFields+" FROM organization.visible_folders f WHERE owner_id=$1 ORDER BY level,name COLLATE \"C\",id LIMIT 1001", a.OwnerID)
		if e != nil {
			return unavailable(e)
		}
		for rows.Next() {
			f, e := scanFolder(rows)
			if e != nil {
				rows.Close()
				return e
			}
			folders = append(folders, f)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return unavailable(e)
		}
		if len(folders) > domain.MaxFolders {
			return domain.ErrTooLarge
		}
		for _, f := range folders {
			id := f.ID
			n := &domain.TreeNode{ID: &id, FolderID: &id, ParentID: f.ParentID, Type: "FOLDER", Name: f.Name, Revision: f.Revision, Level: f.Level, MaxLevel: domain.MaxLevel, AllowCreateSubFolder: f.AllowCreateSubFolder, ItemCount: f.ItemCount, Total: f.Total, ChildList: []*domain.TreeNode{}}
			byID[id] = n
			if f.ParentID == nil {
				root.ChildList = append(root.ChildList, n)
			} else {
				parent := byID[*f.ParentID]
				if parent == nil {
					return domain.ErrUnavailable
				}
				parent.ChildList = append(parent.ChildList, n)
			}
		}
		rows, e = tx.Query(ctx, `SELECT p.id,p.name,p.revision,m.folder_id,(SELECT count(*) FROM jsonb_array_elements(p.graph->'nodes') n WHERE n->>'id'<>'rhtv_meta_v1') FROM public.projects p LEFT JOIN organization.project_memberships m ON m.project_id=p.id AND m.owner_id=p.owner_id LEFT JOIN organization.visible_folders f ON f.id=m.folder_id AND f.owner_id=m.owner_id WHERE p.owner_id=$1 AND p.deleted_at IS NULL AND p.internal_kind IS NULL AND (m.project_id IS NULL OR f.id IS NOT NULL) ORDER BY p.name COLLATE "C",p.id LIMIT 10001`, a.OwnerID)
		if e != nil {
			return unavailable(e)
		}
		count := 0
		for rows.Next() {
			var id, name string
			var revision, nodes int64
			var folderID *string
			if e = rows.Scan(&id, &name, &revision, &folderID, &nodes); e != nil {
				rows.Close()
				return unavailable(e)
			}
			count++
			if count > 10000 {
				rows.Close()
				return domain.ErrTooLarge
			}
			n := &domain.TreeNode{ID: &id, CanvasID: id, FolderID: folderID, Type: "CANVAS", Name: name, Revision: revision, MaxLevel: domain.MaxLevel, NodesCount: nodes, ChildList: []*domain.TreeNode{}}
			if folderID == nil {
				root.ChildList = append(root.ChildList, n)
			} else {
				parent := byID[*folderID]
				if parent == nil {
					rows.Close()
					return domain.ErrUnavailable
				}
				n.Level = parent.Level + 1
				parent.ChildList = append(parent.ChildList, n)
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return unavailable(e)
		}
		root.ItemCount = int64(len(root.ChildList))
		root.Total = int64(count)
		revision, e := collection(ctx, tx, a)
		if e != nil {
			return e
		}
		v = domain.Tree{Records: []*domain.TreeNode{root}, Revision: revision}
		return nil
	})
	return v, e
}
