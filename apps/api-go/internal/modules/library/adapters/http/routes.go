// Package http exposes only the implemented private library slice.
package http

import (
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/url"
	"regexp"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Protect verifies the real login and live capability and sets WithIdentity.
type Protect func(string, httpapi.Handler) http.HandlerFunc

func RegisterRoutes(router chi.Router, service *application.Service, protect Protect) error {
	if router == nil || service == nil || protect == nil {
		return errors.New("library router, service and trusted auth decorator are required")
	}
	h := handler{service}
	register := func(method, path string, next httpapi.Handler) {
		router.MethodFunc(method, path, protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if e := actor(r).Validate(); e != nil {
				return mapError(e)
			}
			return mapError(next(w, r))
		}))
	}
	register("GET", "/api/v2/library/items", h.list)
	register("POST", "/api/v2/library/items", h.create)
	register("GET", "/api/v2/library/items/{id}", h.get)
	register("PATCH", "/api/v2/library/items/{id}", h.update)
	register("DELETE", "/api/v2/library/items/{id}", h.delete)
	register("GET", "/api/v2/library/items/{id}/images", h.images)
	register("POST", "/api/v2/library/items/{id}/images", h.mutateImages("add"))
	register("PUT", "/api/v2/library/items/{id}/images/order", h.mutateImages("order"))
	register("PUT", "/api/v2/library/items/{id}/images/main", h.mutateImages("main"))
	register("DELETE", "/api/v2/library/items/{id}/images/{imageId}", h.mutateImages("delete"))
	return nil
}

type handler struct{ service *application.Service }

func actor(r *http.Request) domain.VerifiedActor {
	return domain.VerifiedActor{OwnerID: httpapi.IdentityFrom(r).UserID}
}
func (h handler) list(w http.ResponseWriter, r *http.Request) error {
	v, e := queryValues(r, "page", "size", "keyword", "kind")
	if e != nil {
		return e
	}
	q := domain.Query{Page: 1, Size: 20, Keyword: strings.TrimSpace(v.Get("keyword"))}
	for _, name := range []string{"page", "size"} {
		if raw, ok := v[name]; ok {
			n, e := strconv.Atoi(raw[0])
			if e != nil || strconv.Itoa(n) != raw[0] {
				return domain.ErrInvalid
			}
			if name == "page" {
				q.Page = n
			} else {
				q.Size = n
			}
		}
	}
	if raw, ok := v["kind"]; ok {
		k := domain.Kind(raw[0])
		q.Kind = &k
	}
	p, e := h.service.List(r.Context(), actor(r), q)
	if e != nil {
		return e
	}
	records := make([]galleryDTO, 0, len(p.Records))
	for _, g := range p.Records {
		records = append(records, galleryView(g))
	}
	return httpapi.OK(w, r, 200, pageDTO{records, p.Page, p.Size, p.Total, p.Pages, p.HasNext})
}
func (h handler) get(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	g, e := h.service.Get(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	w.Header().Set("ETag", etag(g.Revision))
	return httpapi.OK(w, r, 200, galleryView(g))
}
func (h handler) create(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
	}
	key, e := application.NormalizeKey(keys[0])
	if e != nil {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
	}
	input, raw, e := decodeInput(w, r)
	if e != nil {
		return e
	}
	hash, e := application.CreationHash(raw)
	if e != nil {
		return e
	}
	g, e := h.service.Create(r.Context(), actor(r), application.CreateCommand{Input: input, IdempotencyKey: key, RequestHash: hash})
	if e != nil {
		return e
	}
	w.Header().Set("ETag", etag(g.Revision))
	return httpapi.OK(w, r, 201, galleryView(g))
}
func (h handler) update(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	expected, e := revision(r)
	if e != nil {
		return e
	}
	input, _, e := decodeInput(w, r)
	if e != nil {
		return e
	}
	g, e := h.service.Update(r.Context(), actor(r), chi.URLParam(r, "id"), input, expected)
	if e != nil {
		return e
	}
	w.Header().Set("ETag", etag(g.Revision))
	return httpapi.OK(w, r, 200, galleryView(g))
}
func (h handler) delete(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	expected, e := revision(r)
	if e != nil {
		return e
	}
	updated, e := h.service.Delete(r.Context(), actor(r), chi.URLParam(r, "id"), expected)
	if e != nil {
		return e
	}
	w.Header().Set("ETag", etag(updated))
	return httpapi.OK(w, r, 200, struct {
		Accepted bool `json:"accepted"`
	}{true})
}
func decodeInput(w http.ResponseWriter, r *http.Request) (domain.Input, map[string]any, error) {
	var raw map[string]any
	var c domain.Input
	if e := httpapi.Decode(w, r, &raw); e != nil {
		return c, nil, e
	}
	if raw == nil {
		return c, nil, domain.ErrInvalid
	}
	for field := range raw {
		if field != "title" && field != "description" && field != "kind" && field != "assetIds" && field != "mainAssetId" {
			return c, nil, httpapi.Fail(400, "UNKNOWN_FIELD", "请求包含未知字段。")
		}
	}
	title, ok := raw["title"].(string)
	if !ok {
		return c, nil, domain.ErrInvalid
	}
	desc, ok := raw["description"].(string)
	if !ok {
		return c, nil, domain.ErrInvalid
	}
	kind, ok := raw["kind"].(string)
	if !ok {
		return c, nil, domain.ErrInvalid
	}
	ids, ok := raw["assetIds"].([]any)
	if !ok {
		return c, nil, domain.ErrInvalid
	}
	c = domain.Input{Title: title, Description: desc, Kind: domain.Kind(kind), AssetIDs: []string{}}
	for _, value := range ids {
		id, ok := value.(string)
		if !ok {
			return c, nil, domain.ErrInvalid
		}
		c.AssetIDs = append(c.AssetIDs, id)
	}
	if value, ok := raw["mainAssetId"]; ok && value != nil {
		id, ok := value.(string)
		if !ok {
			return c, nil, domain.ErrInvalid
		}
		c.MainAssetID = &id
	}
	return c, raw, c.Validate()
}
func queryValues(r *http.Request, allowed ...string) (url.Values, error) {
	v, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, domain.ErrInvalid
	}
	for field, values := range v {
		known := false
		for _, name := range allowed {
			if field == name {
				known = true
				break
			}
		}
		if !known {
			return nil, httpapi.Fail(400, "UNKNOWN_QUERY_PARAMETER", "请求包含未知查询参数。")
		}
		if len(values) != 1 || !utf8.ValidString(values[0]) {
			return nil, domain.ErrInvalid
		}
	}
	return v, nil
}

var strongETag = regexp.MustCompile(`^"[1-9][0-9]*"$`)

func revision(r *http.Request) (int64, error) {
	v := r.Header.Values("If-Match")
	if len(v) == 0 {
		return 0, httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要素材库revision的强ETag作为If-Match。")
	}
	if len(v) != 1 || len(v[0]) > 32 || !strongETag.MatchString(v[0]) {
		return 0, domain.ErrInvalid
	}
	n, e := strconv.ParseInt(strings.Trim(v[0], `"`), 10, 64)
	if e != nil {
		return 0, domain.ErrInvalid
	}
	return n, nil
}
func etag(n int64) string { return fmt.Sprintf(`"%d"`, n) }
func mapError(e error) error {
	if e == nil {
		return nil
	}
	var conflict *domain.VersionConflict
	if errors.As(e, &conflict) {
		api := httpapi.Fail(412, "VERSION_CONFLICT", "素材库已更新，请重新读取。")
		api.Details = []httpapi.Detail{{Field: "/headers/If-Match", Code: "CURRENT_REVISION", Message: fmt.Sprintf("%d", conflict.Current)}}
		return api
	}
	switch {
	case errors.Is(e, domain.ErrUnauthenticated):
		return httpapi.Fail(401, "UNAUTHENTICATED", "需要有效登录。")
	case errors.Is(e, domain.ErrInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "素材库参数无效。")
	case errors.Is(e, domain.ErrNotFound):
		return httpapi.Fail(404, "LIBRARY_ITEM_NOT_FOUND", "素材库条目不存在。")
	case errors.Is(e, domain.ErrAssetNotFound):
		return httpapi.Fail(404, "ASSET_NOT_FOUND", "图片素材不存在或尚未就绪。")
	case errors.Is(e, domain.ErrIdempotencyConflict):
		return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "幂等键已用于其他请求。")
	case errors.Is(e, domain.ErrUnavailable):
		return httpapi.Retry(503, "LIBRARY_UNAVAILABLE", "素材库存储暂时不可用。")
	default:
		return e
	}
}
