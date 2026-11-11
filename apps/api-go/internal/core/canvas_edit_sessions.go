package core

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
)

type writerPage struct{ Actor, Session, Client string }
type writerLease struct {
	writerPage
	ID, Name                   string
	Expires                    time.Time
	Active, NeedsSync          bool
	ResumeHash, PageHash, Salt []byte
}
type writerScope struct {
	proof    string
	ctx      context.Context
	tx       pgx.Tx
	pid      string
	revision int64
	page     writerPage
	held     writerLease
}
type writerBody struct {
	PageProof   string `json:"pageProof,omitempty"`
	ClientID    string `json:"clientId"`
	LeaseID     string `json:"leaseId,omitempty"`
	RequireSync bool   `json:"requireSync,omitempty"`
	OnlyIfFree  bool   `json:"onlyIfFree,omitempty"`
	ResumeToken string `json:"resumeToken,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	Decision    string `json:"decision,omitempty"`
	Revision    *int64 `json:"revision,omitempty"`
}

func writerGone() error {
	return httpapi.Fail(409, "EDIT_SESSION_EXPIRED", "此页的编辑会话已结束，请重新连接。")
}
func writerSyncNeeded() error {
	return httpapi.Fail(409, "CANVAS_SYNC_REQUIRED", "画布已更新，请载入最新内容后再编辑。")
}
func validUUID(s string) bool {
	id, err := uuid.Parse(s)
	return err == nil && id.String() == s && id != uuid.Nil
}
func readWriterLease(ctx context.Context, tx pgx.Tx, pid string) (h writerLease, err error) {
	err = tx.QueryRow(ctx, `SELECT e.actor_id,e.session_id,e.client_id,e.lease_id::text,u.display_name,e.expires_at,e.needs_sync,e.resume_hash,e.page_hash,e.resume_salt,
 e.expires_at>clock_timestamp() AND NOT u.disabled AND coalesce(collaboration.project_role(e.project_id,e.actor_id) IN ('OWNER','EDITOR'),false)
 AND NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id=e.session_id AND (s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp()))
 FROM collaboration.canvas_edit_sessions e JOIN public.users u ON u.id=e.actor_id WHERE e.project_id=$1`, pid).Scan(&h.Actor, &h.Session, &h.Client, &h.ID, &h.Name, &h.Expires, &h.NeedsSync, &h.ResumeHash, &h.PageHash, &h.Salt, &h.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return
}

type writerHandler func(*writerScope, writerBody) (any, error)

func (s *Server) writerEndpoint(w http.ResponseWriter, r *http.Request, fn writerHandler) error {
	var b writerBody
	readonly := r.Method == http.MethodGet
	client := r.Header.Get(collaboration.CanvasSessionHeader)
	if len(r.Header.Values(collaboration.CanvasSessionHeader)) != 1 || !validOperationID(client) {
		return httpapi.Fail(400, "INVALID_CANVAS_SESSION", "画布编辑会话无效。")
	}
	if !readonly {
		if err := httpapi.DecodeLimit(w, r, &b, 2048); err != nil {
			return err
		}
		if b.ClientID != client || b.LeaseID != "" && !validUUID(b.LeaseID) || b.RequestID != "" && !validUUID(b.RequestID) || len(b.ResumeToken) > 100 {
			return httpapi.Fail(400, "INVALID_CANVAS_SESSION", "画布编辑会话无效。")
		}
	}
	if key := chi.URLParam(r, "requestId"); key != "" {
		if !validUUID(key) || b.RequestID != "" && b.RequestID != key {
			return httpapi.Fail(400, "INVALID_EDIT_REQUEST", "编辑申请标识无效。")
		}
		b.RequestID = key
	}
	proof := r.Header.Get(collaboration.CanvasProofHeader)
	if len(r.Header.Values(collaboration.CanvasProofHeader)) > 1 || b.PageProof != "" && proof != "" && b.PageProof != proof {
		return httpapi.Fail(400, "INVALID_CANVAS_SESSION", "画布页面凭证无效。")
	}
	if proof == "" {
		proof = b.PageProof
	}
	if proof != "" && (!validOperationID(proof) || len(proof) < 32 || proof == client || proof == b.RequestID) {
		return httpapi.Fail(400, "INVALID_CANVAS_SESSION", "画布页面凭证无效。")
	}
	if (b.RequireSync || b.ResumeToken != "") && proof == "" {
		return httpapi.Fail(400, "INVALID_CANVAS_SESSION", "缺少画布页面凭证。")
	}
	id := httpapi.IdentityFrom(r)
	run := func(tx pgx.Tx) (any, error) {
		pid := chi.URLParam(r, "projectId")
		role := collaboration.EDITOR
		if readonly {
			role = collaboration.VIEWER
		}
		if _, e := collaboration.RequireProject(r.Context(), tx, id.UserID, pid, role, !readonly); e != nil {
			return nil, e
		}
		x := &writerScope{proof: proof, ctx: r.Context(), tx: tx, pid: pid, page: writerPage{id.UserID, id.SessionID, client}}
		if e := tx.QueryRow(x.ctx, `SELECT revision FROM public.projects WHERE id=$1`, pid).Scan(&x.revision); e != nil {
			return nil, e
		}
		h, e := readWriterLease(x.ctx, tx, pid)
		if e != nil {
			return nil, e
		}
		x.held = h
		modern := r.Header.Get(collaboration.AccountCanvasHeader) == collaboration.AccountCanvasProtocol
		active, e := collaboration.AccountCanvasEnabled(x.ctx, tx, pid)
		if e != nil {
			return nil, e
		}
		if !active && modern && !readonly && proof != "" && (!h.Active || len(h.PageHash) > 0) {
			if e = x.adoptAccountCanvas(); e != nil {
				return nil, e
			}
			active = true
		}
		if active {
			return x.accountAction(r, b, modern)
		}
		if modern && readonly && (!h.Active || len(h.PageHash) > 0) {
			st, e := x.status()
			if e != nil {
				return nil, e
			}
			st["protocol"] = collaboration.AccountCanvasProtocol
			if h.Active && h.Actor == id.UserID && !x.owns() {
				st["state"] = "FREE"
				st["canJoin"] = true
			}
			return st, nil
		}
		return fn(x, b)
	}
	var out any
	var err error
	if readonly {
		// One consistent, side-effect free view of the holder and the two inboxes.
		tx, e := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		out, err = run(tx)
		if err == nil {
			err = tx.Commit(r.Context())
		}
	} else {
		out, err = database.Transaction(r.Context(), s.db, run)
	}
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return httpapi.OK(w, r, 200, out)
}
func (s *Server) canvasWriterStatus(w http.ResponseWriter, r *http.Request) error {
	return s.writerEndpoint(w, r, func(x *writerScope, _ writerBody) (any, error) { return x.status() })
}
func (s *Server) acquireCanvasEditSession(w http.ResponseWriter, r *http.Request) error {
	return s.writerEndpoint(w, r, func(x *writerScope, b writerBody) (any, error) {
		h := x.held
		if b.ResumeToken != "" {
			digest := sha256.Sum256([]byte(b.ResumeToken))
			if b.LeaseID != "" || !h.Active || h.Actor != x.page.Actor || h.Session != x.page.Session || h.Client == x.page.Client || subtle.ConstantTimeCompare(digest[:], h.ResumeHash) != 1 {
				return nil, httpapi.Fail(409, "EDIT_RESUME_INVALID", "此页恢复凭证已失效，请检查当前编辑状态。")
			}
			return x.newLease(x.page, true, true, collaboration.CanvasProofDigest(x.proof))
		}
		if b.LeaseID != "" && (!h.Active || h.ID != b.LeaseID || h.writerPage != x.page) {
			return nil, writerGone()
		}
		// Let the current legacy writer finish and renew until release or expiry.
		// Competing old documents never enter the upgraded acquire loop.
		if x.proof == "" && !x.owns() {
			if err := collaboration.AllowLegacyCanvasWriter(x.ctx, x.tx, x.pid); err != nil {
				return nil, err
			}
		}
		if !h.Active {
			var retired bool
			if err := x.tx.QueryRow(x.ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.canvas_retired_pages WHERE project_id=$1 AND actor_id=$2 AND session_id=$3 AND client_id=$4)`, x.pid, x.page.Actor, x.page.Session, x.page.Client).Scan(&retired); err != nil {
				return nil, err
			}
			if retired {
				return nil, writerGone()
			}
			return x.newLease(x.page, b.RequireSync || x.proof != "", true, collaboration.CanvasProofDigest(x.proof))
		}
		if !x.owns() {
			return nil, collaboration.ProjectEditOccupied(h.Name)
		}
		// An unconfirmed recipient has a fixed reservation, even if a broken
		// client keeps renewing while failing to load the current snapshot.
		if !h.NeedsSync {
			err := x.tx.QueryRow(x.ctx, `UPDATE collaboration.canvas_edit_sessions SET expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE project_id=$1 RETURNING expires_at`, x.pid).Scan(&h.Expires)
			if err != nil {
				return nil, err
			}
		}
		return x.receipt(h, ""), nil
	})
}
func (s *Server) releaseCanvasEditSession(w http.ResponseWriter, r *http.Request) error {
	return s.writerEndpoint(w, r, func(x *writerScope, b writerBody) (any, error) {
		released := false
		h := x.held
		if h.ID != "" && h.writerPage == x.page && collaboration.MatchCanvasProof(h.PageHash, x.proof) && (b.LeaseID == h.ID || len(h.PageHash) == 0 && b.LeaseID == "") {
			if _, err := x.tx.Exec(x.ctx, `INSERT INTO collaboration.canvas_retired_pages(project_id,actor_id,session_id,client_id)VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, x.pid, h.Actor, h.Session, h.Client); err != nil {
				return nil, err
			}
			_, err := x.tx.Exec(x.ctx, `DELETE FROM collaboration.canvas_edit_sessions WHERE project_id=$1`, x.pid)
			if err != nil {
				return nil, err
			}
			released = true
		}
		return map[string]any{"projectId": x.pid, "clientId": x.page.Client, "released": released}, nil
	})
}
func (s *Server) confirmCanvasWriter(w http.ResponseWriter, r *http.Request) error {
	return s.writerEndpoint(w, r, func(x *writerScope, b writerBody) (any, error) {
		h := x.held
		if !x.owns() || b.LeaseID != h.ID {
			return nil, writerGone()
		}
		if !h.NeedsSync {
			if len(h.PageHash) > 0 && len(h.Salt) > 0 && x.proof != "" {
				return x.receipt(h, resumeCredential(h.Salt, x.proof, h.ID)), nil
			}
			return x.receipt(h, ""), nil
		}
		if b.Revision == nil || *b.Revision != x.revision {
			return nil, writerSyncNeeded()
		}
		token := resumeCredential(h.Salt, x.proof, h.ID)
		hash := collaboration.CanvasProofDigest(token)
		err := x.tx.QueryRow(x.ctx, `UPDATE collaboration.canvas_edit_sessions SET needs_sync=false,resume_hash=$2,expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE project_id=$1 RETURNING expires_at`, x.pid, hash).Scan(&h.Expires)
		if err != nil {
			return nil, err
		}
		h.NeedsSync = false
		return x.receipt(h, token), nil
	})
}
func (x *writerScope) owns() bool {
	return x.held.Active && x.held.writerPage == x.page && collaboration.MatchCanvasProof(x.held.PageHash, x.proof)
}

// Stable for retries by the same authenticated page, new private salt on every
// tenure. A stored hash or a client ID does not disclose the recovery token.
func resumeCredential(salt []byte, proof, id string) string {
	mac := hmac.New(sha256.New, salt)
	mac.Write([]byte("studio/reload/v1:" + id + ":" + proof))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (x *writerScope) receipt(h writerLease, token string) map[string]any {
	state := "HELD"
	if h.NeedsSync {
		state = "SYNC_REQUIRED"
	}
	r := map[string]any{"projectId": x.pid, "clientId": h.Client, "state": state, "leaseId": h.ID, "expiresAt": iso(h.Expires), "ttlSeconds": 30}
	if token != "" {
		r["resumeToken"] = token
	}
	return r
}
func (x *writerScope) enableHandoffs() error {
	_, err := x.tx.Exec(x.ctx, `INSERT INTO collaboration.canvas_writer_protocol(project_id) VALUES($1) ON CONFLICT DO NOTHING`, x.pid)
	return err
}

func (x *writerScope) newLease(page writerPage, needsSync, deliverToken bool, pageHash []byte) (map[string]any, error) {
	if len(pageHash) > 0 {
		if err := x.enableHandoffs(); err != nil {
			return nil, err
		}
	}
	if x.held.ID != "" && x.held.writerPage != page {
		if _, err := x.tx.Exec(x.ctx, `INSERT INTO collaboration.canvas_retired_pages(project_id,actor_id,session_id,client_id)VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, x.pid, x.held.Actor, x.held.Session, x.held.Client); err != nil {
			return nil, err
		}
	}
	if _, err := x.tx.Exec(x.ctx, `DELETE FROM collaboration.canvas_retired_pages retired WHERE project_id=$1 AND ((actor_id=$2 AND session_id=$3 AND client_id=$4) OR (retired_at<clock_timestamp()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=retired.session_id AND s.user_id=retired.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())))`, x.pid, page.Actor, page.Session, page.Client); err != nil {
		return nil, err
	}
	h := writerLease{writerPage: page, ID: uuid.NewString(), Active: true, NeedsSync: needsSync}
	h.PageHash = pageHash
	h.Salt = make([]byte, 32)
	if _, err := rand.Read(h.Salt); err != nil {
		return nil, err
	}
	var token string
	var hash []byte
	if deliverToken && x.proof != "" {
		token = resumeCredential(h.Salt, x.proof, h.ID)
		hash = collaboration.CanvasProofDigest(token)
	}
	err := x.tx.QueryRow(x.ctx, `INSERT INTO collaboration.canvas_edit_sessions(project_id,actor_id,session_id,client_id,expires_at,lease_id,resume_hash,needs_sync,page_hash,resume_salt)
 VALUES($1,$2,$3,$4,clock_timestamp()+interval '30 seconds',$5,$6,$7,$8,$9)
 ON CONFLICT(project_id) DO UPDATE SET actor_id=EXCLUDED.actor_id,session_id=EXCLUDED.session_id,client_id=EXCLUDED.client_id,expires_at=EXCLUDED.expires_at,lease_id=EXCLUDED.lease_id,resume_hash=EXCLUDED.resume_hash,needs_sync=EXCLUDED.needs_sync,page_hash=EXCLUDED.page_hash,resume_salt=EXCLUDED.resume_salt,updated_at=clock_timestamp() RETURNING expires_at`, x.pid, page.Actor, page.Session, page.Client, h.ID, hash, needsSync, h.PageHash, h.Salt).Scan(&h.Expires)
	if err != nil {
		return nil, err
	}
	if _, err = x.tx.Exec(x.ctx, `DELETE FROM collaboration.canvas_node_leases WHERE project_id=$1`, x.pid); err != nil {
		return nil, err
	}
	if err = x.tx.QueryRow(x.ctx, `SELECT display_name FROM public.users WHERE id=$1`, page.Actor).Scan(&h.Name); err != nil {
		return nil, err
	}
	x.held = h
	if _, err = x.tx.Exec(x.ctx, `UPDATE collaboration.canvas_edit_requests SET state='EXPIRED' WHERE project_id=$1 AND state='PENDING'`, x.pid); err != nil {
		return nil, err
	}
	if !deliverToken {
		token = ""
	}
	return x.receipt(h, token), nil
}
