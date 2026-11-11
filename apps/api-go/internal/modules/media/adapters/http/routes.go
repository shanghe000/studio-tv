package http

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/media/application"
	"studiotv.local/service/api/internal/modules/media/domain"
)

func RegisterRoutes(r chi.Router, service *application.Service, protect func(string, httpapi.Handler) http.HandlerFunc) {
	r.MethodFunc("POST", "/api/v2/media-jobs", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		var cmd application.Command
		if err := httpapi.DecodeLimit(w, r, &cmd, 2<<20); err != nil {
			return err
		}
		if len(r.Header.Values("Idempotency-Key")) != 1 {
			return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要有效幂等键。")
		}
		task, err := service.Submit(r.Context(), httpapi.IdentityFrom(r).UserID, r.Header.Get("Idempotency-Key"), cmd)
		if err != nil {
			return mapError(err)
		}
		w.Header().Set("Location", "/api/v2/media-jobs/"+task.ID)
		return respond(w, r, service, 202, task)
	}))
	r.MethodFunc("GET", "/api/v2/media-jobs/{taskId}", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		if r.URL.RawQuery != "" {
			return httpapi.Fail(400, "VALIDATION_FAILED", "查询参数无效。")
		}
		task, err := service.Get(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "taskId"))
		if err != nil {
			return mapError(err)
		}
		return respond(w, r, service, 200, task)
	}))
	r.MethodFunc("POST", "/api/v2/media-jobs/{taskId}/cancel", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		var cmd struct{}
		if err := httpapi.DecodeLimit(w, r, &cmd, 4096); err != nil {
			return err
		}
		task, err := service.Cancel(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "taskId"))
		if err != nil {
			return mapError(err)
		}
		return respond(w, r, service, 202, task)
	}))
}
func mapError(err error) error {
	switch {
	case errors.Is(err, domain.ErrInvalid), errors.Is(err, execution.ErrInvalid):
		return httpapi.Fail(400, "MEDIA_SPEC_INVALID", "媒体处理参数无效。")
	case errors.Is(err, execution.ErrNotFound):
		return httpapi.Fail(404, "TASK_NOT_FOUND", "处理任务不存在。")
	case errors.Is(err, execution.ErrConflict):
		return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "幂等请求冲突。")
	}
	return err
}
func respond(w http.ResponseWriter, r *http.Request, service *application.Service, status int, t execution.Task) error {
	state := t.State
	if state == "SUCCEEDED" {
		state = "SUCCESS"
	}
	outputs := []map[string]any{}
	var firstURL any
	for _, p := range t.Plans {
		for _, o := range p.Outputs {
			if o.AssetID == nil {
				continue
			}
			url, err := service.OutputURL(r.Context(), httpapi.IdentityFrom(r).UserID, httpapi.IdentityFrom(r).SessionID, *o.AssetID)
			if err != nil {
				return err
			}
			if firstURL == nil {
				firstURL = url
			}
			outputs = append(outputs, map[string]any{"assetId": *o.AssetID, "url": url, "objectKey": *o.AssetID, "durationMs": o.DurationMs, "width": o.Width, "height": o.Height, "taskId": t.ID, "jobId": t.ID})
		}
	}
	w.Header().Set("ETag", `"`+strconv.FormatInt(t.Revision, 10)+`"`)
	return httpapi.OK(w, r, status, map[string]any{"task": t, "taskId": t.ID, "jobId": t.ID, "id": t.ID, "status": state, "state": t.State, "revision": t.Revision, "outputs": outputs, "outputUrl": firstURL, "videoUrl": firstURL, "errorCode": t.ErrorCode, "errorMsg": t.ErrorCode, "testMode": t.TestMode})
}
