// Package http exposes the implemented assistant-extension DTOs using the shared
// HTTP envelope. Authentication and live authorization belong to bootstrap.
package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

// Protect must verify the session, check the named live capability, then set
// httpapi.WithIdentity. It must also wrap errors with httpapi.Wrap/RequireAuth.
// A nil decorator is rejected before registering any routes.
type Protect func(capability string, next httpapi.Handler) http.HandlerFunc

func RegisterRoutes(router chi.Router, service *application.Service, protect Protect) error {
	if router == nil || service == nil || protect == nil {
		return errors.New("assistant router, service and trusted auth decorator are required")
	}
	h := &handler{service: service}
	register := func(method, path string, next httpapi.Handler) {
		router.MethodFunc(method, path, protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if err := actor(r).Validate(); err != nil {
				return mapError(err)
			}
			return mapError(next(w, r))
		}))
	}
	register("GET", "/api/v2/conversations", h.list)
	register("POST", "/api/v2/conversations", h.create)
	register("GET", "/api/v2/conversations/{id}", h.detail)
	register("DELETE", "/api/v2/conversations/{id}", h.delete)
	register("GET", "/api/v2/conversations/{id}/messages", h.messages)
	register("POST", "/api/v2/conversations/{id}/messages", h.appendMessage)
	register("DELETE", "/api/v2/conversations/{id}/turns/{turnId}", h.deleteTurn)
	register("DELETE", "/api/v2/conversations/{id}/messages/{messageId}", h.deleteMessage)
	register("GET", "/api/v2/conversations/{id}/client-tools/pending", h.pendingClientTools)
	register("POST", "/api/v2/conversations/{id}/runs", func(w http.ResponseWriter, r *http.Request) error {
		if err := h.service.Visible(r.Context(), actor(r), chi.URLParam(r, "id")); err != nil {
			return err
		}
		return httpapi.Fail(501, "NOT_IMPLEMENTED", "Agent运行尚未实现，未提交模型调用。")
	})
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/v2/assistant-runs/{id}"},
		{"GET", "/api/v2/assistant-runs/{id}/events"},
		{"POST", "/api/v2/assistant-runs/{id}/cancel"},
		{"POST", "/api/v2/assistant-runs/{id}/tool-calls/{callId}/result"},
	} {
		register(route.method, route.path, func(http.ResponseWriter, *http.Request) error {
			return httpapi.Fail(501, "NOT_IMPLEMENTED", "Agent运行尚未实现，未提交模型调用。")
		})
	}
	return nil
}

type handler struct{ service *application.Service }

func actor(r *http.Request) domain.VerifiedActor {
	return domain.VerifiedActor{OwnerID: httpapi.IdentityFrom(r).UserID}
}

func (h *handler) list(w http.ResponseWriter, r *http.Request) error {
	values, err := queryValues(r, "page", "size", "keyword", "kind", "projectId", "hfProjectId")
	if err != nil {
		return err
	}
	page, err := pageQuery(values)
	if err != nil {
		return err
	}
	query := domain.ConversationQuery{PageQuery: page}
	if value, ok := values["kind"]; ok {
		kind := domain.Kind(value[0])
		query.Kind = &kind
	}
	if value, ok := values["projectId"]; ok {
		query.ProjectID = &value[0]
	}
	if value, ok := values["hfProjectId"]; ok {
		query.HFProjectID = &value[0]
	}
	result, err := h.service.List(r.Context(), actor(r), query)
	if err != nil {
		return err
	}
	records := make([]conversationDTO, 0, len(result.Records))
	for _, root := range result.Records {
		records = append(records, conversationView(root))
	}
	return httpapi.OK(w, r, 200, pageDTO[conversationDTO]{records, result.Page, result.Size, result.Total, result.HasNext})
}

func (h *handler) create(w http.ResponseWriter, r *http.Request) error {
	if _, err := queryValues(r); err != nil {
		return err
	}
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
	}
	key, err := application.NormalizeKey(keys[0])
	if err != nil {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
	}
	var raw map[string]any
	if err := httpapi.Decode(w, r, &raw); err != nil {
		return err
	}
	if raw == nil {
		return domain.ErrInvalid
	}
	for field := range raw {
		if field != "kind" && field != "projectId" && field != "hfProjectId" && field != "title" {
			return httpapi.Fail(400, "UNKNOWN_FIELD", "请求包含未知字段。")
		}
	}
	kind, kindOK := raw["kind"].(string)
	title, titleOK := raw["title"].(string)
	if !kindOK || !titleOK {
		return domain.ErrInvalid
	}
	command := domain.Create{Kind: domain.Kind(kind), Title: title}
	for _, field := range []string{"projectId", "hfProjectId"} {
		value, present := raw[field]
		if !present || value == nil {
			continue
		}
		id, ok := value.(string)
		if !ok {
			return domain.ErrInvalid
		}
		if field == "projectId" {
			command.ProjectID = &id
		} else {
			command.HFProjectID = &id
		}
	}
	if err := command.Validate(); err != nil {
		return err
	}
	hash, err := application.CreationHash(raw)
	if err != nil {
		return err
	}
	root, err := h.service.Create(r.Context(), actor(r), application.CreateCommand{Input: command, IdempotencyKey: key, RequestHash: hash})
	if err != nil {
		return err
	}
	w.Header().Set("ETag", etag(root.Revision))
	return httpapi.OK(w, r, 201, conversationView(root))
}

func (h *handler) messages(w http.ResponseWriter, r *http.Request) error {
	values, err := queryValues(r, "page", "size", "keyword")
	if err != nil {
		return err
	}
	query, err := pageQuery(values)
	if err != nil {
		return err
	}
	result, err := h.service.Messages(r.Context(), actor(r), chi.URLParam(r, "id"), query)
	if err != nil {
		return err
	}
	records := make([]messageDTO, 0, len(result.Records))
	for _, message := range result.Records {
		records = append(records, messageView(message))
	}
	return httpapi.OK(w, r, 200, pageDTO[messageDTO]{records, result.Page, result.Size, result.Total, result.HasNext})
}

func (h *handler) detail(w http.ResponseWriter, r *http.Request) error {
	if _, err := queryValues(r); err != nil {
		return err
	}
	root, err := h.service.Detail(r.Context(), actor(r), chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	w.Header().Set("ETag", etag(root.Revision))
	return httpapi.OK(w, r, 200, conversationView(root))
}

func (h *handler) appendMessage(w http.ResponseWriter, r *http.Request) error {
	if _, err := queryValues(r); err != nil {
		return err
	}
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
	}
	key, err := application.NormalizeKey(keys[0])
	if err != nil {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
	}
	revision, err := expectedRevision(r)
	if err != nil {
		return err
	}
	var body map[string]json.RawMessage
	if err = httpapi.Decode(w, r, &body); err != nil {
		return err
	}
	for field := range body {
		if field != "content" {
			return httpapi.Fail(400, "UNKNOWN_FIELD", "请求包含未知字段。")
		}
	}
	result, err := h.service.AppendMessage(r.Context(), actor(r), chi.URLParam(r, "id"), application.AppendMessageCommand{Content: body["content"], IdempotencyKey: key, ExpectedRevision: revision})
	if err != nil {
		return err
	}
	w.Header().Set("ETag", etag(result.ConversationRevision))
	return httpapi.OK(w, r, 201, messageReceiptDTO{messageView(result.Message), result.ConversationRevision})
}

var strongETag = regexp.MustCompile(`^"[1-9][0-9]*"$`)

func expectedRevision(r *http.Request) (int64, error) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		return 0, httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要会话revision的强ETag作为If-Match。")
	}
	if len(values) != 1 || len(values[0]) > 32 || !strongETag.MatchString(values[0]) {
		return 0, httpapi.Fail(400, "VALIDATION_FAILED", "If-Match必须为正整数强ETag。")
	}
	revision, err := strconv.ParseInt(strings.Trim(values[0], `"`), 10, 64)
	if err != nil {
		return 0, domain.ErrInvalid
	}
	return revision, nil
}

func (h *handler) delete(w http.ResponseWriter, r *http.Request) error {
	if _, err := queryValues(r); err != nil {
		return err
	}
	revision, err := expectedRevision(r)
	if err != nil {
		return err
	}
	updated, err := h.service.Delete(r.Context(), actor(r), chi.URLParam(r, "id"), revision)
	if err != nil {
		return err
	}
	w.Header().Set("ETag", etag(updated))
	return httpapi.OK(w, r, 200, struct {
		Accepted bool `json:"accepted"`
	}{true})
}

func queryValues(r *http.Request, allowed ...string) (url.Values, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, domain.ErrInvalid
	}
	for field, entries := range values {
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
		if len(entries) != 1 || !utf8.ValidString(entries[0]) {
			return nil, domain.ErrInvalid
		}
	}
	return values, nil
}
func pageQuery(values url.Values) (domain.PageQuery, error) {
	q := domain.PageQuery{Page: 1, Size: 20, Keyword: strings.TrimSpace(values.Get("keyword"))}
	for _, field := range []string{"page", "size"} {
		if raw, present := values[field]; present {
			v, err := strconv.Atoi(raw[0])
			if err != nil || strconv.Itoa(v) != raw[0] {
				return q, domain.ErrInvalid
			}
			if field == "page" {
				q.Page = v
			} else {
				q.Size = v
			}
		}
	}
	return q, q.Validate()
}
func etag(revision int64) string { return fmt.Sprintf(`"%d"`, revision) }

func mapError(err error) error {
	if err == nil {
		return nil
	}
	var conflict *domain.VersionConflict
	if errors.As(err, &conflict) {
		api := httpapi.Fail(412, "VERSION_CONFLICT", "会话已更新，请重新读取。")
		api.Details = []httpapi.Detail{{Field: "/headers/If-Match", Code: "CURRENT_REVISION", Message: strconv.FormatInt(conflict.Current, 10)}}
		return api
	}
	switch {
	case errors.Is(err, domain.ErrInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "请求字段不符合接口协议。")
	case errors.Is(err, domain.ErrUnauthenticated):
		return httpapi.Fail(401, "UNAUTHENTICATED", "需要已验证的登录身份。")
	case errors.Is(err, domain.ErrProjectNotFound):
		return httpapi.Fail(404, "PROJECT_NOT_FOUND", "项目不存在。")
	case errors.Is(err, domain.ErrConversationNotFound):
		return httpapi.Fail(404, "CONVERSATION_NOT_FOUND", "会话不存在。")
	case errors.Is(err, domain.ErrMessageNotFound):
		return httpapi.Fail(404, "MESSAGE_NOT_FOUND", "消息不存在。")
	case errors.Is(err, domain.ErrTaskActive):
		return httpapi.Fail(409, "ASSISTANT_TASK_ACTIVE", "受影响的会话任务正在运行，请等待完成或取消后再操作。")
	case errors.Is(err, domain.ErrDeletionTooLarge):
		return httpapi.Fail(413, "TURN_TOO_LARGE", "该轮消息超过单次删除上限，请先删除部分回复。")
	case errors.Is(err, domain.ErrLifecycleUnavailable):
		return httpapi.Fail(501, "NOT_IMPLEMENTED", "消息生命周期存储尚未实现。")
	case errors.Is(err, domain.ErrClientToolsUnavailable):
		return httpapi.Fail(501, "CLIENT_TOOLS_UNAVAILABLE", "已记录的客户端工具调用尚缺少可用的回执与恢复协议。")
	case errors.Is(err, domain.ErrIdempotencyConflict):
		return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "该Idempotency-Key已用于不同请求。")
	case errors.Is(err, domain.ErrHFUnavailable):
		return httpapi.Fail(501, "NOT_IMPLEMENTED", "HF会话持久化尚未实现。")
	case errors.Is(err, domain.ErrMessagePartsUnavailable):
		return httpapi.Fail(501, "NOT_IMPLEMENTED", "仅支持用户TEXT消息；素材授权与STRUCTURED写入尚未实现。")
	case errors.Is(err, domain.ErrUnavailable):
		return httpapi.Retry(503, "ASSISTANT_UNAVAILABLE", "会话存储暂时不可用。")
	default:
		return err
	}
}
