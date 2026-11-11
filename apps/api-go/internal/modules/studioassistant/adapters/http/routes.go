package http

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	adomain "studiotv.local/service/api/internal/modules/assistant/domain"
	edomain "studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/modules/studioassistant/application"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc

func RegisterRoutes(r chi.Router, s *application.Service, protect Protect) error {
	if r == nil || s == nil || protect == nil {
		return errors.New("HF HTTP ports required")
	}
	reg := func(method, path string, f httpapi.Handler) {
		r.MethodFunc(method, path, protect("tv.access", func(w http.ResponseWriter, req *http.Request) error {
			if httpapi.IdentityFrom(req).UserID == "" {
				return httpapi.Fail(401, "UNAUTHENTICATED", "请登录。")
			}
			return failure(f(w, req))
		}))
	}
	reg("POST", "/api/v2/hf/conversations/{cid}/agent", func(w http.ResponseWriter, r *http.Request) error {
		var body struct{}
		if e := httpapi.Decode(w, r, &body); e != nil {
			return e
		}
		id, e := s.Agent(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "cid"), r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 201, map[string]string{"agentId": id})
	})
	reg("POST", "/api/v2/hf/conversations/{cid}/runs", func(w http.ResponseWriter, r *http.Request) error {
		var body application.Command
		if e := httpapi.Decode(w, r, &body); e != nil {
			return e
		}
		task, e := s.Run(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "cid"), r.Header.Get("Idempotency-Key"), body)
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 202, task)
	})
	return nil
}
func failure(e error) error {
	switch {
	case e == nil:
		return nil
	case errors.Is(e, adomain.ErrInvalid), errors.Is(e, edomain.ErrInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "HF请求参数不符合协议。")
	case errors.Is(e, adomain.ErrConversationNotFound), errors.Is(e, edomain.ErrNotFound):
		return httpapi.Fail(404, "CONVERSATION_NOT_FOUND", "会话不存在。")
	case errors.Is(e, adomain.ErrIdempotencyConflict), errors.Is(e, edomain.ErrConflict), errors.Is(e, edomain.ErrBusy):
		return httpapi.Fail(409, "CONVERSATION_CONFLICT", "会话正在使用或重试键发生冲突。")
	case errors.Is(e, gateway.ErrNotConfigured):
		return httpapi.Fail(501, "MODEL_ROUTER_NOT_CONFIGURED", "测试模型能力尚未配置。")
	case errors.Is(e, adomain.ErrUnavailable):
		return httpapi.Retry(503, "DATABASE_UNAVAILABLE", "会话存储暂不可用。")
	}
	var conflict *adomain.VersionConflict
	if errors.As(e, &conflict) {
		return httpapi.Fail(412, "VERSION_CONFLICT", "会话版本已更新。")
	}
	return e
}
