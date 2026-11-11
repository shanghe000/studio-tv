package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"reflect"
	"regexp"
	"strings"
	"time"
)

type Project struct {
	ID, OwnerID, Name    string
	Role                 string
	WorkspaceID          *string
	CoverAssetID         *string
	Pinned               bool
	Revision             int
	Graph                []byte
	CreatedAt, UpdatedAt time.Time
}

const projectColumns = "id,owner_id,name,cover_asset_id,pinned,revision,graph,created_at,updated_at,workspace_id"

func scanProject(row pgx.Row) (Project, error) {
	var p Project
	err := row.Scan(&p.ID, &p.OwnerID, &p.Name, &p.CoverAssetID, &p.Pinned, &p.Revision, &p.Graph, &p.CreatedAt, &p.UpdatedAt, &p.WorkspaceID)
	return p, err
}
func ownProject(ctx context.Context, db DB, uid, pid string, lock bool) (Project, error) {
	role := collaboration.VIEWER
	if lock {
		role = collaboration.EDITOR
	}
	return projectWithRole(ctx, db, uid, pid, role, lock)
}
func projectWithRole(ctx context.Context, db DB, actorID, pid, requiredRole string, lock bool) (Project, error) {
	access, err := collaboration.RequireProject(ctx, db, actorID, pid, requiredRole, lock)
	if err != nil {
		return Project{}, err
	}
	p, err := scanProject(db.QueryRow(ctx, "SELECT "+projectColumns+" FROM projects WHERE id=$1 AND deleted_at IS NULL AND internal_kind IS NULL", pid))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, httpapi.Fail(404, "PROJECT_NOT_FOUND", "项目不存在。")
	}
	p.Role = access.Role
	return p, err
}
func (p Project) Public() map[string]any {
	data := map[string]any{"id": p.ID, "name": p.Name, "ownerId": p.OwnerID, "teamId": nil, "coverAssetId": nullableString(p.CoverAssetID), "pinned": p.Pinned, "revision": p.Revision, "createdAt": iso(p.CreatedAt), "updatedAt": iso(p.UpdatedAt)}
	if p.Role != "" {
		data["role"] = p.Role
	}
	return data
}
func (p Project) Snapshot() (map[string]any, error) {
	var graph any
	dec := json.NewDecoder(bytes.NewReader(p.Graph))
	dec.UseNumber()
	if err := dec.Decode(&graph); err != nil {
		return nil, err
	}
	return map[string]any{"projectId": p.ID, "revision": p.Revision, "graph": graph, "updatedAt": iso(p.UpdatedAt)}, nil
}
func etag(revision int) string   { return fmt.Sprintf("\"%d\"", revision) }
func newID(prefix string) string { return prefix + "_" + strings.ReplaceAll(uuid.NewString(), "-", "") }
func (s *Server) projects(r chi.Router) {
	s.route(r, "GET", "/api/v1/projects", true, s.listProjects)
	s.route(r, "POST", "/api/v1/projects", true, s.createProject)
	s.route(r, "GET", "/api/v1/projects/{projectId}", true, func(w http.ResponseWriter, r *http.Request) error {
		p, e := s.ownedProject(r, s.db, chi.URLParam(r, "projectId"), false)
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, p.Public())
	})
	s.route(r, "PATCH", "/api/v1/projects/{projectId}", true, s.updateProject)
	s.route(r, "DELETE", "/api/v1/projects/{projectId}", true, s.deleteProject)
	for _, method := range []string{"PUT", "DELETE"} {
		pinned := method == "PUT"
		s.route(r, method, "/api/v1/projects/{projectId}/pin", true, func(w http.ResponseWriter, r *http.Request) error {
			p, e := database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (Project, error) {
				current, e := s.ownedProject(r, tx, chi.URLParam(r, "projectId"), true)
				if e != nil {
					return Project{}, e
				}
				return scanProject(tx.QueryRow(r.Context(), "UPDATE projects SET pinned=$2,updated_at=now() WHERE id=$1 RETURNING "+projectColumns, current.ID, pinned))
			})
			if e != nil {
				return e
			}
			return httpapi.OK(w, r, 200, p.Public())
		})
	}
	s.route(r, "GET", "/api/v1/projects/{projectId}/snapshot", true, func(w http.ResponseWriter, r *http.Request) error {
		p, e := s.ownedProject(r, s.db, chi.URLParam(r, "projectId"), false)
		if e != nil {
			return e
		}
		snapshot, e := p.Snapshot()
		if e != nil {
			return e
		}
		if e = s.offerCanvasMedia(w, r, p.ID); e != nil {
			return e
		}
		w.Header().Set("ETag", etag(p.Revision))
		return httpapi.OK(w, r, 200, snapshot)
	})
	s.route(r, "PUT", "/api/v1/projects/{projectId}/snapshot", true, s.saveSnapshot)
	s.route(r, "POST", "/api/v2/projects/{projectId}/canvas-operations", true, s.applyCanvasOperations)
	s.route(r, "POST", "/api/v2/projects/{projectId}/edit-session", true, s.acquireCanvasEditSession)
	s.route(r, "DELETE", "/api/v2/projects/{projectId}/edit-session", true, s.releaseCanvasEditSession)
	s.route(r, "GET", "/api/v2/projects/{projectId}/edit-session", true, s.canvasWriterStatus)
	s.route(r, "POST", "/api/v2/projects/{projectId}/edit-session/ready", true, s.confirmCanvasWriter)
	s.route(r, "POST", "/api/v2/projects/{projectId}/edit-session/requests", true, s.requestCanvasWriter)
	s.route(r, "DELETE", "/api/v2/projects/{projectId}/edit-session/requests/{requestId}", true, s.cancelCanvasWriterRequest)
	s.route(r, "POST", "/api/v2/projects/{projectId}/edit-session/requests/{requestId}/decision", true, s.decideCanvasWriterRequest)
}
func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) error {
	if err := queryKeys(r, "page", "pageSize", "q", "sort"); err != nil {
		return err
	}
	page, e := integerQuery(r, "page", 1, 2147483647)
	if e != nil {
		return e
	}
	size, e := integerQuery(r, "pageSize", 20, 100)
	if e != nil {
		return e
	}
	q := r.URL.Query().Get("q")
	if len([]rune(q)) > 200 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "搜索长度超限。")
	}
	sort := "updated_at DESC"
	switch r.URL.Query().Get("sort") {
	case "", "UPDATED_DESC":
	case "CREATED_DESC":
		sort = "created_at DESC"
	case "NAME_ASC":
		sort = "name ASC"
	default:
		return httpapi.Fail(400, "VALIDATION_FAILED", "排序字段无效。")
	}
	var search any
	if q != "" {
		search = "%" + escapeLike(q) + "%"
	}
	var total int
	e = s.db.QueryRow(r.Context(), "SELECT count(*)::int FROM projects WHERE owner_id=$1 AND deleted_at IS NULL AND internal_kind IS NULL AND ($2::text IS NULL OR name ILIKE $2)", owner(r), search).Scan(&total)
	if e != nil {
		return e
	}
	rows, e := s.db.Query(r.Context(), "SELECT "+projectColumns+" FROM projects WHERE owner_id=$1 AND deleted_at IS NULL AND internal_kind IS NULL AND ($2::text IS NULL OR name ILIKE $2) ORDER BY pinned DESC,"+sort+",id LIMIT $3 OFFSET $4", owner(r), search, size, (int64(page)-1)*int64(size))
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		p, e := scanProject(rows)
		if e != nil {
			return e
		}
		items = append(items, p.Public())
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return httpapi.OK(w, r, 200, map[string]any{"items": items, "page": page, "pageSize": size, "total": total, "hasMore": int64(page)*int64(size) < int64(total)})
}
func (s *Server) createProject(w http.ResponseWriter, r *http.Request) error {
	body, e := s.body(w, r, "ProjectCreateRequest")
	if e != nil {
		return e
	}
	if body["source"] != nil {
		return httpapi.Fail(501, "CONTENT_CLONE_UNAVAILABLE", "内容初始化尚未启用。")
	}
	result, e := s.idempotent(r, "createProject", body, func(tx pgx.Tx) (Result, error) {
		p, e := scanProject(tx.QueryRow(r.Context(), "INSERT INTO projects(id,owner_id,name)VALUES($1,$2,$3) RETURNING "+projectColumns, newID("prj"), owner(r), body["name"]))
		return Result{201, p.Public()}, e
	})
	if e != nil {
		return e
	}
	return httpapi.OK(w, r, result.Status, result.Data)
}
func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) error {
	body, e := s.body(w, r, "ProjectUpdateRequest")
	if e != nil {
		return e
	}
	p, e := database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (Project, error) {
		current, e := s.ownedProject(r, tx, chi.URLParam(r, "projectId"), true)
		if e != nil {
			return Project{}, e
		}
		cover, hasCover := body["coverAssetId"]
		if aid, ok := cover.(string); ok {
			e = collaboration.AuthorizeProjectAssets(r.Context(), tx, owner(r), current.ID, []string{aid})
			if e != nil {
				return Project{}, e
			}
		}
		return scanProject(tx.QueryRow(r.Context(), "UPDATE projects SET name=COALESCE($2,name),cover_asset_id=CASE WHEN $3 THEN $4 ELSE cover_asset_id END,updated_at=now() WHERE id=$1 RETURNING "+projectColumns, current.ID, body["name"], hasCover, cover))
	})
	if e != nil {
		return e
	}
	return httpapi.OK(w, r, 200, p.Public())
}
func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) error {
	pid := chi.URLParam(r, "projectId")
	at, e := database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (time.Time, error) {
		p, e := projectWithRole(r.Context(), tx, owner(r), pid, collaboration.OWNER, true)
		if e != nil {
			return time.Time{}, e
		}
		var deleted time.Time
		e = tx.QueryRow(r.Context(), "UPDATE projects SET deleted_at=now(),updated_at=now() WHERE id=$1 RETURNING deleted_at", p.ID).Scan(&deleted)
		return deleted, e
	})
	if e != nil {
		return e
	}
	return httpapi.OK(w, r, 200, map[string]any{"id": pid, "deletedAt": iso(at)})
}

var matchETag = regexp.MustCompile(`^"[0-9]+"$`)

func (s *Server) saveSnapshot(w http.ResponseWriter, r *http.Request) error {
	match := r.Header.Get("If-Match")
	if len(r.Header.Values("If-Match")) != 1 || !matchETag.MatchString(match) {
		return httpapi.Fail(400, "IF_MATCH_REQUIRED", "需要读取快照返回的强ETag作为If-Match。")
	}
	body, e := s.body(w, r, "ProjectSaveRequest")
	if e != nil {
		return e
	}
	graph := body["graph"].(map[string]any)
	refs, e := validateGraph(graph)
	if e != nil {
		return e
	}
	p, e := database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (Project, error) {
		current, e := s.ownedProject(r, tx, chi.URLParam(r, "projectId"), true)
		if e != nil {
			return Project{}, e
		}
		if etag(current.Revision) != match {
			api := httpapi.Fail(412, "VERSION_CONFLICT", "项目已更新，请重新读取后合并。")
			api.Details = []httpapi.Detail{{Field: "/headers/If-Match", Code: "CURRENT_REVISION", Message: fmt.Sprint(current.Revision)}}
			return Project{}, api
		}
		if len(r.Header.Values(collaboration.CanvasSessionHeader)) > 1 {
			return Project{}, httpapi.Fail(400, "VALIDATION_FAILED", "画布会话标识不能重复。")
		}
		next := encode(graph)
		changed, err := collaboration.ChangedNodeIDs(current.Graph, next)
		if err != nil {
			return Project{}, err
		}
		client := r.Header.Get(collaboration.CanvasSessionHeader)
		identity := httpapi.IdentityFrom(r)
		late := false
		if err = collaboration.CheckNodeLeases(r.Context(), tx, current.ID, identity, client, changed); err != nil {
			var refusal *httpapi.Error
			if !errors.As(err, &refusal) || refusal.Code != "EDIT_SESSION_EXPIRED" {
				return Project{}, err
			}
			// An exact canonical replay is only a read acknowledgement. Check
			// every persisted field (including metadata and viewport) before
			// acknowledging a snapshot from a client without a writable seat.
			if reflect.DeepEqual(decodeOperationGraph(current.Graph), graph) {
				return current, nil
			}
			if client == "" || len(r.Header.Values(collaboration.CanvasProofHeader)) == 0 || len(r.Header.Values(collaboration.CanvasLeaseHeader)) == 0 {
				return Project{}, collaboration.LegacyCanvasPageUpdateRequired()
			}
			if late, err = collaboration.ConsumeExpiredSnapshotBase(r.Context(), tx, current.ID, identity, client, current.Revision); err != nil {
				return Project{}, err
			}
			if !late {
				return Project{}, httpapi.Fail(409, "CANVAS_PAGE_UPDATE_REQUIRED", "旧页面的保存凭据或画布基线已失效，此次修改尚未保存。请保留此页，在新标签页打开最新画布。")
			}
		}
		if !late && client != "" && r.Header.Get(collaboration.CanvasLeaseHeader) != "" {
			// A valid writer may have been in the background while a sibling
			// committed. An ETag fetched later must not turn its old full
			// document into an overwrite of the sibling's authoritative edit.
			var baseMatches bool
			err := tx.QueryRow(r.Context(), `SELECT coalesce(snapshot_base=$5,false) FROM collaboration.canvas_account_pages
             WHERE project_id=$1 AND session_id=$2 AND client_id=$3 AND lease_id::text=$4`,
				current.ID, identity.SessionID, client, r.Header.Get(collaboration.CanvasLeaseHeader), current.Revision).Scan(&baseMatches)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return Project{}, err
			}
			if err == nil && !baseMatches {
				if !reflect.DeepEqual(decodeOperationGraph(current.Graph), graph) {
					return Project{}, httpapi.Fail(409, "CANVAS_PAGE_UPDATE_REQUIRED", "此页面未确认其他页面的最新修改，本次保存已停止。请保留此页，在新标签页打开最新画布。")
				}
				_, err = tx.Exec(r.Context(), `UPDATE collaboration.canvas_account_pages SET snapshot_base=$3 WHERE project_id=$1 AND lease_id::text=$2`, current.ID, r.Header.Get(collaboration.CanvasLeaseHeader), current.Revision)
				return current, err
			}
		}
		if len(refs) > 0 {
			if e := collaboration.AuthorizeProjectAssets(r.Context(), tx, owner(r), current.ID, refs); e != nil {
				return Project{}, e
			}
		}
		saved, err := scanProject(tx.QueryRow(r.Context(), "UPDATE projects SET graph=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING "+projectColumns, current.ID, next))
		if err == nil && !late && client != "" && len(r.Header.Values(collaboration.CanvasLeaseHeader)) == 1 {
			_, err = tx.Exec(r.Context(), `UPDATE collaboration.canvas_account_pages SET snapshot_base=$5 WHERE project_id=$1 AND session_id=$2 AND client_id=$3 AND lease_id::text=$4`, current.ID, identity.SessionID, client, r.Header.Get(collaboration.CanvasLeaseHeader), saved.Revision)
		}
		return saved, err
	})
	if e != nil {
		return e
	}
	snapshot, e := p.Snapshot()
	if e != nil {
		return e
	}
	w.Header().Set("ETag", etag(p.Revision))
	return httpapi.OK(w, r, 200, snapshot)
}
func queryKeys(r *http.Request, allowed ...string) error {
	keys := map[string]bool{}
	for _, key := range allowed {
		keys[key] = true
	}
	for key, values := range r.URL.Query() {
		if !keys[key] || len(values) != 1 {
			return httpapi.Fail(400, "UNKNOWN_FIELD", "查询包含未知或重复字段。")
		}
	}
	return nil
}
func escapeLike(q string) string {
	return strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(q)
}
