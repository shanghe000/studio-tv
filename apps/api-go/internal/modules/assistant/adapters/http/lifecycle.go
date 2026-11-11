package http

import (
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/assistant/application"
)

func (h *handler) deleteTurn(w http.ResponseWriter, r *http.Request) error {
	return h.deleteLifecycle(w, r, chi.URLParam(r, "turnId"), true)
}
func (h *handler) deleteMessage(w http.ResponseWriter, r *http.Request) error {
	return h.deleteLifecycle(w, r, chi.URLParam(r, "messageId"), false)
}
func (h *handler) deleteLifecycle(w http.ResponseWriter, r *http.Request, target string, turn bool) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	if r.ContentLength != 0 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "删除消息不接受请求正文。")
	}
	expected, e := expectedRevision(r)
	if e != nil {
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
	result, e := h.service.DeleteMessage(r.Context(), actor(r), chi.URLParam(r, "id"), target, turn, application.MessageDeletionCommand{ExpectedRevision: expected, IdempotencyKey: key})
	if e != nil {
		return e
	}
	w.Header().Set("ETag", etag(result.ConversationRevision))
	return httpapi.OK(w, r, 200, result)
}
func (h *handler) pendingClientTools(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	result, e := h.service.PendingClientTools(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return httpapi.OK(w, r, 200, result)
}
