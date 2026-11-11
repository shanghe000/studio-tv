package core

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
)

// The display URL is an address, never a bearer credential. The cookie is
// host-only, scoped to this login+project path, read-only and bounded by the
// underlying login. Rendering a graph does not authorize reading its bytes.
const canvasMediaHeader = "X-STUDIO-Canvas-Media"
const canvasMediaCookie = "studio_canvas_media"
const canvasMediaRoot = "/storage/canvas-media/"

func canvasMediaScope(uid, sid, project string) string {
	sum := sha256.Sum256([]byte(uid + "\x00" + sid + "\x00" + project))
	return fmt.Sprintf("%x", sum[:16])
}

func (s *Server) offerCanvasMedia(w http.ResponseWriter, r *http.Request, project string) error {
	if r.Header.Get(canvasMediaHeader) != "lazy-v1" {
		return nil
	}
	who := httpapi.IdentityFrom(r)
	if who.SessionID == "" || who.UserID == "" {
		return nil
	}
	ttl := 7 * 24 * time.Hour
	if !who.SessionExpiresAt.IsZero() && time.Until(who.SessionExpiresAt) < ttl {
		ttl = time.Until(who.SessionExpiresAt)
	}
	if ttl < time.Second {
		return httpapi.Fail(401, "UNAUTHENTICATED", "登录已过期。")
	}
	scope := canvasMediaScope(who.UserID, who.SessionID, project)
	grant, err := s.tokens.Sign(map[string]any{"sub": who.UserID, "sid": who.SessionID, "pid": project}, "canvas-media-read", ttl)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: canvasMediaCookie, Value: grant, Path: canvasMediaRoot + scope + "/", HttpOnly: true, Secure: s.cfg.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: int(ttl.Seconds())})
	w.Header().Set(canvasMediaHeader, scope)
	w.Header().Set("Cache-Control", "private, no-store")
	return nil
}

func (s *Server) readCanvasMedia(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	scope, aid := chi.URLParam(r, "scope"), chi.URLParam(r, "assetId")
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return httpapi.Fail(403, "FORBIDDEN", "请从画布中打开素材。")
	}
	if err := requireID(aid); err != nil {
		return err
	}
	cookie, err := r.Cookie(canvasMediaCookie)
	if err != nil {
		return httpapi.Fail(401, "UNAUTHENTICATED", "请重新打开画布。")
	}
	c, err := s.tokens.Verify(cookie.Value, "canvas-media-read")
	if err != nil {
		return err
	}
	uid, _ := c["sub"].(string)
	sid, _ := c["sid"].(string)
	pid, _ := c["pid"].(string)
	if uid == "" || sid == "" || pid == "" || scope != canvasMediaScope(uid, sid, pid) {
		return httpapi.Fail(401, "UNAUTHENTICATED", "画布素材访问无效。")
	}
	r, err = s.signedRequest(r, uid, sid, authorization.TVAccess)
	if err != nil {
		return err
	}
	access, err := collaboration.RequireProject(r.Context(), s.db, uid, pid, collaboration.VIEWER, false)
	if err != nil {
		return err
	}
	// Look up the same-project asset directly after the live project ACL. Legacy
	// cross-project media must actually be referenced by this project or its cover.
	a, err := scanAsset(s.db.QueryRow(r.Context(), "SELECT "+assetColumns+" FROM public.assets WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", aid, access.StorageOwnerID))
	if err != nil {
		return assetLookupError(err)
	}
	if a.ProjectID != pid {
		var graph []byte
		var cover *string
		if err = s.db.QueryRow(r.Context(), "SELECT graph,cover_asset_id FROM public.projects WHERE id=$1 AND deleted_at IS NULL", pid).Scan(&graph, &cover); err != nil {
			return assetLookupError(err)
		}
		refs, err := collaboration.GraphAssetIDs(graph)
		if err != nil {
			return err
		}
		if !refs[aid] && (cover == nil || *cover != aid) {
			return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
		}
		if _, err = accessibleAsset(r.Context(), s.db, uid, aid, false); err != nil {
			return err
		}
	}
	return s.serveAssetBytes(w, r, a)
}

func assetLookupError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	return err
}
