// Package http registers only implemented owner-only folder and inbox routes.
package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/url"
	"regexp"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/organization/application"
	"studiotv.local/service/api/internal/modules/organization/domain"
	"strconv"
	"strings"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc
type handler struct{ s *application.Service }

func RegisterRoutes(router chi.Router, s *application.Service, protect Protect) error {
	if router == nil || s == nil || protect == nil {
		return errors.New("organization router, service and trusted protect required")
	}
	h := handler{s}
	reg := func(method, path string, next httpapi.Handler) {
		router.MethodFunc(method, path, protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if e := actor(r).Validate(); e != nil {
				return mapError(e)
			}
			if _, ok := r.Header["X-Team-Id"]; ok {
				return httpapi.Fail(403, "FORBIDDEN", "团队空间尚未启用。")
			}
			if _, ok := r.Header["X-Workspace-Id"]; ok {
				return httpapi.Fail(403, "FORBIDDEN", "工作区参数尚未启用。")
			}
			if method != "GET" {
				if _, e := values(r); e != nil {
					return mapError(e)
				}
			}
			return mapError(next(w, r))
		}))
	}
	reg("GET", "/api/v2/project-folders/config", h.config)
	reg("GET", "/api/v2/project-folders/tree", h.tree)
	reg("GET", "/api/v2/project-folders/entries", h.entries)
	reg("POST", "/api/v2/project-folders/projects", h.createProject)
	reg("GET", "/api/v2/project-folders", h.folders)
	reg("POST", "/api/v2/project-folders", h.createFolder)
	reg("GET", "/api/v2/project-folders/{id}", h.folder)
	reg("PATCH", "/api/v2/project-folders/{id}", h.renameFolder)
	reg("DELETE", "/api/v2/project-folders/{id}", h.deleteFolder)
	reg("GET", "/api/v2/projects/{id}/folder", h.membership)
	reg("PUT", "/api/v2/projects/{id}/folder", h.move)
	for _, prefix := range []string{"/api/v1", "/api/v2"} {
		reg("GET", prefix+"/notifications", h.notifications)
		reg("GET", prefix+"/notifications/unread-count", h.unread)
		reg("POST", prefix+"/notifications/read", h.read)
		reg("POST", prefix+"/notifications/delete", h.deleteNotifications)
		reg("GET", prefix+"/notifications/{id}", h.notification)
		reg("DELETE", prefix+"/notifications/{id}", h.deleteNotification)
	}
	return nil
}
func actor(r *http.Request) domain.Actor {
	return domain.Actor{OwnerID: httpapi.IdentityFrom(r).UserID}
}
func mapError(e error) error {
	if e == nil {
		return nil
	}
	var c *domain.VersionConflict
	if errors.As(e, &c) {
		v := httpapi.Fail(412, "VERSION_CONFLICT", "资源已更新，请重新读取后操作。")
		v.Details = []httpapi.Detail{{Field: "/headers/If-Match", Code: "CURRENT_REVISION", Message: strconv.FormatInt(c.Current, 10)}}
		return v
	}
	switch {
	case errors.Is(e, domain.ErrInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "文件夹或消息参数无效。")
	case errors.Is(e, domain.ErrUnauthenticated):
		return httpapi.Fail(401, "UNAUTHENTICATED", "需要有效登录。")
	case errors.Is(e, domain.ErrNotFound):
		return httpapi.Fail(404, "RESOURCE_NOT_FOUND", "资源不存在。")
	case errors.Is(e, domain.ErrConflict):
		return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "幂等键已用于不同请求。")
	case errors.Is(e, domain.ErrTooLarge):
		return httpapi.Fail(413, "ORGANIZATION_TREE_TOO_LARGE", "文件夹树超过单次读取限制。")
	case errors.Is(e, domain.ErrUnavailable):
		return httpapi.Retry(503, "ORGANIZATION_UNAVAILABLE", "文件夹或消息存储暂时不可用。")
	}
	return e
}

var etagPattern = regexp.MustCompile(`^"[1-9][0-9]*"$`)

func expected(r *http.Request) (int64, error) {
	v := r.Header.Values("If-Match")
	if len(v) == 0 {
		return 0, httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要读取资源返回的强ETag作为If-Match。")
	}
	if len(v) != 1 || !etagPattern.MatchString(v[0]) {
		return 0, domain.ErrInvalid
	}
	n, e := strconv.ParseInt(strings.Trim(v[0], `"`), 10, 64)
	if e != nil {
		return 0, domain.ErrInvalid
	}
	return n, nil
}
func mutation(r *http.Request, body any, revision bool) (application.Mutation, error) {
	var n int64
	var e error
	if revision {
		n, e = expected(r)
		if e != nil {
			return application.Mutation{}, e
		}
	}
	v := r.Header.Values("Idempotency-Key")
	if len(v) != 1 || application.Key(v[0]) != nil {
		return application.Mutation{}, httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式Idempotency-Key。")
	}
	return application.Command(n, v[0], body)
}
func output(w http.ResponseWriter, r *http.Request, status int, revision int64, body any) error {
	if revision > 0 {
		w.Header().Set("ETag", fmt.Sprintf(`"%d"`, revision))
	}
	return httpapi.OK(w, r, status, body)
}
func values(r *http.Request, allowed ...string) (url.Values, error) {
	v, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, domain.ErrInvalid
	}
	for k, items := range v {
		found := false
		for _, a := range allowed {
			if k == a {
				found = true
			}
		}
		if !found || len(items) != 1 || !domain.Text(items[0], 200, false) {
			return nil, domain.ErrInvalid
		}
	}
	return v, nil
}
func number(s string, defaultValue int) (int, error) {
	if s == "" {
		return defaultValue, nil
	}
	n, e := strconv.Atoi(s)
	if e != nil || strconv.Itoa(n) != s {
		return 0, domain.ErrInvalid
	}
	return n, nil
}
func query(r *http.Request, entries bool) (domain.Query, error) {
	allowed := []string{"page", "size", "keyword", "sort", "parentId"}
	if entries {
		allowed = []string{"page", "size", "keyword", "sort", "folderId", "queryScope"}
	}
	v, e := values(r, allowed...)
	q := domain.Query{Page: 1, Size: 20, Sort: "UPDATED_DESC", Scope: "ALL"}
	if e != nil {
		return q, e
	}
	q.Page, e = number(v.Get("page"), 1)
	if e != nil {
		return q, e
	}
	q.Size, e = number(v.Get("size"), 20)
	if e != nil {
		return q, e
	}
	q.Keyword = strings.TrimSpace(v.Get("keyword"))
	if s := v.Get("sort"); s != "" {
		q.Sort = s
	}
	field := "parentId"
	if entries {
		field = "folderId"
		if s := v.Get("queryScope"); s != "" {
			q.Scope = s
		}
	}
	if s := v.Get(field); s != "" {
		q.ParentID = &s
	}
	return q, q.Validate()
}
func (h handler) config(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	return output(w, r, 200, 0, map[string]int{"maxLevel": domain.MaxLevel, "maxFolders": domain.MaxFolders})
}
func (h handler) folders(w http.ResponseWriter, r *http.Request) error {
	q, e := query(r, false)
	if e != nil {
		return e
	}
	p, e := h.s.Folders(r.Context(), actor(r), q)
	if e != nil {
		return e
	}
	records := []domain.Folder{}
	for _, v := range p.Records {
		if v.Folder == nil {
			return domain.ErrUnavailable
		}
		records = append(records, *v.Folder)
	}
	return output(w, r, 200, p.Revision, map[string]any{"records": records, "page": p.Page, "current": p.Current, "size": p.Size, "total": p.Total, "pages": p.Pages, "hasNext": p.HasNext, "revision": p.Revision})
}
func (h handler) entries(w http.ResponseWriter, r *http.Request) error {
	q, e := query(r, true)
	if e != nil {
		return e
	}
	p, e := h.s.Entries(r.Context(), actor(r), q)
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, p)
}
func (h handler) tree(w http.ResponseWriter, r *http.Request) error {
	v, e := values(r, "projectId")
	if e != nil {
		return e
	}
	p, e := h.s.Tree(r.Context(), actor(r), v.Get("projectId"))
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, p)
}
func (h handler) folder(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	p, e := h.s.Folder(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, p)
}
func (h handler) createFolder(w http.ResponseWriter, r *http.Request) error {
	var i domain.FolderInput
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	m, e := mutation(r, i, false)
	if e != nil {
		return e
	}
	p, e := h.s.CreateFolder(r.Context(), actor(r), i, m)
	if e != nil {
		return e
	}
	return output(w, r, 201, p.Revision, p)
}
func (h handler) renameFolder(w http.ResponseWriter, r *http.Request) error {
	var i struct {
		Name string `json:"name"`
	}
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	m, e := mutation(r, i, true)
	if e != nil {
		return e
	}
	p, e := h.s.RenameFolder(r.Context(), actor(r), chi.URLParam(r, "id"), i.Name, m)
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, p)
}
func (h handler) deleteFolder(w http.ResponseWriter, r *http.Request) error {
	m, e := mutation(r, struct{}{}, true)
	if e != nil {
		return e
	}
	p, e := h.s.DeleteFolder(r.Context(), actor(r), chi.URLParam(r, "id"), m)
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, p)
}
func (h handler) membership(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	p, e := h.s.Membership(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, p)
}
func (h handler) move(w http.ResponseWriter, r *http.Request) error {
	var i struct {
		FolderID json.RawMessage `json:"folderId"`
	}
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	if len(i.FolderID) == 0 {
		return domain.ErrInvalid
	}
	var id *string
	if e := json.Unmarshal(i.FolderID, &id); e != nil {
		return domain.ErrInvalid
	}
	m, e := mutation(r, struct {
		FolderID *string `json:"folderId"`
	}{id}, true)
	if e != nil {
		return e
	}
	p, e := h.s.Move(r.Context(), actor(r), chi.URLParam(r, "id"), id, m)
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, p)
}
func (h handler) createProject(w http.ResponseWriter, r *http.Request) error {
	var i struct {
		Name     string  `json:"name"`
		FolderID *string `json:"folderId"`
	}
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	m, e := mutation(r, i, false)
	if e != nil {
		return e
	}
	p, e := h.s.CreateProject(r.Context(), actor(r), i.Name, i.FolderID, m)
	if e != nil {
		return e
	}
	return output(w, r, 201, p.Revision, p)
}
func notificationView(n domain.Notification, revision bool) any {
	if revision {
		return n
	}
	return map[string]any{"id": n.ID, "type": n.Type, "title": n.Title, "body": n.Body, "read": n.Read, "targetUrl": n.TargetURL, "createdAt": n.CreatedAt}
}
func (h handler) notifications(w http.ResponseWriter, r *http.Request) error {
	v, e := values(r, "type", "page", "pageSize")
	if e != nil {
		return e
	}
	page, e := number(v.Get("page"), 1)
	if e != nil {
		return e
	}
	size, e := number(v.Get("pageSize"), 20)
	if e != nil {
		return e
	}
	p, e := h.s.Notifications(r.Context(), actor(r), v.Get("type"), page, size)
	if e != nil {
		return e
	}
	items := []any{}
	for _, n := range p.Items {
		items = append(items, notificationView(n, strings.HasPrefix(r.URL.Path, "/api/v2/")))
	}
	return output(w, r, 200, 0, map[string]any{"items": items, "page": p.Page, "pageSize": p.PageSize, "total": p.Total, "hasMore": p.HasMore})
}
func (h handler) notification(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	n, e := h.s.Notification(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return output(w, r, 200, n.Revision, n)
}
func (h handler) unread(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	n, e := h.s.Unread(r.Context(), actor(r))
	if e != nil {
		return e
	}
	return output(w, r, 200, 0, n)
}
func (h handler) read(w http.ResponseWriter, r *http.Request) error {
	var i struct {
		IDs []string `json:"ids"`
	}
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	m, e := mutation(r, i, false)
	if e != nil {
		return e
	}
	n, e := h.s.Read(r.Context(), actor(r), i.IDs, m)
	if e != nil {
		return e
	}
	return output(w, r, 200, 0, n)
}
func (h handler) deleteNotification(w http.ResponseWriter, r *http.Request) error {
	m, e := mutation(r, struct{}{}, true)
	if e != nil {
		return e
	}
	n, e := h.s.DeleteNotification(r.Context(), actor(r), chi.URLParam(r, "id"), m)
	if e != nil {
		return e
	}
	return output(w, r, 200, n.Revision, n)
}
func (h handler) deleteNotifications(w http.ResponseWriter, r *http.Request) error {
	var i struct {
		IDs []string `json:"ids"`
	}
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	m, e := mutation(r, i, false)
	if e != nil {
		return e
	}
	n, e := h.s.DeleteNotifications(r.Context(), actor(r), i.IDs, m)
	if e != nil {
		return e
	}
	return output(w, r, 200, 0, n)
}
