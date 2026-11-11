// Package http registers explicit bounded routes, never a native pass-through or successful catchall.
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
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"strconv"
	"strings"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc
type handler struct{ s *application.Service }

func RegisterRoutes(router chi.Router, s *application.Service, protect Protect) error {
	if router == nil || s == nil || protect == nil {
		return errors.New("resources router, service and trusted protect required")
	}
	h := handler{s}
	reg := func(method, path string, next httpapi.Handler) {
		router.MethodFunc(method, "/api/v2"+path, protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if e := actor(r).Validate(); e != nil {
				return mapError(e)
			}
			if r.Method != "GET" && !strings.HasSuffix(r.URL.Path, "/upload") {
				if _, e := values(r); e != nil {
					return mapError(e)
				}
			}
			return mapError(next(w, r))
		}))
	}
	for _, pair := range []struct {
		path   string
		family domain.Family
	}{{"characters", domain.Character}, {"prompts", domain.Prompt}, {"skills", domain.Skill}, {"workflows", domain.Workflow}, {"apps", domain.App}, {"voices", domain.Voice}, {"director-projects", domain.DirectorProject}, {"director-models", domain.DirectorModel}} {
		f := pair.family
		p := "/" + pair.path
		reg("GET", p, h.list(f))
		reg("GET", p+"/{id}", h.get(f))
		reg("PUT", p+"/{id}/favorite", h.favorite(f))
		reg("POST", p+"/{id}/usage", h.usage(f))
		if f.PrivateWritable() {
			reg("POST", p, h.save(f, true))
			reg("PUT", p+"/{id}", h.save(f, false))
			reg("DELETE", p+"/{id}", h.delete(f))
		}
	}
	reg("POST", "/workflows/{id}/apply", h.apply)
	reg("GET", "/apps/{id}/creations", h.creations)
	reg("GET", "/apps/{id}/usage-history", h.history)
	reg("GET", "/characters/filters", h.characterFilters)
	reg("GET", "/catalog/categories", h.categories)
	reg("GET", "/catalog/configs", h.values("CONFIG"))
	reg("GET", "/catalog/dictionaries", h.values("DICTIONARY"))
	reg("POST", "/catalog/media/import", h.importMedia)
	reg("GET", "/catalog/entries", h.entries)
	reg("GET", "/catalog/entries/{id}", h.entry)
	reg("GET", "/preferences", h.preferences)
	reg("PATCH", "/preferences", h.updatePreferences)
	reg("GET", "/tags", h.tags)
	reg("POST", "/tags", h.mutateTags("create"))
	reg("PATCH", "/tags/{id}", h.mutateTags("update"))
	reg("DELETE", "/tags/{id}", h.mutateTags("delete"))
	reg("PUT", "/tags/order", h.mutateTags("order"))
	reg("POST", "/tags/preset", h.mutateTags("preset"))
	h.registerStudio(reg)
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
		v := httpapi.Fail(412, "VERSION_CONFLICT", "资源版本已更新，请重新读取。")
		v.Details = []httpapi.Detail{{Field: "/headers/If-Match", Code: "CURRENT_REVISION", Message: strconv.FormatInt(c.Current, 10)}}
		return v
	}
	switch {
	case errors.Is(e, domain.ErrInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "资源参数无效。")
	case errors.Is(e, domain.ErrUnauthenticated):
		return httpapi.Fail(401, "UNAUTHENTICATED", "需要有效登录。")
	case errors.Is(e, domain.ErrNotFound):
		return httpapi.Fail(404, "RESOURCE_NOT_FOUND", "资源不存在。")
	case errors.Is(e, domain.ErrConflict):
		return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "幂等键或资源路径冲突。")
	case errors.Is(e, domain.ErrUnsupported):
		return httpapi.Fail(501, "NOT_IMPLEMENTED", "该资源能力尚未配置。")
	case errors.Is(e, domain.ErrUnavailable):
		return httpapi.Retry(503, "RESOURCES_UNAVAILABLE", "资源存储暂时不可用。")
	}
	return e
}

var etagPattern = regexp.MustCompile(`^"[1-9][0-9]*"$`)

func expected(r *http.Request) (int64, error) {
	v := r.Header.Values("If-Match")
	if len(v) == 0 {
		return 0, httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要强ETag作为If-Match。")
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
func key(r *http.Request) (string, error) {
	v := r.Header.Values("Idempotency-Key")
	if len(v) != 1 || application.Key(v[0]) != nil {
		return "", httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式Idempotency-Key。")
	}
	return v[0], nil
}
func mutation(r *http.Request, body any, withRevision, withKey bool) (application.Mutation, error) {
	var n int64
	var k string
	var e error
	if withRevision {
		n, e = expected(r)
		if e != nil {
			return application.Mutation{}, e
		}
	}
	if withKey {
		k, e = key(r)
		if e != nil {
			return application.Mutation{}, e
		}
	}
	return application.Command(n, k, body)
}
func output(w http.ResponseWriter, r *http.Request, status int, revision int64, v any) error {
	if revision > 0 {
		w.Header().Set("ETag", fmt.Sprintf(`"%d"`, revision))
	}
	return httpapi.OK(w, r, status, v)
}
func values(r *http.Request, allowed ...string) (url.Values, error) {
	v, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, domain.ErrInvalid
	}
	for k, vs := range v {
		ok := false
		for _, a := range allowed {
			if k == a {
				ok = true
			}
		}
		if !ok || len(vs) != 1 || !domain.Text(vs[0], 10000, false) {
			return nil, domain.ErrInvalid
		}
	}
	return v, nil
}
func query(r *http.Request, extra ...string) (domain.Query, error) {
	allowed := append([]string{"page", "size", "keyword", "scope", "categoryId", "categoryIds", "favoriteOnly", "recentOnly"}, extra...)
	v, e := values(r, allowed...)
	q := domain.Query{Page: 1, Size: 20, Keyword: strings.TrimSpace(v.Get("keyword")), Scope: v.Get("scope"), CategoryIDs: []string{}, SceneIDs: []string{}, Keys: []string{}, Fields: map[string]string{}}
	if e != nil {
		return q, e
	}
	for _, k := range []string{"page", "size"} {
		if s := v.Get(k); s != "" {
			n, e := strconv.Atoi(s)
			if e != nil || strconv.Itoa(n) != s {
				return q, domain.ErrInvalid
			}
			if k == "page" {
				q.Page = n
			} else {
				q.Size = n
			}
		}
	}
	for _, k := range []string{"favoriteOnly", "recentOnly"} {
		if s := v.Get(k); s != "" {
			if s != "true" && s != "false" {
				return q, domain.ErrInvalid
			}
			if k == "favoriteOnly" {
				q.FavoriteOnly = s == "true"
			} else {
				q.RecentOnly = s == "true"
			}
		}
	}
	if s := v.Get("categoryId"); s != "" {
		q.CategoryIDs = append(q.CategoryIDs, s)
	}
	if s := v.Get("categoryIds"); s != "" {
		if json.Unmarshal([]byte(s), &q.CategoryIDs) != nil {
			return q, domain.ErrInvalid
		}
	}
	if s := v.Get("filters"); s != "" {
		if domain.Strict([]byte(s), &q.Filters) != nil {
			return q, domain.ErrInvalid
		}
	}
	if s := v.Get("sceneIdList"); s != "" {
		if json.Unmarshal([]byte(s), &q.SceneIDs) != nil {
			return q, domain.ErrInvalid
		}
	}
	if s := v.Get("keys"); s != "" {
		if json.Unmarshal([]byte(s), &q.Keys) != nil {
			return q, domain.ErrInvalid
		}
	}
	for _, k := range extra {
		if k != "filters" && k != "sceneIdList" && k != "keys" && k != "namespace" {
			if s := v.Get(k); s != "" {
				q.Fields[k] = s
			}
		}
	}
	if e = q.Validate(); e != nil {
		return q, e
	}
	return q, nil
}
func familyFields(f domain.Family) []string {
	switch f {
	case domain.Character:
		return []string{"filters"}
	case domain.Prompt:
		return []string{"promptType", "menuType", "mediaScope"}
	case domain.Skill:
		return []string{"type", "category", "code", "sort"}
	case domain.Workflow:
		return []string{"recommended"}
	case domain.App:
		return []string{"sort", "days"}
	case domain.Voice:
		return []string{"modelCode", "langId", "dialectId", "sceneIdList", "gender"}
	case domain.DirectorProject:
		return []string{"type"}
	case domain.DirectorModel:
		return []string{"categoryCode"}
	}
	return nil
}
func validateFields(f domain.Family, q domain.Query) error {
	for k, v := range q.Fields {
		switch k {
		case "sort":
			if v != "RECOMMEND" && v != "REPUTATION" && v != "HOTTEST" && v != "NEWEST" {
				return domain.ErrInvalid
			}
		case "days":
			if v != "1" && v != "7" && v != "30" && v != "90" {
				return domain.ErrInvalid
			}
		case "gender":
			if v != "FEMALE" && v != "MALE" && v != "UNKNOWN" {
				return domain.ErrInvalid
			}
		case "recommended":
			if v != "true" && v != "false" {
				return domain.ErrInvalid
			}
		case "type":
			if f == domain.DirectorProject && v != "2D" && v != "3D" {
				return domain.ErrInvalid
			}
			if f == domain.Skill && v != "USER" && v != "COMMON" {
				return domain.ErrInvalid
			}
		}
	}
	return nil
}
func view(v domain.Resource) any {
	return map[string]any{"resource": map[string]any{"id": v.ID, "name": v.Name, "description": v.Description, "scope": v.Scope, "revision": v.Revision, "version": v.Version, "categoryIds": v.CategoryIDs, "coverAssetId": v.CoverAssetID, "coverUrl": v.CoverURL, "favorited": v.Favorited, "createdAt": v.CreatedAt, "updatedAt": v.UpdatedAt}, "content": json.RawMessage(v.Content)}
}
func pageView(p domain.Page) any {
	records := []any{}
	for _, v := range p.Records {
		records = append(records, view(v))
	}
	return map[string]any{"records": records, "page": p.Page, "current": p.Current, "size": p.Size, "total": p.Total, "pages": p.Pages, "hasNext": p.HasNext}
}
func (h handler) list(f domain.Family) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		q, e := query(r, familyFields(f)...)
		if e != nil {
			return e
		}
		if e = validateFields(f, q); e != nil {
			return e
		}
		if f == domain.Skill {
			if t := q.Fields["type"]; t != "" {
				if t == "USER" {
					q.Scope = "USER"
				} else {
					q.Scope = "SYSTEM"
				}
				delete(q.Fields, "type")
			}
		}
		if f == domain.Character && len(q.Filters) > 0 {
			if e = h.validateCharacterFilters(r, q.Filters); e != nil {
				return e
			}
		}
		p, e := h.s.List(r.Context(), actor(r), f, q)
		if e != nil {
			return e
		}
		return output(w, r, 200, 0, pageView(p))
	}
}
func (h handler) get(f domain.Family) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		if _, e := values(r); e != nil {
			return e
		}
		v, e := h.s.Get(r.Context(), actor(r), f, chi.URLParam(r, "id"))
		if e != nil {
			return e
		}
		return output(w, r, 200, v.Revision, view(v))
	}
}
func (h handler) save(f domain.Family, create bool) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		if _, e := values(r); e != nil {
			return e
		}
		var i domain.Input
		limit := int64(1100000)
		if f == domain.Skill {
			limit = 16 * 1024 * 1024
		}
		if e := httpapi.DecodeLimit(w, r, &i, limit); e != nil {
			return e
		}
		m, e := mutation(r, i, !create, create)
		if e != nil {
			return e
		}
		id := chi.URLParam(r, "id")
		v, e := h.s.Save(r.Context(), actor(r), f, id, i, m)
		if e != nil {
			return e
		}
		status := 200
		if create {
			status = 201
		}
		return output(w, r, status, v.Revision, view(v))
	}
}
func (h handler) delete(f domain.Family) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		m, e := mutation(r, nil, true, false)
		if e != nil {
			return e
		}
		rev, e := h.s.Delete(r.Context(), actor(r), f, chi.URLParam(r, "id"), m)
		if e != nil {
			return e
		}
		return output(w, r, 200, rev, map[string]any{"accepted": true, "revision": rev})
	}
}
func (h handler) favorite(f domain.Family) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			Favorited *bool `json:"favorited"`
		}
		if e := httpapi.Decode(w, r, &body); e != nil {
			return e
		}
		if body.Favorited == nil {
			return domain.ErrInvalid
		}
		m, e := mutation(r, body, true, false)
		if e != nil {
			return e
		}
		v, e := h.s.Favorite(r.Context(), actor(r), f, chi.URLParam(r, "id"), *body.Favorited, m)
		if e != nil {
			return e
		}
		return output(w, r, 200, v.Revision, view(v))
	}
}
func (h handler) usage(f domain.Family) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			ProjectID *string `json:"projectId"`
			NodeID    *string `json:"nodeId"`
		}
		if e := httpapi.Decode(w, r, &body); e != nil {
			return e
		}
		m, e := mutation(r, body, false, true)
		if e != nil {
			return e
		}
		v, e := h.s.Use(r.Context(), actor(r), f, chi.URLParam(r, "id"), body.ProjectID, body.NodeID, m)
		if e != nil {
			return e
		}
		return output(w, r, 201, 0, v)
	}
}
func (h handler) apply(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		ProjectID string `json:"projectId"`
	}
	if e := httpapi.Decode(w, r, &body); e != nil {
		return e
	}
	if !domain.ID(body.ProjectID) {
		return domain.ErrInvalid
	}
	m, e := mutation(r, body, false, true)
	if e != nil {
		return e
	}
	id := chi.URLParam(r, "id")
	v, e := h.s.Get(r.Context(), actor(r), domain.Workflow, id)
	if e != nil {
		return e
	}
	u, e := h.s.Use(r.Context(), actor(r), domain.Workflow, id, &body.ProjectID, nil, m)
	if e != nil {
		return e
	}
	return output(w, r, 200, v.Revision, map[string]any{"workflow": view(v), "usage": u})
}
func (h handler) history(w http.ResponseWriter, r *http.Request) error {
	q, e := query(r)
	if e != nil {
		return e
	}
	rows, total, e := h.s.Store.History(r.Context(), actor(r), chi.URLParam(r, "id"), q)
	if e != nil {
		return e
	}
	p := domain.NewPage(q, nil, total)
	return output(w, r, 200, 0, map[string]any{"records": rows, "total": total, "size": q.Size, "page": q.Page, "current": q.Page, "pages": p.Pages, "hasNext": p.HasNext})
}
func (h handler) characterFilters(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	v, e := h.s.Store.Values(r.Context(), "CHARACTER_FILTERS", nil)
	if e != nil {
		return e
	}
	groups := json.RawMessage(`{"groups":[]}`)
	if len(v) > 0 {
		groups = v[0]
	}
	return output(w, r, 200, 0, groups)
}
func (h handler) validateCharacterFilters(r *http.Request, filters []domain.Filter) error {
	raw, e := h.s.Store.Values(r.Context(), "CHARACTER_FILTERS", nil)
	if e != nil {
		return e
	}
	allowed := map[string]map[string]bool{}
	for _, v := range raw {
		var groups struct {
			Groups []struct {
				Categories []struct {
					Code    string
					Options []struct{ Code string }
				}
			}
		}
		if json.Unmarshal(v, &groups) != nil {
			return domain.ErrUnavailable
		}
		for _, g := range groups.Groups {
			for _, c := range g.Categories {
				allowed[c.Code] = map[string]bool{}
				for _, o := range c.Options {
					allowed[c.Code][o.Code] = true
				}
			}
		}
	}
	seen := map[string]bool{}
	for _, f := range filters {
		if seen[f.CategoryCode] || allowed[f.CategoryCode] == nil || len(f.OptionCodes) == 0 {
			return domain.ErrInvalid
		}
		seen[f.CategoryCode] = true
		opts := map[string]bool{}
		for _, o := range f.OptionCodes {
			if o == "all" || opts[o] || !allowed[f.CategoryCode][o] {
				return domain.ErrInvalid
			}
			opts[o] = true
		}
	}
	return nil
}
func (h handler) categories(w http.ResponseWriter, r *http.Request) error {
	v, e := values(r, "namespace", "scope", "menuType", "modelCode", "type", "category")
	if e != nil {
		return e
	}
	allowed := map[string]bool{"ASSET_USER": true, "ASSET_COMMON": true, "WORKFLOW": true, "PROMPT": true, "SKILL": true, "APP": true, "VOICE_LANGUAGE": true, "VOICE_SCENE": true, "ANIMATION": true, "INSPIRATION_TAG": true}
	ns := v.Get("namespace")
	if !allowed[ns] {
		return domain.ErrInvalid
	}
	context := map[string]string{}
	for k, vs := range v {
		if k != "namespace" {
			context[k] = vs[0]
		}
	}
	result, e := h.s.Store.Categories(r.Context(), ns, context)
	if e != nil {
		return e
	}
	return output(w, r, 200, 0, result)
}
func (h handler) values(namespace string) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		v, e := values(r, "types")
		if e != nil {
			return e
		}
		keys := []string{}
		if s := v.Get("types"); s != "" {
			if json.Unmarshal([]byte(s), &keys) != nil || len(keys) > 100 {
				return domain.ErrInvalid
			}
			for _, k := range keys {
				if !domain.ID(k) {
					return domain.ErrInvalid
				}
			}
		}
		result, e := h.s.Store.Values(r.Context(), namespace, keys)
		if e != nil {
			return e
		}
		return output(w, r, 200, 0, result)
	}
}
func namespace(r *http.Request) (string, error) {
	ns := r.URL.Query().Get("namespace")
	switch ns {
	case "HOME_HIGHLIGHT", "INSPIRATION_TEMPLATE", "DIRECTOR_MODEL", "DIRECTOR_DEFINE", "ANIMATION", "STUDIO_BLOCK":
		return ns, nil
	}
	return "", domain.ErrInvalid
}
func (h handler) entries(w http.ResponseWriter, r *http.Request) error {
	q, e := query(r, "namespace", "categoryCode", "keys")
	if e != nil {
		return e
	}
	ns, e := namespace(r)
	if e != nil {
		return e
	}
	result, e := h.s.Store.Entries(r.Context(), actor(r), ns, q)
	if e != nil {
		return e
	}
	return output(w, r, 200, 0, pageView(result))
}
func (h handler) entry(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r, "namespace"); e != nil {
		return e
	}
	ns, e := namespace(r)
	if e != nil {
		return e
	}
	v, e := h.s.Store.Entry(r.Context(), actor(r), ns, chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return output(w, r, 200, v.Revision, view(v))
}

func (h handler) importMedia(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Source    string `json:"source"`
		ProjectID string `json:"projectId"`
	}
	if e := httpapi.Decode(w, r, &body); e != nil {
		return e
	}
	m, e := mutation(r, body, false, true)
	if e != nil {
		return e
	}
	v, e := h.s.ImportMedia(r.Context(), actor(r), body.Source, body.ProjectID, m)
	if e != nil {
		return e
	}
	return output(w, r, 201, 0, v)
}

func (h handler) creations(w http.ResponseWriter, r *http.Request) error {
	q, e := query(r)
	if e != nil {
		return e
	}
	id := chi.URLParam(r, "id")
	if _, e = h.s.Get(r.Context(), actor(r), domain.App, id); e != nil {
		return e
	}
	if h.s.History == nil {
		return domain.ErrUnsupported
	}
	v, e := h.s.History.Creations(r.Context(), actor(r), id, q)
	if e != nil {
		return e
	}
	if v.Total < 0 || len(v.Records) > q.Size {
		return domain.ErrUnavailable
	}
	if v.Records == nil {
		v.Records = []application.Creation{}
	}
	p := domain.NewPage(q, nil, v.Total)
	return output(w, r, 200, 0, map[string]any{"records": v.Records, "total": v.Total, "size": q.Size, "page": q.Page, "current": q.Page, "pages": p.Pages, "hasNext": p.HasNext})
}
