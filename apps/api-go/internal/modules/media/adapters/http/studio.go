package http

import (
	"bytes"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"net/url"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/media/application"
	"studiotv.local/service/api/internal/modules/media/domain"
	"studiotv.local/service/api/internal/security"
	"strconv"
	"strings"
	"time"
)

type SignedRequest func(*http.Request, string, string) (*http.Request, error)
type studioHTTP struct {
	service *application.StudioService
	repo    application.StudioPort
	tokens  *security.Tokens
	cfg     config.Config
	signed  SignedRequest
}

func RegisterStudioRoutes(public, business chi.Router, service *application.StudioService, repo application.StudioPort, cfg config.Config, protect func(string, httpapi.Handler) http.HandlerFunc, signed SignedRequest) {
	h := &studioHTTP{service, repo, security.New(cfg), cfg, signed}
	business.MethodFunc("POST", "/api/v2/studio/projects/{projectId}/render", protect("tv.access", h.submit))
	business.MethodFunc("GET", "/api/v2/studio/renders/{taskId}", protect("tv.access", h.get))
	business.MethodFunc("DELETE", "/api/v2/studio/renders/{taskId}", protect("tv.access", h.remove))
	business.MethodFunc("GET", "/api/v2/studio/projects/{projectId}/renders", protect("tv.access", h.list))
	business.MethodFunc("GET", "/api/v2/studio/projects/{projectId}/renders/file/{filename}", protect("tv.access", h.file))
	business.MethodFunc("POST", "/api/v2/studio/projects/{projectId}/preview-session", protect("tv.access", h.previewSession))
	business.MethodFunc("POST", "/api/v2/studio/projects/{projectId}/file-mutations/edit/*", protect("tv.access", h.edit))
	public.MethodFunc("GET", "/api/v2/studio/preview/{projectId}/{grant}/*", func(w http.ResponseWriter, r *http.Request) {
		if err := h.preview(w, r); err != nil {
			safe := r.Clone(r.Context())
			copyURL := *r.URL
			copyURL.Path = "/api/v2/studio/preview/{projectId}/{grant}/{path}"
			safe.URL = &copyURL
			httpapi.WriteError(w, safe, err)
		}
	})
}
func (h *studioHTTP) edit(w http.ResponseWriter, r *http.Request) error {
	port, ok := h.repo.(application.StudioEditPort)
	if !ok {
		return httpapi.Fail(501, "STUDIO_EDIT_UNAVAILABLE", "项目编辑未配置。")
	}
	var cmd domain.EditCommand
	if err := httpapi.DecodeLimit(w, r, &cmd, 1<<20); err != nil {
		return err
	}
	rev, err := revision(r)
	if err != nil {
		return err
	}
	if len(r.Header.Values("Idempotency-Key")) != 1 {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要有效幂等键。")
	}
	name, err := url.PathUnescape(chi.URLParam(r, "*"))
	if err != nil || !domain.ValidPath(name) {
		return httpapi.Fail(400, "VALIDATION_FAILED", "项目文件路径无效。")
	}
	result, err := port.EditFile(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "projectId"), name, r.Header.Get("Idempotency-Key"), rev, cmd)
	if err != nil {
		return mapError(err)
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%d"`, result.Revision))
	return httpapi.OK(w, r, 200, result)
}
func revision(r *http.Request) (int64, error) {
	if len(r.Header.Values("If-Match")) != 1 {
		return 0, httpapi.Fail(428, "PRECONDITION_REQUIRED", "需要当前项目版本。")
	}
	v := r.Header.Get("If-Match")
	if len(v) < 3 || v[0] != '"' || v[len(v)-1] != '"' {
		return 0, httpapi.Fail(400, "VALIDATION_FAILED", "版本格式无效。")
	}
	n, e := strconv.ParseInt(v[1:len(v)-1], 10, 64)
	if e != nil || n < 1 {
		return 0, httpapi.Fail(400, "VALIDATION_FAILED", "版本格式无效。")
	}
	return n, nil
}
func (h *studioHTTP) submit(w http.ResponseWriter, r *http.Request) error {
	var cmd domain.RenderCommand
	if err := httpapi.DecodeLimit(w, r, &cmd, 8192); err != nil {
		return err
	}
	rev, err := revision(r)
	if err != nil {
		return err
	}
	if len(r.Header.Values("Idempotency-Key")) != 1 {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要有效幂等键。")
	}
	task, err := h.service.Submit(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "projectId"), r.Header.Get("Idempotency-Key"), rev, cmd)
	if err != nil {
		return mapError(err)
	}
	w.Header().Set("Location", "/api/v2/studio/renders/"+task.ID)
	w.Header().Set("ETag", fmt.Sprintf(`"%d"`, task.Revision))
	return httpapi.OK(w, r, 202, map[string]any{"jobId": task.ID})
}
func (h *studioHTTP) get(w http.ResponseWriter, r *http.Request) error {
	t, err := h.service.Get(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "taskId"))
	if err != nil {
		return mapError(err)
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%d"`, t.Revision))
	return httpapi.OK(w, r, 200, renderDTO(t))
}
func renderDTO(t execution.Task) map[string]any {
	state := t.State
	if state == "CANCELED" {
		state = "CANCELLED"
	}
	progress := 0
	if state == "SUCCEEDED" {
		progress = 100
	}
	data := map[string]any{"id": t.ID, "projectId": t.TargetID, "status": state, "progress": progress, "revision": t.Revision, "createdAt": t.CreatedAt, "testMode": false}
	if t.ErrorCode != nil {
		data["error"] = *t.ErrorCode
	}
	for _, p := range t.Plans {
		for _, o := range p.Outputs {
			data["durationMs"] = o.DurationMs
			if t.State == "SUCCEEDED" {
				format := "mp4"
				if o.MimeType == "video/webm" {
					format = "webm"
				} else if o.MimeType == "video/quicktime" {
					format = "mov"
				}
				data["filename"] = t.ID + "." + format
			}
		}
	}
	return data
}
func (h *studioHTTP) remove(w http.ResponseWriter, r *http.Request) error {
	rev, err := revision(r)
	if err != nil {
		return err
	}
	if err = h.service.Delete(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "taskId"), rev); err != nil {
		return mapError(err)
	}
	return httpapi.OK(w, r, 200, map[string]any{"deleted": true})
}
func (h *studioHTTP) list(w http.ResponseWriter, r *http.Request) error {
	tasks, err := h.service.Renders(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "projectId"))
	if err != nil {
		return mapError(err)
	}
	renders := []map[string]any{}
	for _, t := range tasks {
		renders = append(renders, renderDTO(t))
	}
	return httpapi.OK(w, r, 200, map[string]any{"renders": renders})
}
func (h *studioHTTP) file(w http.ResponseWriter, r *http.Request) error {
	file, err := h.service.File(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "projectId"), chi.URLParam(r, "filename"))
	if err != nil {
		return mapError(err)
	}
	w.Header().Set("Content-Type", file.MimeType)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(file.Name))
	http.ServeContent(w, r, file.Name, time.Time{}, bytes.NewReader(file.Content))
	return nil
}
func (h *studioHTTP) previewSession(w http.ResponseWriter, r *http.Request) error {
	var cmd struct {
		Path        string `json:"path"`
		Composition bool   `json:"composition"`
	}
	if err := httpapi.DecodeLimit(w, r, &cmd, 8192); err != nil {
		return err
	}
	if !domain.ValidPath(cmd.Path) || len(r.Header.Values("Idempotency-Key")) != 1 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "预览路径无效。")
	}
	if _, err := uuid.Parse(r.Header.Get("Idempotency-Key")); err != nil {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要有效幂等键。")
	}
	identity := httpapi.IdentityFrom(r)
	id := chi.URLParam(r, "projectId")
	bundle, err := h.repo.Snapshot(r.Context(), identity.UserID, id, 0)
	if err != nil {
		return mapError(err)
	}
	found := false
	for _, f := range bundle.Files {
		if f.Path == cmd.Path {
			found = true
		}
	}
	if !found {
		return httpapi.Fail(404, "STUDIO_FILE_NOT_FOUND", "项目文件不存在。")
	}
	grant, err := h.tokens.Sign(map[string]any{"sub": identity.UserID, "sid": identity.SessionID, "project": id, "revision": strconv.FormatInt(bundle.Revision, 10), "composition": cmd.Composition}, "studio-preview", 5*time.Minute)
	if err != nil {
		return err
	}
	pathParts := []string{}
	for _, part := range strings.Split(cmd.Path, "/") {
		pathParts = append(pathParts, url.PathEscape(part))
	}
	link := h.cfg.PublicBaseURL + "/api/v2/studio/preview/" + url.PathEscape(id) + "/" + grant + "/" + strings.Join(pathParts, "/")
	return httpapi.OK(w, r, 201, map[string]any{"url": link, "expiresIn": 300})
}
func (h *studioHTTP) preview(w http.ResponseWriter, r *http.Request) error {
	claims, err := h.tokens.Verify(chi.URLParam(r, "grant"), "studio-preview")
	if err != nil {
		return err
	}
	uid, _ := claims["sub"].(string)
	sid, _ := claims["sid"].(string)
	project, _ := claims["project"].(string)
	revString, _ := claims["revision"].(string)
	rev, e := strconv.ParseInt(revString, 10, 64)
	if uid == "" || sid == "" || project != chi.URLParam(r, "projectId") || e != nil || rev < 1 || h.signed == nil {
		return httpapi.Fail(401, "UNAUTHENTICATED", "预览凭据无效。")
	}
	r, err = h.signed(r, uid, sid)
	if err != nil {
		return err
	}
	name := chi.URLParam(r, "*")
	if !domain.ValidPath(name) {
		return httpapi.Fail(400, "VALIDATION_FAILED", "预览路径无效。")
	}
	bundle, err := h.repo.Snapshot(r.Context(), uid, project, rev)
	if err != nil {
		return mapError(err)
	}
	for _, file := range bundle.Files {
		if file.Path != name {
			continue
		}
		w.Header().Set("Content-Type", file.MimeType)
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("ETag", fmt.Sprintf(`"%d"`, rev))
		body := file.Content
		if strings.HasPrefix(file.MimeType, "text/html") {
			origin := ""
			if u, e := url.Parse(h.cfg.PublicBaseURL); e == nil && u.Host != "" {
				origin = u.Scheme + "://" + u.Host
			}
			body = append(append([]byte(nil), body...), []byte(PreviewBridge(name, origin))...)
		}
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
		return nil
	}
	return httpapi.Fail(404, "STUDIO_FILE_NOT_FOUND", "项目文件不存在。")
}
