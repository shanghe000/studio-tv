package collaboration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc
type api struct{ pool *pgxpool.Pool }

func RegisterRoutes(r chi.Router, pool *pgxpool.Pool, protect Protect) error {
	if r == nil || pool == nil || protect == nil {
		return errors.New("collaboration routes require router, pool and protection")
	}
	a := &api{pool}
	route := func(method, path string, h httpapi.Handler) {
		r.MethodFunc(method, "/api/v2/collaboration"+path, protect(authorization.TVAccess, h))
	}
	route("GET", "/users", a.users)
	route("GET", "/projects", a.projects)
	route("GET", "/projects/{projectId}/access", a.projectAccess)
	route("GET", "/projects/{projectId}/members", a.projectMembers)
	route("PUT", "/projects/{projectId}/members", a.putProjectMember)
	route("DELETE", "/projects/{projectId}/members/{userId}", a.deleteProjectMember)
	route("GET", "/projects/{projectId}/teams", a.projectTeams)
	route("PUT", "/projects/{projectId}/teams", a.putProjectTeam)
	route("DELETE", "/projects/{projectId}/teams/{teamId}", a.deleteProjectTeam)
	route("GET", "/teams", a.teams)
	route("POST", "/teams", a.createTeam)
	route("GET", "/teams/{teamId}", a.team)
	route("PATCH", "/teams/{teamId}", a.updateTeam)
	route("DELETE", "/teams/{teamId}", a.deleteTeam)
	route("GET", "/teams/{teamId}/members", a.teamMembers)
	route("PUT", "/teams/{teamId}/members", a.putTeamMember)
	route("DELETE", "/teams/{teamId}/members/{userId}", a.deleteTeamMember)
	return nil
}
func actor(r *http.Request) string { return httpapi.IdentityFrom(r).UserID }
func strong(revision int64) string { return fmt.Sprintf("\"%d\"", revision) }
func match(r *http.Request, revision int64) error {
	value := r.Header.Get("If-Match")
	if value == "" {
		return httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要先读取当前权限版本。")
	}
	if len(value) < 3 || value[0] != '"' || value[len(value)-1] != '"' {
		return httpapi.Fail(400, "INVALID_IF_MATCH", "需要有效的强ETag。")
	}
	n, e := strconv.ParseInt(value[1:len(value)-1], 10, 64)
	if e != nil || n < 1 || strong(n) != value {
		return httpapi.Fail(400, "INVALID_IF_MATCH", "需要有效的强ETag。")
	}
	if n != revision {
		return httpapi.Fail(412, "VERSION_CONFLICT", "权限已更新，请刷新后重试。")
	}
	return nil
}
func body(w http.ResponseWriter, r *http.Request, keys ...string) (map[string]any, error) {
	var b map[string]any
	if err := httpapi.DecodeLimit(w, r, &b, 16384); err != nil {
		return nil, err
	}
	if b == nil {
		return nil, httpapi.Fail(400, "VALIDATION_FAILED", "需要请求对象。")
	}
	for key := range b {
		found := false
		for _, k := range keys {
			if key == k {
				found = true
			}
		}
		if !found {
			return nil, httpapi.Fail(400, "UNKNOWN_FIELD", "请求包含未知字段。")
		}
	}
	return b, nil
}
func textField(b map[string]any, key string, max int) (string, error) {
	s, ok := b[key].(string)
	s = strings.TrimSpace(s)
	if !ok || s == "" || len([]rune(s)) > max || strings.ContainsAny(s, "\x00\r\n") {
		return "", httpapi.Fail(400, "VALIDATION_FAILED", "请求字段无效。")
	}
	return s, nil
}
func memberRole(b map[string]any) (string, error) {
	s, e := textField(b, "role", 16)
	if e != nil {
		return "", e
	}
	if s != EDITOR && s != VIEWER {
		return "", httpapi.Fail(400, "VALIDATION_FAILED", "协作者角色仅允许EDITOR或VIEWER。")
	}
	return s, nil
}
func federatedUser(ctx context.Context, db DB, id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	var ok bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.users u WHERE u.id=$1 AND NOT u.disabled AND EXISTS(SELECT 1 FROM public.federated_identities f WHERE f.user_id=u.id AND f.provider='feishu'))`, id).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return httpapi.Fail(404, "USER_NOT_FOUND", "可添加用户不存在。")
	}
	return nil
}
func page(r *http.Request) (int, int, error) {
	out := []int{1, 20}
	for i, key := range []string{"page", "pageSize"} {
		v := r.URL.Query().Get(key)
		if v == "" {
			continue
		}
		n, e := strconv.Atoi(v)
		if e != nil || strconv.Itoa(n) != v || n < 1 || i == 1 && n > 100 || n > 2147483647 {
			return 0, 0, httpapi.Fail(400, "VALIDATION_FAILED", "分页无效。")
		}
		out[i] = n
	}
	return out[0], out[1], nil
}
func like(s string) string {
	return "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(s) + "%"
}
func output(w http.ResponseWriter, r *http.Request, status int, data any, revision int64) error {
	if revision > 0 {
		w.Header().Set("ETag", strong(revision))
	}
	w.Header().Set("Cache-Control", "private, no-store")
	return httpapi.OK(w, r, status, data)
}
func (a *api) users(w http.ResponseWriter, r *http.Request) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) < 1 || len([]rune(q)) > 100 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "请输入1至100字的用户名称或ID。")
	}
	rows, e := a.pool.Query(r.Context(), `SELECT u.id,u.display_name,u.avatar_url FROM public.users u WHERE NOT u.disabled AND EXISTS(SELECT 1 FROM public.federated_identities f WHERE f.user_id=u.id AND f.provider='feishu') AND (u.display_name ILIKE $1 OR u.id=$2) ORDER BY u.display_name,u.id LIMIT 30`, like(q), q)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var id, name string
		var avatar *string
		if e = rows.Scan(&id, &name, &avatar); e != nil {
			return e
		}
		items = append(items, map[string]any{"id": id, "displayName": name, "avatarUrl": avatar})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return output(w, r, 200, map[string]any{"items": items}, 0)
}
func (a *api) projectAccess(w http.ResponseWriter, r *http.Request) error {
	id := chi.URLParam(r, "projectId")
	access, e := RequireProject(r.Context(), a.pool, actor(r), id, VIEWER, false)
	if e != nil {
		return e
	}
	var revision int64
	if e = a.pool.QueryRow(r.Context(), `SELECT collaboration_revision FROM public.projects WHERE id=$1`, id).Scan(&revision); e != nil {
		return e
	}
	return output(w, r, 200, map[string]any{"projectId": id, "ownerId": access.StorageOwnerID, "storageOwnerId": access.StorageOwnerID, "role": access.Role, "revision": revision, "canRead": true, "canEdit": Rank(access.Role) >= 2, "canRun": Rank(access.Role) >= 2, "canManageMembers": access.Role == OWNER}, revision)
}
func members(ctx context.Context, db DB, id string, team bool) (map[string]any, int64, error) {
	table, col, revisionCol, kind := "public.projects", "project_id", "collaboration_revision", "projectId"
	memberTable := "collaboration.project_members"
	if team {
		table, col, revisionCol, kind = "collaboration.teams", "team_id", "revision", "teamId"
		memberTable = "collaboration.team_members"
	}
	var revision int64
	if e := db.QueryRow(ctx, `SELECT `+revisionCol+` FROM `+table+` WHERE id=$1`, id).Scan(&revision); e != nil {
		return nil, 0, e
	}
	rows, e := db.Query(ctx, `SELECT u.id,u.display_name,u.avatar_url,'OWNER' FROM `+table+` root JOIN public.users u ON u.id=root.owner_id WHERE root.id=$1 UNION ALL SELECT u.id,u.display_name,u.avatar_url,m.role FROM `+memberTable+` m JOIN public.users u ON u.id=m.user_id WHERE m.`+col+`=$1 ORDER BY 4,2,1`, id)
	if e != nil {
		return nil, 0, e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var uid, name, role string
		var avatar *string
		if e = rows.Scan(&uid, &name, &avatar, &role); e != nil {
			return nil, 0, e
		}
		items = append(items, map[string]any{"userId": uid, "displayName": name, "avatarUrl": avatar, "role": role})
	}
	if e = rows.Err(); e != nil {
		return nil, 0, e
	}
	return map[string]any{kind: id, "revision": revision, "members": items}, revision, nil
}
func (a *api) projectMembers(w http.ResponseWriter, r *http.Request) error {
	return a.memberList(w, r, false)
}
func (a *api) teamMembers(w http.ResponseWriter, r *http.Request) error {
	return a.memberList(w, r, true)
}
func (a *api) memberList(w http.ResponseWriter, r *http.Request, team bool) error {
	id := chi.URLParam(r, "projectId")
	if team {
		id = chi.URLParam(r, "teamId")
		if _, e := RequireTeam(r.Context(), a.pool, actor(r), id, VIEWER, false); e != nil {
			return e
		}
	} else if _, e := RequireProject(r.Context(), a.pool, actor(r), id, VIEWER, false); e != nil {
		return e
	}
	data, revision, e := members(r.Context(), a.pool, id, team)
	if e != nil {
		return e
	}
	return output(w, r, 200, data, revision)
}
func (a *api) putProjectMember(w http.ResponseWriter, r *http.Request) error {
	return a.memberWrite(w, r, false, false)
}
func (a *api) deleteProjectMember(w http.ResponseWriter, r *http.Request) error {
	return a.memberWrite(w, r, false, true)
}
func (a *api) putTeamMember(w http.ResponseWriter, r *http.Request) error {
	return a.memberWrite(w, r, true, false)
}
func (a *api) deleteTeamMember(w http.ResponseWriter, r *http.Request) error {
	return a.memberWrite(w, r, true, true)
}
func (a *api) memberWrite(w http.ResponseWriter, r *http.Request, team, remove bool) error {
	id := chi.URLParam(r, "projectId")
	table, col, revCol, kind := "public.projects", "project_id", "collaboration_revision", "project"
	mt := "collaboration.project_members"
	if team {
		id = chi.URLParam(r, "teamId")
		table, col, revCol, kind = "collaboration.teams", "team_id", "revision", "team"
		mt = "collaboration.team_members"
	}
	uid, role := chi.URLParam(r, "userId"), ""
	if !remove {
		b, e := body(w, r, "userId", "role")
		if e != nil {
			return e
		}
		uid, e = textField(b, "userId", 64)
		if e != nil {
			return e
		}
		role, e = memberRole(b)
		if e != nil {
			return e
		}
	}
	if e := ValidateID(uid); e != nil {
		return e
	}
	data, e := database.Transaction(r.Context(), a.pool, func(tx pgx.Tx) (map[string]any, error) {
		var ownerID string
		if team {
			access, e := RequireTeam(r.Context(), tx, actor(r), id, OWNER, true)
			if e != nil {
				return nil, e
			}
			ownerID = access.StorageOwnerID
		} else {
			access, e := RequireProject(r.Context(), tx, actor(r), id, OWNER, true)
			if e != nil {
				return nil, e
			}
			ownerID = access.StorageOwnerID
		}
		var revision int64
		if e := tx.QueryRow(r.Context(), `SELECT `+revCol+` FROM `+table+` WHERE id=$1`, id).Scan(&revision); e != nil {
			return nil, e
		}
		if e := match(r, revision); e != nil {
			return nil, e
		}
		if uid == ownerID {
			return nil, httpapi.Fail(403, "OWNER_IMMUTABLE", "不能修改或移除所有者。")
		}
		action := "member.upsert"
		if remove {
			tag, e := tx.Exec(r.Context(), `DELETE FROM `+mt+` WHERE `+col+`=$1 AND user_id=$2`, id, uid)
			if e != nil {
				return nil, e
			}
			if tag.RowsAffected() == 0 {
				return nil, httpapi.Fail(404, "MEMBER_NOT_FOUND", "协作者不存在。")
			}
			action = "member.remove"
		} else {
			if e := federatedUser(r.Context(), tx, uid); e != nil {
				return nil, e
			}
			if _, e := tx.Exec(r.Context(), `INSERT INTO `+mt+`(`+col+`,user_id,role,created_by) VALUES($1,$2,$3,$4) ON CONFLICT (`+col+`,user_id) DO UPDATE SET role=EXCLUDED.role,updated_at=now()`, id, uid, role, actor(r)); e != nil {
				return nil, e
			}
		}
		if _, e := tx.Exec(r.Context(), `UPDATE `+table+` SET `+revCol+`=`+revCol+`+1,updated_at=now() WHERE id=$1`, id); e != nil {
			return nil, e
		}
		if e := Audit(r.Context(), tx, actor(r), action, kind, id, map[string]any{"userId": uid, "role": role}); e != nil {
			return nil, e
		}
		data, _, e := members(r.Context(), tx, id, team)
		return data, e
	})
	if e != nil {
		return e
	}
	return output(w, r, 200, data, data["revision"].(int64))
}
func teamGrants(ctx context.Context, db DB, id string) (map[string]any, int64, error) {
	var revision int64
	if e := db.QueryRow(ctx, `SELECT collaboration_revision FROM public.projects WHERE id=$1`, id).Scan(&revision); e != nil {
		return nil, 0, e
	}
	rows, e := db.Query(ctx, `SELECT t.id,t.name,pt.role FROM collaboration.project_teams pt JOIN collaboration.teams t ON t.id=pt.team_id AND t.deleted_at IS NULL WHERE pt.project_id=$1 ORDER BY t.name,t.id`, id)
	if e != nil {
		return nil, 0, e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var id, name, role string
		if e = rows.Scan(&id, &name, &role); e != nil {
			return nil, 0, e
		}
		items = append(items, map[string]any{"teamId": id, "name": name, "role": role})
	}
	if e = rows.Err(); e != nil {
		return nil, 0, e
	}
	return map[string]any{"projectId": id, "revision": revision, "teams": items}, revision, nil
}
func (a *api) projectTeams(w http.ResponseWriter, r *http.Request) error {
	id := chi.URLParam(r, "projectId")
	if _, e := RequireProject(r.Context(), a.pool, actor(r), id, VIEWER, false); e != nil {
		return e
	}
	data, revision, e := teamGrants(r.Context(), a.pool, id)
	if e != nil {
		return e
	}
	return output(w, r, 200, data, revision)
}
func (a *api) putProjectTeam(w http.ResponseWriter, r *http.Request) error {
	return a.projectTeamWrite(w, r, false)
}
func (a *api) deleteProjectTeam(w http.ResponseWriter, r *http.Request) error {
	return a.projectTeamWrite(w, r, true)
}
func (a *api) projectTeamWrite(w http.ResponseWriter, r *http.Request, remove bool) error {
	pid, tid, role := chi.URLParam(r, "projectId"), chi.URLParam(r, "teamId"), ""
	if !remove {
		b, e := body(w, r, "teamId", "role")
		if e != nil {
			return e
		}
		tid, e = textField(b, "teamId", 64)
		if e != nil {
			return e
		}
		role, e = memberRole(b)
		if e != nil {
			return e
		}
	}
	if e := ValidateID(tid); e != nil {
		return e
	}
	data, e := database.Transaction(r.Context(), a.pool, func(tx pgx.Tx) (map[string]any, error) {
		if _, e := RequireProject(r.Context(), tx, actor(r), pid, OWNER, true); e != nil {
			return nil, e
		}
		var revision int64
		if e := tx.QueryRow(r.Context(), `SELECT collaboration_revision FROM public.projects WHERE id=$1`, pid).Scan(&revision); e != nil {
			return nil, e
		}
		if e := match(r, revision); e != nil {
			return nil, e
		}
		action := "team.grant"
		if remove {
			tag, e := tx.Exec(r.Context(), `DELETE FROM collaboration.project_teams WHERE project_id=$1 AND team_id=$2`, pid, tid)
			if e != nil {
				return nil, e
			}
			if tag.RowsAffected() == 0 {
				return nil, httpapi.Fail(404, "TEAM_GRANT_NOT_FOUND", "团队授权不存在。")
			}
			action = "team.revoke"
		} else {
			// Only the project grant is mutated. A shared team lock prevents
			// membership revocation without upgrading locks already held by
			// RequireProject (two project writers could otherwise deadlock).
			var lockedTeam string
			if e := tx.QueryRow(r.Context(), `SELECT id FROM collaboration.teams WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, tid).Scan(&lockedTeam); errors.Is(e, pgx.ErrNoRows) {
				return nil, httpapi.Fail(404, "TEAM_NOT_FOUND", "团队不存在。")
			} else if e != nil {
				return nil, e
			}
			if _, e := RequireTeam(r.Context(), tx, actor(r), tid, VIEWER, false); e != nil {
				return nil, e
			}
			if _, e := tx.Exec(r.Context(), `INSERT INTO collaboration.project_teams(project_id,team_id,role,created_by) VALUES($1,$2,$3,$4) ON CONFLICT (project_id,team_id) DO UPDATE SET role=EXCLUDED.role,updated_at=now()`, pid, tid, role, actor(r)); e != nil {
				return nil, e
			}
		}
		if _, e := tx.Exec(r.Context(), `UPDATE public.projects SET collaboration_revision=collaboration_revision+1,updated_at=now() WHERE id=$1`, pid); e != nil {
			return nil, e
		}
		if e := Audit(r.Context(), tx, actor(r), action, "project", pid, map[string]any{"teamId": tid, "role": role}); e != nil {
			return nil, e
		}
		data, _, e := teamGrants(r.Context(), tx, pid)
		return data, e
	})
	if e != nil {
		return e
	}
	return output(w, r, 200, data, data["revision"].(int64))
}

func (a *api) projects(w http.ResponseWriter, r *http.Request) error {
	p, size, e := page(r)
	if e != nil {
		return e
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "all"
	}
	if scope != "all" && scope != "owned" && scope != "shared" {
		return httpapi.Fail(400, "VALIDATION_FAILED", "项目范围无效。")
	}
	q := r.URL.Query().Get("q")
	if len([]rune(q)) > 200 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "搜索长度超限。")
	}
	where := `p.deleted_at IS NULL AND p.internal_kind IS NULL AND (` + ProjectRoleSQL + `)>0 AND ($2='all' OR ($2='owned' AND p.owner_id=$1) OR ($2='shared' AND p.owner_id<>$1)) AND p.name ILIKE $3`
	var total int
	if e = a.pool.QueryRow(r.Context(), `SELECT count(*)::int FROM public.projects p WHERE `+where, actor(r), scope, like(q)).Scan(&total); e != nil {
		return e
	}
	rows, e := a.pool.Query(r.Context(), `SELECT p.id,p.owner_id,p.name,p.cover_asset_id,p.pinned,p.revision,p.created_at,p.updated_at,`+ProjectRoleSQL+` FROM public.projects p WHERE `+where+` ORDER BY p.pinned DESC,p.updated_at DESC,p.id LIMIT $4 OFFSET $5`, actor(r), scope, like(q), size, (int64(p)-1)*int64(size))
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var id, owner, name string
		var cover *string
		var pinned bool
		var rev int
		var created, updated time.Time
		var rank int
		if e = rows.Scan(&id, &owner, &name, &cover, &pinned, &rev, &created, &updated, &rank); e != nil {
			return e
		}
		items = append(items, map[string]any{"id": id, "name": name, "ownerId": owner, "coverAssetId": cover, "pinned": pinned, "revision": rev, "createdAt": created, "updatedAt": updated, "role": role(rank)})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return output(w, r, 200, map[string]any{"items": items, "page": p, "pageSize": size, "total": total, "hasMore": int64(p)*int64(size) < int64(total)}, 0)
}

const teamRoleSQL = `CASE collaboration.team_role(t.id,$1) WHEN 'OWNER' THEN 3 WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END`

func teamData(ctx context.Context, db DB, id, uid string) (map[string]any, int64, error) {
	var owner, name string
	var revision int64
	var created, updated time.Time
	var rank int
	e := db.QueryRow(ctx, `SELECT t.owner_id,t.name,t.revision,t.created_at,t.updated_at,`+teamRoleSQL+` FROM collaboration.teams t WHERE t.id=$2 AND t.deleted_at IS NULL`, uid, id).Scan(&owner, &name, &revision, &created, &updated, &rank)
	if e != nil {
		return nil, 0, e
	}
	return map[string]any{"id": id, "ownerId": owner, "name": name, "revision": revision, "createdAt": created, "updatedAt": updated, "role": role(rank)}, revision, nil
}
func (a *api) teams(w http.ResponseWriter, r *http.Request) error {
	p, size, e := page(r)
	if e != nil {
		return e
	}
	var total int
	where := `t.deleted_at IS NULL AND (` + teamRoleSQL + `)>0`
	if e = a.pool.QueryRow(r.Context(), `SELECT count(*)::int FROM collaboration.teams t WHERE `+where, actor(r)).Scan(&total); e != nil {
		return e
	}
	rows, e := a.pool.Query(r.Context(), `SELECT t.id,t.owner_id,t.name,t.revision,`+teamRoleSQL+` FROM collaboration.teams t WHERE `+where+` ORDER BY t.updated_at DESC,t.id LIMIT $2 OFFSET $3`, actor(r), size, (int64(p)-1)*int64(size))
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var id, owner, name string
		var revision int64
		var rank int
		if e = rows.Scan(&id, &owner, &name, &revision, &rank); e != nil {
			return e
		}
		items = append(items, map[string]any{"id": id, "ownerId": owner, "name": name, "revision": revision, "role": role(rank)})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return output(w, r, 200, map[string]any{"items": items, "page": p, "pageSize": size, "total": total, "hasMore": int64(p)*int64(size) < int64(total)}, 0)
}
func (a *api) createTeam(w http.ResponseWriter, r *http.Request) error {
	b, e := body(w, r, "name")
	if e != nil {
		return e
	}
	name, e := textField(b, "name", 120)
	if e != nil {
		return e
	}
	data, e := database.Transaction(r.Context(), a.pool, func(tx pgx.Tx) (map[string]any, error) {
		if e := active(r.Context(), tx, actor(r)); e != nil {
			return nil, e
		}
		id := "team_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		if _, e := tx.Exec(r.Context(), `INSERT INTO collaboration.teams(id,owner_id,name) VALUES($1,$2,$3)`, id, actor(r), name); e != nil {
			return nil, e
		}
		if e := Audit(r.Context(), tx, actor(r), "team.create", "team", id, nil); e != nil {
			return nil, e
		}
		d, _, e := teamData(r.Context(), tx, id, actor(r))
		return d, e
	})
	if e != nil {
		return e
	}
	return output(w, r, 201, data, data["revision"].(int64))
}
func (a *api) team(w http.ResponseWriter, r *http.Request) error {
	id := chi.URLParam(r, "teamId")
	if _, e := RequireTeam(r.Context(), a.pool, actor(r), id, VIEWER, false); e != nil {
		return e
	}
	data, rev, e := teamData(r.Context(), a.pool, id, actor(r))
	if e != nil {
		return e
	}
	return output(w, r, 200, data, rev)
}
func (a *api) updateTeam(w http.ResponseWriter, r *http.Request) error {
	return a.teamWrite(w, r, false)
}
func (a *api) deleteTeam(w http.ResponseWriter, r *http.Request) error {
	return a.teamWrite(w, r, true)
}
func (a *api) teamWrite(w http.ResponseWriter, r *http.Request, remove bool) error {
	id := chi.URLParam(r, "teamId")
	name := ""
	if !remove {
		b, e := body(w, r, "name")
		if e != nil {
			return e
		}
		name, e = textField(b, "name", 120)
		if e != nil {
			return e
		}
	}
	data, e := database.Transaction(r.Context(), a.pool, func(tx pgx.Tx) (map[string]any, error) {
		if _, e := RequireTeam(r.Context(), tx, actor(r), id, OWNER, true); e != nil {
			return nil, e
		}
		var rev int64
		if e := tx.QueryRow(r.Context(), `SELECT revision FROM collaboration.teams WHERE id=$1`, id).Scan(&rev); e != nil {
			return nil, e
		}
		if e := match(r, rev); e != nil {
			return nil, e
		}
		action := "team.update"
		if remove {
			if _, e := tx.Exec(r.Context(), `UPDATE collaboration.teams SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1`, id); e != nil {
				return nil, e
			}
			action = "team.delete"
		} else if _, e := tx.Exec(r.Context(), `UPDATE collaboration.teams SET name=$2,updated_at=now(),revision=revision+1 WHERE id=$1`, id, name); e != nil {
			return nil, e
		}
		if e := Audit(r.Context(), tx, actor(r), action, "team", id, nil); e != nil {
			return nil, e
		}
		if remove {
			return map[string]any{"id": id, "revision": rev + 1, "deleted": true}, nil
		}
		d, _, e := teamData(r.Context(), tx, id, actor(r))
		return d, e
	})
	if e != nil {
		return e
	}
	return output(w, r, 200, data, data["revision"].(int64))
}
