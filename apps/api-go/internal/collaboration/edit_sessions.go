package collaboration

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/httpapi"
)

// Caller holds the canonical project row lock. An exclusive writer replaces
// per-node occupancy for new single-editor canvases and fences old clients.
func CheckProjectEditSession(ctx context.Context, db DB, project string, identity httpapi.Identity, client string, required bool) (bool, error) {
	if account, e := AccountCanvasEnabled(ctx, db, project); e != nil {
		return false, e
	} else if account {
		return checkAccountCanvasWrite(ctx, db, project, identity, client)
	}
	var actor, session, page, name, lease string
	credential, modernRequest := ctx.Value(canvasProofKey{}).(canvasWriteCredential)
	var needsSync bool
	var proofHash []byte
	err := db.QueryRow(ctx, `SELECT e.actor_id,e.session_id,e.client_id,u.display_name,e.needs_sync,e.page_hash,e.lease_id::text FROM collaboration.canvas_edit_sessions e JOIN public.users u ON u.id=e.actor_id WHERE e.project_id=$1 AND e.expires_at>clock_timestamp() AND NOT u.disabled AND NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id=e.session_id AND (s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp())) AND collaboration.project_role(e.project_id,e.actor_id) IN ('OWNER','EDITOR')`, project).Scan(&actor, &session, &page, &name, &needsSync, &proofHash, &lease)
	if errors.Is(err, pgx.ErrNoRows) {
		// Older snapshot and task endpoints otherwise fall back to node leases
		// on a free canvas. That fallback only applies to pre-handoff projects.
		if !modernRequest {
			if err := AllowLegacyCanvasWriter(ctx, db, project); err != nil {
				return false, err
			}
		}
		if required || modernRequest {
			return false, httpapi.Fail(409, "EDIT_SESSION_EXPIRED", "画布编辑连接已过期，正在重新连接，请稍后继续。")
		}
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !MatchCanvasProof(proofHash, credential.proof) || actor != identity.UserID || session != identity.SessionID || client == "" || page != client {
		return true, ProjectEditOccupied(name)
	}
	// A page can lose the writer and regain it with the exact same page proof.
	// The lease ID frozen with a business request distinguishes those tenures.
	if (len(proofHash) > 0 || credential.lease != "") && credential.lease != lease {
		return true, httpapi.Fail(409, "EDIT_SESSION_EXPIRED", "当前编辑任期已结束，请同步最新画布后再操作。")
	}
	if needsSync {
		return true, httpapi.Fail(409, "CANVAS_SYNC_REQUIRED", "请先载入最新画布再编辑。")
	}
	return true, nil
}

func ProjectEditOccupied(name string) error {
	name = safePresenceName(name)
	if name == "" {
		name = "其他成员"
	}
	err := httpapi.Fail(409, "PROJECT_EDIT_OCCUPIED", fmt.Sprintf("%s正在编辑此画布，请等待对方退出后再编辑。", name))
	// Do not disclose the page identity or any reload credential.
	return err
}

// Caller holds the canonical project row lock. Use a forbidden response so
// deployed legacy clients show the server message and stop their acquire loop.
func AllowLegacyCanvasWriter(ctx context.Context, db DB, project string) error {
	var upgraded bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.canvas_writer_protocol WHERE project_id=$1)`, project).Scan(&upgraded); err != nil {
		return err
	}
	if upgraded {
		return httpapi.Fail(403, "CANVAS_CLIENT_UPGRADE_REQUIRED", "此画布已启用新版编辑交接，请刷新此页面后继续编辑。")
	}
	return nil
}
