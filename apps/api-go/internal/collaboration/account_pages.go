package collaboration

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/httpapi"
)

const AccountCanvasProtocol = "account-pages-v1"
const AccountCanvasHeader = "X-STUDIO-Canvas-Protocol"

// Also used by the old business routes. A client cannot opt out of a project
// fence by dropping the protocol header or sending another account's page ID.
func AccountCanvasEnabled(ctx context.Context, db DB, project string) (bool, error) {
	var enabled bool
	err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.canvas_writer_protocol WHERE project_id=$1 AND account_pages)`, project).Scan(&enabled)
	return enabled, err
}
func checkAccountCanvasWrite(ctx context.Context, db DB, project string, id httpapi.Identity, client string) (bool, error) {
	var actor, name, lease string
	var proof []byte
	var ready bool
	err := db.QueryRow(ctx, `SELECT a.actor_id,u.display_name,coalesce(p.lease_id::text,''),p.page_hash,coalesce(NOT p.needs_sync,false)
 FROM collaboration.canvas_account_writers a JOIN public.users u ON u.id=a.actor_id
 LEFT JOIN collaboration.canvas_account_pages p ON p.project_id=a.project_id AND p.session_id=$2 AND p.client_id=$3
 AND p.expires_at>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=p.session_id AND (s.user_id<>a.actor_id OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp()))
 WHERE a.project_id=$1 AND NOT u.disabled AND collaboration.project_role(a.project_id,a.actor_id) IN ('OWNER','EDITOR')
 AND (a.handoff_until IS NULL OR a.handoff_until>clock_timestamp())`, project, id.SessionID, client).Scan(&actor, &name, &lease, &proof, &ready)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if err == nil && actor != id.UserID {
		return true, ProjectEditOccupied(name)
	}
	cred, _ := ctx.Value(canvasProofKey{}).(canvasWriteCredential)
	if lease == "" || cred.lease != lease || !MatchCanvasProof(proof, cred.proof) {
		return true, httpapi.Fail(409, "EDIT_SESSION_EXPIRED", "此页的编辑连接已失效，正在重新连接。")
	}
	if !ready {
		return true, httpapi.Fail(409, "CANVAS_SYNC_REQUIRED", "请先载入最新画布再编辑。")
	}
	return true, nil
}

func LegacyCanvasPageUpdateRequired() error {
	return httpapi.Fail(409, "CANVAS_PAGE_UPDATE_REQUIRED", "当前页面使用旧版画布，无法验证编辑凭据。请保留此页，在新标签页打开画布以继续编辑。")
}

// ConsumeExpiredSnapshotBase allows one final CAS save after a paused page's
// deadline, without extending the lease or granting a business operation.
// The caller holds the project lock and already matched the strong If-Match.
// Losing the lock race to even one subsequent write invalidates this base.
func ConsumeExpiredSnapshotBase(ctx context.Context, db DB, project string, id httpapi.Identity, client string, revision int) (bool, error) {
	cred, ok := ctx.Value(canvasProofKey{}).(canvasWriteCredential)
	if !ok || cred.lease == "" || cred.proof == "" {
		return false, nil
	}
	var consumed bool
	err := db.QueryRow(ctx, `UPDATE collaboration.canvas_account_pages p SET snapshot_base=NULL
 FROM collaboration.canvas_account_writers a, public.sessions s
 WHERE a.project_id=p.project_id AND a.actor_id=$2 AND a.handoff_id IS NULL
   AND p.project_id=$1 AND p.session_id=$3 AND p.client_id=$4 AND p.page_hash=$5 AND p.lease_id::text=$6
   AND p.snapshot_base=$7 AND NOT p.needs_sync
   AND p.expires_at<=clock_timestamp() AND p.expires_at>clock_timestamp()-interval '60 seconds'
   AND s.id=$3 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM collaboration.canvas_account_pages sibling WHERE sibling.project_id=p.project_id AND sibling.expires_at>clock_timestamp())
   AND NOT EXISTS(SELECT 1 FROM collaboration.canvas_edit_requests r WHERE r.project_id=p.project_id AND r.from_lease=a.term_id AND r.state='PENDING' AND r.expires_at>clock_timestamp())
 RETURNING true`, project, id.UserID, id.SessionID, client, CanvasProofDigest(cred.proof), cred.lease, revision).Scan(&consumed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return consumed, err
}
