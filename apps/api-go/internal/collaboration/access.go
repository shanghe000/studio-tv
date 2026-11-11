// Package collaboration keeps product resource permissions local. A storage
// owner is a resource namespace, never a replacement for an authenticated actor.
package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"studiotv.local/service/api/internal/httpapi"
)

const (
	OWNER  = "OWNER"
	EDITOR = "EDITOR"
	VIEWER = "VIEWER"
)

type DB interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type ProjectAccess struct{ ActorID, ProjectID, StorageOwnerID, Role string }
type TeamAccess struct{ ActorID, TeamID, StorageOwnerID, Role string }

// ProjectRoleSQL is an expression for project alias p and actor parameter $1.
// Team permissions are capped by the grant and can never confer project OWNER.
const ProjectRoleSQL = `CASE collaboration.project_role(p.id,$1) WHEN 'OWNER' THEN 3 WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END`

func role(rank int) string {
	switch rank {
	case 3:
		return OWNER
	case 2:
		return EDITOR
	case 1:
		return VIEWER
	}
	return ""
}
func Rank(value string) int {
	switch value {
	case OWNER:
		return 3
	case EDITOR:
		return 2
	case VIEWER:
		return 1
	}
	return 0
}
func ValidateID(id string) error {
	if len(id) < 1 || len(id) > 64 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "资源ID无效。")
	}
	for i, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || i > 0 && (c == '_' || c == '-')) {
			return httpapi.Fail(400, "VALIDATION_FAILED", "资源ID无效。")
		}
	}
	return nil
}
func required(value string) error {
	if Rank(value) == 0 {
		return httpapi.Fail(500, "INVALID_ACCESS_POLICY", "资源权限策略无效。")
	}
	return nil
}
func active(ctx context.Context, db DB, actor string) error {
	var enabled bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.users WHERE id=$1 AND NOT disabled)`, actor).Scan(&enabled); err != nil {
		return err
	}
	if !enabled {
		return httpapi.Fail(http.StatusUnauthorized, "UNAUTHENTICATED", "账号不可用。")
	}
	return nil
}

// lock=false is safe in read-only transactions. Writers must pass lock=true
// inside their transaction, coordinating with membership revocation on p's row.
func RequireProject(ctx context.Context, db DB, actorID, projectID, requiredRole string, lock bool) (ProjectAccess, error) {
	a := ProjectAccess{ActorID: actorID, ProjectID: projectID}
	if err := required(requiredRole); err != nil {
		return a, err
	}
	if err := ValidateID(projectID); err != nil {
		return a, err
	}
	if err := active(ctx, db, actorID); err != nil {
		return a, err
	}
	q := `SELECT owner_id FROM public.projects WHERE id=$1 AND deleted_at IS NULL AND internal_kind IS NULL`
	if lock {
		q += ` FOR UPDATE`
	}
	err := db.QueryRow(ctx, q, projectID).Scan(&a.StorageOwnerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, httpapi.Fail(404, "PROJECT_NOT_FOUND", "项目不存在。")
	}
	if err != nil {
		return a, err
	}
	if lock {
		// Lock team rows in a deterministic order before evaluating team grants.
		// Team-member mutations use the same rows; no stale grant can commit a write.
		rows, e := db.Query(ctx, `SELECT t.id FROM collaboration.teams t JOIN collaboration.project_teams pt ON pt.team_id=t.id WHERE pt.project_id=$1 AND t.deleted_at IS NULL ORDER BY t.id FOR SHARE OF t`, projectID)
		if e != nil {
			return a, e
		}
		for rows.Next() {
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return a, e
		}
	}
	var n int
	err = db.QueryRow(ctx, `SELECT `+ProjectRoleSQL+` FROM public.projects p WHERE p.id=$2`, actorID, projectID).Scan(&n)
	if err != nil {
		return a, err
	}
	a.Role = role(n)
	if n == 0 {
		return a, httpapi.Fail(404, "PROJECT_NOT_FOUND", "项目不存在。")
	}
	if n < Rank(requiredRole) {
		return a, httpapi.Fail(403, "FORBIDDEN", "当前项目权限不允许此操作。")
	}
	return a, nil
}
func RequireTeam(ctx context.Context, db DB, actorID, teamID, requiredRole string, lock bool) (TeamAccess, error) {
	a := TeamAccess{ActorID: actorID, TeamID: teamID}
	if err := required(requiredRole); err != nil {
		return a, err
	}
	if err := ValidateID(teamID); err != nil {
		return a, err
	}
	if err := active(ctx, db, actorID); err != nil {
		return a, err
	}
	q := `SELECT owner_id FROM collaboration.teams WHERE id=$1 AND deleted_at IS NULL`
	if lock {
		q += ` FOR UPDATE`
	}
	err := db.QueryRow(ctx, q, teamID).Scan(&a.StorageOwnerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, httpapi.Fail(404, "TEAM_NOT_FOUND", "团队不存在。")
	}
	if err != nil {
		return a, err
	}
	var n int
	err = db.QueryRow(ctx, `SELECT CASE collaboration.team_role($2,$1) WHEN 'OWNER' THEN 3 WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END`, actorID, teamID).Scan(&n)
	if err != nil {
		return a, err
	}
	a.Role = role(n)
	if n == 0 {
		return a, httpapi.Fail(404, "TEAM_NOT_FOUND", "团队不存在。")
	}
	if n < Rank(requiredRole) {
		return a, httpapi.Fail(403, "FORBIDDEN", "当前团队权限不允许此操作。")
	}
	return a, nil
}

func Audit(ctx context.Context, db DB, actorID, action, kind, id string, details any) error {
	if details == nil {
		details = map[string]any{}
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, `INSERT INTO collaboration.audit(actor_id,action,resource_kind,resource_id,details) VALUES($1,$2,$3,$4,$5)`, actorID, action, kind, id, raw)
	return err
}
