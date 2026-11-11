package core

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
)

type accountCanvas struct {
	*writerScope
	actor, name, term, drainID string
	drainDeadline, observedAt  time.Time
	live, ready                int
	local                      writerLease
}

func (x *writerScope) adoptAccountCanvas() error {
	if _, err := x.tx.Exec(x.ctx, `INSERT INTO collaboration.canvas_writer_protocol(project_id,account_pages) VALUES($1,true)
 ON CONFLICT(project_id) DO UPDATE SET account_pages=true`, x.pid); err != nil {
		return err
	}
	h := x.held
	if h.Active {
		if _, err := x.tx.Exec(x.ctx, `INSERT INTO collaboration.canvas_account_writers(project_id,actor_id,term_id)VALUES($1,$2,$3)`, x.pid, h.Actor, h.ID); err != nil {
			return err
		}
		if _, err := x.tx.Exec(x.ctx, `INSERT INTO collaboration.canvas_account_pages(project_id,session_id,client_id,page_hash,lease_id,needs_sync,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7)`, x.pid, h.Session, h.Client, h.PageHash, h.ID, h.NeedsSync, h.Expires); err != nil {
			return err
		}
	}
	_, err := x.tx.Exec(x.ctx, `DELETE FROM collaboration.canvas_edit_sessions WHERE project_id=$1`, x.pid)
	return err
}

const activeAccountPage = `p.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=p.session_id AND (s.user_id<>a.actor_id OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp()))`

func (a *accountCanvas) read() error {
	a.actor = ""
	a.term = ""
	a.drainID = ""
	a.live = 0
	a.ready = 0
	a.local = writerLease{}
	a.held = writerLease{}
	err := a.tx.QueryRow(a.ctx, `SELECT a.actor_id,u.display_name,a.term_id::text,coalesce(a.handoff_id::text,''),coalesce(a.handoff_until,'epoch'::timestamptz),
 count(p.lease_id),count(p.lease_id) FILTER (WHERE NOT p.needs_sync)
 FROM collaboration.canvas_account_writers a JOIN public.users u ON u.id=a.actor_id
 LEFT JOIN collaboration.canvas_account_pages p ON p.project_id=a.project_id AND `+activeAccountPage+`
 WHERE a.project_id=$1 AND NOT u.disabled AND collaboration.project_role(a.project_id,a.actor_id) IN ('OWNER','EDITOR')
 GROUP BY a.project_id,u.display_name`, a.pid).Scan(&a.actor, &a.name, &a.term, &a.drainID, &a.drainDeadline, &a.live, &a.ready)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	a.held = writerLease{writerPage: writerPage{Actor: a.actor}, ID: a.term, Name: a.name, Active: a.live > 0}
	if a.actor != a.page.Actor {
		return nil
	}
	l := writerLease{writerPage: a.page, Name: a.name}
	err = a.tx.QueryRow(a.ctx, `SELECT p.lease_id::text,p.page_hash,p.needs_sync,p.expires_at,clock_timestamp() FROM collaboration.canvas_account_pages p JOIN collaboration.canvas_account_writers a USING(project_id)
 WHERE p.project_id=$1 AND p.session_id=$2 AND p.client_id=$3 AND `+activeAccountPage, a.pid, a.page.Session, a.page.Client).Scan(&l.ID, &l.PageHash, &l.NeedsSync, &l.Expires, &a.observedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !collaboration.MatchCanvasProof(l.PageHash, a.proof) {
		return nil
	}
	l.Active = true
	a.local = l
	return nil
}
func (a *accountCanvas) receipt() map[string]any {
	r := a.writerScope.receipt(a.local, "")
	r["protocol"] = collaboration.AccountCanvasProtocol
	r["expiresInMs"] = max(int64(0), min(int64(30000), a.local.Expires.Sub(a.observedAt).Milliseconds()))
	return r
}
func (a *accountCanvas) status() (map[string]any, error) {
	// GET never writes. If the recipient was revoked, canceled, or timed out
	// while every former page was waiting, advertise the effective free/joinable
	// state so a subsequent POST clears the expired drain under the project lock.
	abandoned := false
	if a.drainID != "" {
		v, e := a.findRequest(a.drainID)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if e != nil || !v.Alive || !v.Eligible || v.FromLease != a.term || v.State != "PENDING" {
			a.drainID = ""
			abandoned = true
		}
	}
	st := map[string]any{"projectId": a.pid, "state": "FREE", "protocol": collaboration.AccountCanvasProtocol, "incoming": []any{}}
	if abandoned && a.actor == a.page.Actor {
		st["canJoin"] = true
	}
	if a.live > 0 || a.drainID != "" {
		st["holder"] = map[string]any{"userId": a.actor, "displayName": a.name, "canApprove": true}
		switch {
		case a.local.Active && !(a.local.NeedsSync && a.drainID != ""):
			for k, v := range a.receipt() {
				st[k] = v
			}
		case a.actor == a.page.Actor && a.drainID == "":
			st["canJoin"] = true
		default:
			st["state"] = "OCCUPIED"
		}
	}
	if a.drainID != "" && a.actor == a.page.Actor {
		st["accountHandoff"] = true
	}
	if a.local.Active && !a.local.NeedsSync {
		rows, e := a.tx.Query(a.ctx, "SELECT "+editorRequestColumns+editorRequestFrom+`WHERE r.project_id=$1 AND r.from_lease=$2 AND r.from_actor<>r.actor_id AND r.state='PENDING' AND r.expires_at>clock_timestamp() AND ($3='' OR r.request_id::text=$3) ORDER BY r.created_at,r.request_id LIMIT 32`, a.pid, a.term, a.drainID)
		if e != nil {
			return nil, e
		}
		inbox := []map[string]any{}
		for rows.Next() {
			req, e := scanEditRequest(rows)
			if e != nil {
				rows.Close()
				return nil, e
			}
			if req.Eligible {
				v := a.viewRequest(req)
				v["drainRequired"] = a.drainID == req.ID
				inbox = append(inbox, v)
			}
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return nil, e
		}
		st["incoming"] = inbox
	}
	req, e := scanEditRequest(a.tx.QueryRow(a.ctx, "SELECT "+editorRequestColumns+editorRequestFrom+`WHERE r.project_id=$1 AND r.actor_id=$2 AND r.session_id=$3 AND r.client_id=$4 AND r.from_actor<>r.actor_id ORDER BY r.created_at DESC,r.request_id LIMIT 1`, a.pid, a.page.Actor, a.page.Session, a.page.Client))
	if e == nil && collaboration.MatchCanvasProof(req.PageHash, a.proof) {
		st["outgoing"] = a.viewRequest(req)
	} else if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	return st, nil
}
func (a *accountCanvas) startGroup(page writerPage, proof []byte) error {
	if _, e := a.tx.Exec(a.ctx, `DELETE FROM collaboration.canvas_account_writers WHERE project_id=$1`, a.pid); e != nil {
		return e
	}
	if _, e := a.tx.Exec(a.ctx, `INSERT INTO collaboration.canvas_account_writers(project_id,actor_id) VALUES($1,$2)`, a.pid, page.Actor); e != nil {
		return e
	}
	if _, e := a.tx.Exec(a.ctx, `DELETE FROM collaboration.canvas_node_leases WHERE project_id=$1`, a.pid); e != nil {
		return e
	}
	if _, e := a.tx.Exec(a.ctx, `UPDATE collaboration.canvas_edit_requests SET state='EXPIRED' WHERE project_id=$1 AND state='PENDING'`, a.pid); e != nil {
		return e
	}
	return a.addPage(page, proof)
}
func (a *accountCanvas) addPage(page writerPage, proof []byte) error {
	// Retain a page ID with a different proof until the old lease expires.
	if _, e := a.tx.Exec(a.ctx, `DELETE FROM collaboration.canvas_account_pages WHERE project_id=$1 AND expires_at<=clock_timestamp()`, a.pid); e != nil {
		return e
	}
	tag, e := a.tx.Exec(a.ctx, `INSERT INTO collaboration.canvas_account_pages(project_id,session_id,client_id,page_hash,needs_sync,expires_at)
 VALUES($1,$2,$3,$4,true,clock_timestamp()+interval '30 seconds') ON CONFLICT DO NOTHING`, a.pid, page.Session, page.Client, proof)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return writerGone()
	}
	return a.read()
}
func (a *accountCanvas) join(b writerBody) (any, error) {
	if b.ResumeToken != "" {
		return nil, httpapi.Fail(409, "EDIT_RESUME_INVALID", "请用当前账号重新连接此页。")
	}
	if b.LeaseID != "" && (!a.local.Active || a.local.ID != b.LeaseID) {
		return nil, writerGone()
	}
	if a.local.Active {
		if !a.local.NeedsSync || a.drainID == "" {
			// Once approved, other pages get one bounded window to drain. A
			// background heartbeat must not extend it indefinitely.
			// An opening page can renew while its snapshot is making progress,
			// but never extend an admission after another account was approved.
			if err := a.tx.QueryRow(a.ctx, `UPDATE collaboration.canvas_account_pages p SET expires_at=least(clock_timestamp()+interval '30 seconds',coalesce(a.handoff_until,'infinity'::timestamptz))
 FROM collaboration.canvas_account_writers a WHERE a.project_id=p.project_id AND p.project_id=$1 AND p.lease_id=$2 RETURNING p.expires_at,clock_timestamp()`, a.pid, a.local.ID).Scan(&a.local.Expires, &a.observedAt); err != nil {
				return nil, err
			}
		}
		return a.receipt(), nil
	}
	if a.drainID != "" || a.live > 0 && a.actor != a.page.Actor {
		return nil, collaboration.ProjectEditOccupied(a.name)
	}
	proof := collaboration.CanvasProofDigest(a.proof)
	if a.live == 0 {
		if e := a.startGroup(a.page, proof); e != nil {
			return nil, e
		}
	} else if e := a.addPage(a.page, proof); e != nil {
		return nil, e
	}
	return a.receipt(), nil
}
func (a *accountCanvas) release(lease string) (bool, error) {
	if !a.local.Active || a.local.ID != lease {
		return false, nil
	}
	tag, e := a.tx.Exec(a.ctx, `DELETE FROM collaboration.canvas_account_pages WHERE project_id=$1 AND session_id=$2 AND client_id=$3 AND lease_id=$4`, a.pid, a.page.Session, a.page.Client, lease)
	if e != nil {
		return false, e
	}
	return tag.RowsAffected() == 1, a.read()
}
func (a *accountCanvas) confirm(b writerBody) (any, error) {
	if !a.local.Active || a.local.ID != b.LeaseID {
		return nil, writerGone()
	}
	if a.local.NeedsSync {
		if a.drainID != "" {
			return nil, writerGone()
		}
		if b.Revision == nil || *b.Revision != a.revision {
			return nil, writerSyncNeeded()
		}
		if e := a.tx.QueryRow(a.ctx, `UPDATE collaboration.canvas_account_pages SET needs_sync=false,snapshot_base=$3,expires_at=clock_timestamp()+interval '30 seconds' WHERE project_id=$1 AND lease_id=$2 RETURNING expires_at,clock_timestamp()`, a.pid, b.LeaseID, a.revision).Scan(&a.local.Expires, &a.observedAt); e != nil {
			return nil, e
		}
		a.local.NeedsSync = false
	}
	return a.receipt(), nil
}

func (a *accountCanvas) request(b writerBody) (any, error) {
	if !validUUID(b.RequestID) {
		return nil, httpapi.Fail(400, "INVALID_EDIT_REQUEST", "编辑申请编号无效。")
	}
	prior, e := a.findRequest(b.RequestID)
	if e == nil {
		if prior.To != a.page || !collaboration.MatchCanvasProof(prior.PageHash, a.proof) {
			return nil, requestMissing()
		}
		if a.observedState(prior) == "PENDING" && a.live == 0 && a.drainID == "" {
			if e = a.transferAccount(prior); e != nil {
				return nil, e
			}
		}
		return a.status()
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	if a.local.Active {
		return a.status()
	}
	if a.drainID != "" || (b.OnlyIfFree && a.live > 0 && a.actor != a.page.Actor) {
		return a.status()
	}
	if a.live == 0 || a.actor == a.page.Actor {
		if _, e = a.join(writerBody{}); e != nil {
			return nil, e
		}
		return a.status()
	}
	if _, e = a.tx.Exec(a.ctx, `UPDATE collaboration.canvas_edit_requests SET state='CANCELED' WHERE project_id=$1 AND state='PENDING' AND actor_id=$2 AND session_id=$3 AND client_id=$4`, a.pid, a.page.Actor, a.page.Session, a.page.Client); e != nil {
		return nil, e
	}
	var count int
	if e = a.tx.QueryRow(a.ctx, `SELECT count(*) FROM collaboration.canvas_edit_requests WHERE project_id=$1 AND from_lease=$2 AND state='PENDING' AND expires_at>clock_timestamp()`, a.pid, a.term).Scan(&count); e != nil {
		return nil, e
	}
	if count >= 32 {
		return nil, httpapi.Fail(429, "EDIT_REQUEST_LIMIT", "编辑申请较多，请稍后重试。")
	}
	if _, e = a.tx.Exec(a.ctx, `DELETE FROM collaboration.canvas_edit_requests WHERE project_id=$1 AND expires_at<clock_timestamp()-interval '1 day'`, a.pid); e != nil {
		return nil, e
	}
	_, e = a.tx.Exec(a.ctx, `INSERT INTO collaboration.canvas_edit_requests(project_id,request_id,from_lease,from_actor,from_session,from_client,actor_id,session_id,client_id,page_hash,grant_stamp,state,expires_at)
 SELECT a.project_id,$2,a.term_id,a.actor_id,p.session_id,p.client_id,$3,$4,$5,$6,collaboration.canvas_handoff_grants(a.project_id),'PENDING',clock_timestamp()+interval '90 seconds'
 FROM collaboration.canvas_account_writers a JOIN collaboration.canvas_account_pages p USING(project_id) WHERE a.project_id=$1 AND `+activeAccountPage+` ORDER BY p.needs_sync,p.client_id LIMIT 1`, a.pid, b.RequestID, a.page.Actor, a.page.Session, a.page.Client, collaboration.CanvasProofDigest(a.proof))
	if e != nil {
		return nil, e
	}
	return a.status()
}
func (a *accountCanvas) transferAccount(v editRequest) error {
	// Recheck the waiting login and grants in the same transaction that removes
	// all old page terms and installs the recipient's first read-only reservation.
	var ok bool
	e := a.tx.QueryRow(a.ctx, `SELECT true FROM public.sessions s JOIN public.users u ON u.id=s.user_id
 WHERE s.id=$1 AND u.id=$2 AND NOT u.disabled AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND collaboration.project_role($3,u.id) IN ('OWNER','EDITOR') FOR SHARE OF s,u`, v.To.Session, v.To.Actor, a.pid).Scan(&ok)
	if errors.Is(e, pgx.ErrNoRows) {
		return httpapi.Fail(409, "EDIT_REQUEST_EXPIRED", "申请账号已退出或失去编辑权限。")
	}
	if e != nil {
		return e
	}
	if !v.Alive || !v.Eligible || v.FromLease != a.term || v.State != "PENDING" {
		return httpapi.Fail(409, "EDIT_REQUEST_EXPIRED", "编辑申请已失效。")
	}
	if e = a.startGroup(v.To, v.PageHash); e != nil {
		return e
	}
	_, e = a.tx.Exec(a.ctx, `UPDATE collaboration.canvas_edit_requests SET state='TRANSFERRED',to_lease=$3 WHERE project_id=$1 AND request_id=$2`, a.pid, v.ID, a.term)
	return e
}
func (a *accountCanvas) resetDrain() error {
	_, e := a.tx.Exec(a.ctx, `UPDATE collaboration.canvas_account_writers SET handoff_id=NULL,handoff_until=NULL WHERE project_id=$1 AND term_id=$2`, a.pid, a.term)
	if e != nil {
		return e
	}
	return a.read()
}
func (a *accountCanvas) settle() error {
	if a.drainID == "" {
		return nil
	}
	v, e := a.findRequest(a.drainID)
	if errors.Is(e, pgx.ErrNoRows) {
		return a.resetDrain()
	}
	if e != nil {
		return e
	}
	if !v.Alive || !v.Eligible || v.State != "PENDING" || v.FromLease != a.term {
		return a.resetDrain()
	}
	var due bool
	if e = a.tx.QueryRow(a.ctx, `SELECT clock_timestamp()>=$1::timestamptz`, a.drainDeadline).Scan(&due); e != nil {
		return e
	}
	if a.ready == 0 || due {
		return a.transferAccount(v)
	}
	return nil
}
func (a *accountCanvas) decideAccount(b writerBody) (any, error) {
	if !validUUID(b.RequestID) || b.Decision != "APPROVE" && b.Decision != "DECLINE" {
		return nil, httpapi.Fail(400, "INVALID_EDIT_REQUEST", "编辑申请决定无效。")
	}
	v, e := a.findRequest(b.RequestID)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, requestMissing()
	}
	if e != nil {
		return nil, e
	}
	if v.From.Actor != a.page.Actor {
		return nil, requestMissing()
	}
	if v.State != "PENDING" {
		return a.status()
	}
	if !v.Alive || !v.Eligible || v.FromLease != a.term || a.actor != a.page.Actor || !a.local.Active || a.local.NeedsSync || b.LeaseID != a.local.ID || a.drainID != "" && a.drainID != v.ID {
		return nil, httpapi.Fail(409, "EDIT_REQUEST_EXPIRED", "编辑申请或页面任期已结束。")
	}
	if b.Decision == "DECLINE" {
		if a.drainID != "" {
			return nil, httpapi.Fail(409, "EDIT_HANDOFF_IN_PROGRESS", "其他页面正在保存本次交接。")
		}
		if e = a.markRequest(v.ID, "DECLINED"); e != nil {
			return nil, e
		}
		return a.status()
	}
	if a.drainID == "" {
		if _, e = a.tx.Exec(a.ctx, `UPDATE collaboration.canvas_account_writers SET handoff_id=$2,handoff_until=clock_timestamp()+interval '30 seconds' WHERE project_id=$1`, a.pid, v.ID); e != nil {
			return nil, e
		}
	}
	// The caller has finished sending its queue. Removing this page now fences
	// stale business requests and duplicates, including on a canceled handoff.
	if _, e = a.release(b.LeaseID); e != nil {
		return nil, e
	}
	if e = a.settle(); e != nil {
		return nil, e
	}
	return a.status()
}
func (a *accountCanvas) cancelAccount(b writerBody) (any, error) {
	v, e := a.findRequest(b.RequestID)
	if errors.Is(e, pgx.ErrNoRows) {
		return a.status()
	}
	if e != nil {
		return nil, e
	}
	if v.To != a.page || !collaboration.MatchCanvasProof(v.PageHash, a.proof) {
		return nil, requestMissing()
	}
	if v.State == "PENDING" {
		if e = a.markRequest(v.ID, "CANCELED"); e != nil {
			return nil, e
		}
		if a.drainID == v.ID {
			if e = a.resetDrain(); e != nil {
				return nil, e
			}
		}
	}
	return a.status()
}
func (x *writerScope) accountAction(r *http.Request, b writerBody, modern bool) (any, error) {
	a := accountCanvas{writerScope: x}
	if e := a.read(); e != nil {
		return nil, e
	}
	if r.Method == http.MethodGet {
		// The requester's ordinary status poll must be able to discover a drain
		// completed by expiry; it will POST its idempotent request to finish.
		return a.status()
	}
	route := r.URL.Path
	if x.proof == "" || !modern && !a.local.Active {
		// Pre-account pages which already used a fenced writer can join
		// again with the identical session/page secret. They must acquire a
		// new term and confirm a fresh graph before making another write.
		known := false
		opening := r.Method == http.MethodPost && (strings.HasSuffix(route, "/edit-session") && b.RequireSync && b.LeaseID == "" && b.ResumeToken == "" || strings.HasSuffix(route, "/requests") && b.OnlyIfFree)
		if opening && x.proof != "" && a.actor == x.page.Actor && a.drainID == "" {
			if e := x.tx.QueryRow(x.ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.canvas_account_pages p
             JOIN public.sessions s ON s.id=p.session_id AND s.user_id=$5 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
             WHERE p.project_id=$1 AND p.session_id=$2 AND p.client_id=$3 AND p.page_hash=$4 AND p.expires_at<=clock_timestamp()
             AND NOT EXISTS(SELECT 1 FROM collaboration.canvas_edit_requests r WHERE r.project_id=p.project_id AND r.from_lease=$6 AND r.state='PENDING' AND r.expires_at>clock_timestamp()))`,
				x.pid, x.page.Session, x.page.Client, collaboration.CanvasProofDigest(x.proof), x.page.Actor, a.term).Scan(&known); e != nil {
				return nil, e
			}
		}
		if !known {
			return nil, httpapi.Fail(403, "CANVAS_CLIENT_UPGRADE_REQUIRED", "此页面无法验证编辑连接，请先保留原页，在新标签页打开画布以继续编辑。")
		}
	}
	// Cancellation wins if the last page vanished but transfer has not committed.
	if r.Method == http.MethodDelete && strings.Contains(route, "/requests/") {
		return a.cancelAccount(b)
	}
	if e := a.settle(); e != nil {
		return nil, e
	}
	switch {
	case strings.HasSuffix(route, "/ready"):
		return a.confirm(b)
	case strings.HasSuffix(route, "/decision"):
		return a.decideAccount(b)
	case strings.HasSuffix(route, "/requests"):
		return a.request(b)
	case r.Method == http.MethodDelete:
		released, e := a.release(b.LeaseID)
		if e != nil {
			return nil, e
		}
		if e = a.settle(); e != nil {
			return nil, e
		}
		return map[string]any{"projectId": x.pid, "clientId": x.page.Client, "released": released, "protocol": collaboration.AccountCanvasProtocol}, nil
	default:
		return a.join(b)
	}
}
