package core

import (
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"time"
)

type editRequest struct {
	PageHash                            []byte
	ID, State, FromLease, ToLease, Name string
	From, To                            writerPage
	Expires, Available                  time.Time
	Alive, Eligible                     bool
	RetryAfterMs                        int64
}

// A responsive owner can finish an active drag or IME composition. If that
// page disappears, the normal lease expiry still unlocks the canvas.
const availableAt = `greatest(r.created_at+interval '30 seconds',r.deferred_until)`
const editorRequestColumns = `r.request_id::text,r.state,r.from_lease::text,coalesce(r.to_lease::text,''),r.page_hash,
 r.from_actor,r.from_session,r.from_client,r.actor_id,r.session_id,r.client_id,u.display_name,
 r.expires_at,` + availableAt + `,r.expires_at>clock_timestamp(),
 coalesce((r.grant_stamp=collaboration.canvas_handoff_grants(r.project_id) AND NOT u.disabled AND collaboration.project_role(r.project_id,r.actor_id) IN ('OWNER','EDITOR')
 AND EXISTS (SELECT 1 FROM public.sessions s WHERE s.id=r.session_id AND s.user_id=r.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())),false),
 greatest(0,ceil(extract(epoch from (` + availableAt + `-clock_timestamp()))*1000))::bigint`
const editorRequestFrom = ` FROM collaboration.canvas_edit_requests r JOIN public.users u ON u.id=r.actor_id `

func scanEditRequest(row pgx.Row) (v editRequest, err error) {
	err = row.Scan(&v.ID, &v.State, &v.FromLease, &v.ToLease, &v.PageHash, &v.From.Actor, &v.From.Session, &v.From.Client, &v.To.Actor, &v.To.Session, &v.To.Client, &v.Name, &v.Expires, &v.Available, &v.Alive, &v.Eligible, &v.RetryAfterMs)
	return
}
func (x *writerScope) findRequest(id string) (editRequest, error) {
	return scanEditRequest(x.tx.QueryRow(x.ctx, "SELECT "+editorRequestColumns+editorRequestFrom+"WHERE r.project_id=$1 AND r.request_id=$2", x.pid, id))
}
func (x *writerScope) observedState(r editRequest) string {
	switch r.State {
	case "TRANSFERRED":
		if x.held.ID != r.ToLease || !x.held.Active {
			return "EXPIRED"
		}
	case "PENDING":
		if !r.Alive || !r.Eligible || x.held.ID != "" && r.FromLease != x.held.ID {
			return "EXPIRED"
		}
	}
	return r.State
}
func (x *writerScope) viewRequest(r editRequest) map[string]any {
	return map[string]any{"requestId": r.ID, "state": x.observedState(r), "userId": r.To.Actor, "displayName": r.Name, "sameAccount": r.From.Actor == r.To.Actor, "expiresAt": iso(r.Expires), "availableAt": iso(r.Available), "retryAfterMs": r.RetryAfterMs}
}
func (x *writerScope) status() (map[string]any, error) {
	h := x.held
	result := map[string]any{"projectId": x.pid, "state": "FREE", "incoming": []map[string]any{}}
	if h.Active {
		result["holder"] = map[string]any{"userId": h.Actor, "displayName": h.Name, "canApprove": len(h.PageHash) > 0}
		if x.owns() {
			for k, v := range x.receipt(h, "") {
				result[k] = v
			}
			if !h.NeedsSync {
				rows, err := x.tx.Query(x.ctx, "SELECT "+editorRequestColumns+editorRequestFrom+`WHERE r.project_id=$1 AND r.from_lease=$2 AND r.state='PENDING' AND r.expires_at>clock_timestamp() ORDER BY r.created_at,r.request_id LIMIT 32`, x.pid, h.ID)
				if err != nil {
					return nil, err
				}
				inbox := []map[string]any{}
				for rows.Next() {
					v, e := scanEditRequest(rows)
					if e != nil {
						rows.Close()
						return nil, e
					}
					if v.Eligible {
						inbox = append(inbox, x.viewRequest(v))
					}
				}
				rows.Close()
				if e := rows.Err(); e != nil {
					return nil, e
				}
				result["incoming"] = inbox
			}
		} else {
			result["state"] = "OCCUPIED"
		}
	}
	v, err := scanEditRequest(x.tx.QueryRow(x.ctx, "SELECT "+editorRequestColumns+editorRequestFrom+`WHERE r.project_id=$1 AND r.actor_id=$2 AND r.session_id=$3 AND r.client_id=$4 ORDER BY r.created_at DESC,r.request_id LIMIT 1`, x.pid, x.page.Actor, x.page.Session, x.page.Client))
	if err == nil {
		if collaboration.MatchCanvasProof(v.PageHash, x.proof) {
			result["outgoing"] = x.viewRequest(v)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return result, nil
}
func (x *writerScope) markRequest(id, state string) error {
	_, err := x.tx.Exec(x.ctx, `UPDATE collaboration.canvas_edit_requests SET state=$3 WHERE project_id=$1 AND request_id=$2`, x.pid, id, state)
	return err
}
func requestMissing() error {
	return httpapi.Fail(404, "EDIT_REQUEST_NOT_FOUND", "此编辑申请已失效。")
}

func (s *Server) requestCanvasWriter(w http.ResponseWriter, r *http.Request) error {
	return s.writerEndpoint(w, r, func(x *writerScope, b writerBody) (any, error) {
		if x.proof == "" || !validUUID(b.RequestID) {
			return nil, httpapi.Fail(400, "INVALID_EDIT_REQUEST", "缺少有效的编辑申请标识。")
		}
		saved, err := x.findRequest(b.RequestID)
		if err == nil {
			if saved.To != x.page || !collaboration.MatchCanvasProof(saved.PageHash, x.proof) {
				return nil, requestMissing()
			}
			if x.observedState(saved) == "PENDING" && (!x.held.Active || !b.OnlyIfFree && saved.From.Actor == x.page.Actor && saved.RetryAfterMs == 0) {
				if e := x.transfer(saved); e != nil {
					return nil, e
				}
			}
			return x.status()
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if x.owns() || (b.OnlyIfFree && x.held.Active) {
			return x.status()
		}
		// An authenticated editor deliberately applying for handoff also
		// establishes the new protocol before a legacy incumbent exits.
		if err = x.enableHandoffs(); err != nil {
			return nil, err
		}
		// Keep only this page's newest application. Between the same actor's own
		// devices, one foreground intent supersedes older claimants to that tenure.
		_, err = x.tx.Exec(x.ctx, `UPDATE collaboration.canvas_edit_requests SET state='CANCELED'
 WHERE project_id=$1 AND state='PENDING' AND actor_id=$2
 AND ((session_id=$3 AND client_id=$4) OR from_lease::text=$5)`, x.pid, x.page.Actor, x.page.Session, x.page.Client, x.held.ID)
		if err != nil {
			return nil, err
		}
		if _, err = x.tx.Exec(x.ctx, `DELETE FROM collaboration.canvas_edit_requests WHERE project_id=$1 AND expires_at<clock_timestamp()-interval '1 day'`, x.pid); err != nil {
			return nil, err
		}
		var count int
		if err = x.tx.QueryRow(x.ctx, `SELECT count(*) FROM collaboration.canvas_edit_requests WHERE project_id=$1 AND state='PENDING' AND expires_at>clock_timestamp() AND from_lease::text=$2`, x.pid, x.held.ID).Scan(&count); err != nil {
			return nil, err
		}
		if count >= 32 {
			return nil, httpapi.Fail(429, "EDIT_REQUEST_LIMIT", "当前编辑申请较多，请稍后再试。")
		}
		from := x.held
		if from.ID == "" {
			from.writerPage = x.page
			from.ID = uuid.NewString()
		}
		_, err = x.tx.Exec(x.ctx, `INSERT INTO collaboration.canvas_edit_requests(project_id,request_id,from_lease,from_actor,from_session,from_client,actor_id,session_id,client_id,page_hash,grant_stamp,state,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,collaboration.canvas_handoff_grants($1),'PENDING',clock_timestamp()+interval '90 seconds')`, x.pid, b.RequestID, from.ID, from.Actor, from.Session, from.Client, x.page.Actor, x.page.Session, x.page.Client, collaboration.CanvasProofDigest(x.proof))
		if err != nil {
			return nil, err
		}
		if !x.held.Active {
			req, e := x.findRequest(b.RequestID)
			if e != nil {
				return nil, e
			}
			if e = x.transfer(req); e != nil {
				return nil, e
			}
		}
		return x.status()
	})
}

func (s *Server) cancelCanvasWriterRequest(w http.ResponseWriter, r *http.Request) error {
	return s.writerEndpoint(w, r, func(x *writerScope, b writerBody) (any, error) {
		v, e := x.findRequest(b.RequestID)
		if errors.Is(e, pgx.ErrNoRows) {
			return x.status()
		}
		if e != nil {
			return nil, e
		}
		if v.To != x.page || !collaboration.MatchCanvasProof(v.PageHash, x.proof) {
			return nil, requestMissing()
		}
		if v.State == "PENDING" {
			if e = x.markRequest(v.ID, "CANCELED"); e != nil {
				return nil, e
			}
		}
		return x.status()
	})
}

func (s *Server) decideCanvasWriterRequest(w http.ResponseWriter, r *http.Request) error {
	return s.writerEndpoint(w, r, func(x *writerScope, b writerBody) (any, error) {
		if b.Decision != "APPROVE" && b.Decision != "DECLINE" && b.Decision != "DEFER" {
			return nil, httpapi.Fail(400, "INVALID_EDIT_REQUEST", "编辑申请决定无效。")
		}
		v, e := x.findRequest(b.RequestID)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, requestMissing()
		}
		if e != nil {
			return nil, e
		}
		if v.From != x.page {
			return nil, requestMissing()
		}
		// A successful retry is observational; even an old accepted request from a
		// previous A→B→A cycle cannot install another writer.
		if v.State != "PENDING" {
			return x.status()
		}
		if len(x.held.PageHash) == 0 || b.LeaseID != v.FromLease || !x.owns() || x.held.ID != v.FromLease || x.held.NeedsSync || x.observedState(v) != "PENDING" {
			return nil, httpapi.Fail(409, "EDIT_REQUEST_EXPIRED", "编辑申请或原编辑会话已结束。")
		}
		if b.Decision == "DEFER" {
			if v.From.Actor != v.To.Actor {
				return nil, httpapi.Fail(400, "INVALID_EDIT_REQUEST", "仅同账号页面可延后自动交接。")
			}
			// The request and this owner's tenure were checked under the project lock.
			_, e = x.tx.Exec(x.ctx, `UPDATE collaboration.canvas_edit_requests SET deferred_until=clock_timestamp()+interval '30 seconds', expires_at=clock_timestamp()+interval '90 seconds' WHERE project_id=$1 AND request_id=$2`, x.pid, v.ID)
			if e != nil {
				return nil, e
			}
		} else if b.Decision == "DECLINE" {
			if v.From.Actor == v.To.Actor {
				return nil, httpapi.Fail(409, "SELF_HANDOFF_AUTOMATIC", "同账号页面之间自动交接。")
			}
			if e = x.markRequest(v.ID, "DECLINED"); e != nil {
				return nil, e
			}
		} else if e = x.transfer(v); e != nil {
			return nil, e
		}
		return x.status()
	})
}

// The caller has locked the canonical project and its team grants. Recheck the
// waiting account and lock its live login session before moving the one writer.
func (x *writerScope) transfer(v editRequest) error {
	var active bool
	e := x.tx.QueryRow(x.ctx, `SELECT true FROM public.users u JOIN public.sessions s ON s.user_id=u.id
 WHERE u.id=$1 AND s.id=$2 AND NOT u.disabled AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND collaboration.project_role($3,u.id) IN ('OWNER','EDITOR') FOR SHARE OF u,s`, v.To.Actor, v.To.Session, x.pid).Scan(&active)
	if errors.Is(e, pgx.ErrNoRows) {
		return httpapi.Fail(409, "EDIT_REQUEST_EXPIRED", "申请页面已退出或不再拥有编辑权限。")
	}
	if e != nil {
		return e
	}
	// Recheck the deadline after any session-row wait. Installing the writer
	// and completing the request share this project transaction.
	tag, e := x.tx.Exec(x.ctx, `UPDATE collaboration.canvas_edit_requests SET state='TRANSFERRED' WHERE project_id=$1 AND request_id=$2 AND state='PENDING' AND expires_at>clock_timestamp()`, x.pid, v.ID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return httpapi.Fail(409, "EDIT_REQUEST_EXPIRED", "编辑申请已过期。")
	}
	if _, e = x.newLease(v.To, true, false, v.PageHash); e != nil {
		return e
	}
	if _, e = x.tx.Exec(x.ctx, `UPDATE collaboration.canvas_edit_requests SET state='TRANSFERRED',to_lease=$3 WHERE project_id=$1 AND request_id=$2`, x.pid, v.ID, x.held.ID); e != nil {
		return e
	}
	return nil
}
