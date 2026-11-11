package http

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"strconv"
	"strings"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc

func RegisterRoutes(r chi.Router, s *application.Service, protect Protect) error {
	if r == nil || s == nil || protect == nil {
		return errors.New("execution HTTP dependencies required")
	}
	register := func(method, path string, f httpapi.Handler) {
		r.MethodFunc(method, path, protect("tv.access", func(w http.ResponseWriter, req *http.Request) error {
			if httpapi.IdentityFrom(req).UserID == "" {
				return httpapi.Fail(401, "UNAUTHENTICATED", "请登录。")
			}
			return mapError(f(w, req))
		}))
	}
	owner := func(r *http.Request) string { return httpapi.IdentityFrom(r).UserID }
	register("POST", "/api/v2/projects/{projectId}/canvas-executions", func(w http.ResponseWriter, r *http.Request) error {
		if r.URL.RawQuery != "" || len(r.Header.Values("Idempotency-Key")) != 1 {
			return domain.ErrInvalid
		}
		expected, err := revision(r)
		if err != nil {
			return err
		}
		var cmd application.ServerCanvasCommand
		if err = httpapi.Decode(w, r, &cmd); err != nil {
			return err
		}
		task, err := s.ServerCanvas(r.Context(), owner(r), chi.URLParam(r, "projectId"), r.Header.Get("Idempotency-Key"), expected, cmd)
		if err != nil {
			return err
		}
		return reply(w, r, 202, task)
	})
	register("POST", "/api/v2/canvas-runs", func(w http.ResponseWriter, r *http.Request) error {
		var cmd domain.CanvasCommand
		if err := httpapi.DecodeLimit(w, r, &cmd, 3<<20); err != nil {
			return err
		}
		t, err := s.Canvas(r.Context(), owner(r), r.Header.Get("Idempotency-Key"), cmd)
		if err != nil {
			return err
		}
		return reply(w, r, 202, t)
	})
	register("POST", "/api/v2/app-runs", func(w http.ResponseWriter, r *http.Request) error {
		var cmd application.AppCommand
		if e := httpapi.DecodeLimit(w, r, &cmd, 3<<20); e != nil {
			return e
		}
		task, e := s.App(r.Context(), owner(r), r.Header.Get("Idempotency-Key"), cmd)
		if e != nil {
			return e
		}
		return reply(w, r, 202, task)
	})
	detail := func(w http.ResponseWriter, r *http.Request) error {
		t, err := s.Get(r.Context(), owner(r), chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		if cid := chi.URLParam(r, "cid"); cid != "" && (t.ConversationID == nil || *t.ConversationID != cid) {
			return domain.ErrNotFound
		}
		return reply(w, r, 200, t)
	}
	cancel := func(w http.ResponseWriter, r *http.Request) error {
		var body struct{}
		if err := httpapi.Decode(w, r, &body); err != nil {
			return err
		}
		if cid := chi.URLParam(r, "cid"); cid != "" {
			t, err := s.Get(r.Context(), owner(r), chi.URLParam(r, "id"))
			if err != nil {
				return err
			}
			if t.ConversationID == nil || *t.ConversationID != cid {
				return domain.ErrNotFound
			}
		}
		t, err := s.Cancel(r.Context(), owner(r), chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		return reply(w, r, 202, t)
	}
	events := func(w http.ResponseWriter, r *http.Request) error {
		if cid := chi.URLParam(r, "cid"); cid != "" {
			t, err := s.Get(r.Context(), owner(r), chi.URLParam(r, "id"))
			if err != nil {
				return err
			}
			if t.ConversationID == nil || *t.ConversationID != cid {
				return domain.ErrNotFound
			}
		}
		raw := r.URL.Query().Get("after")
		if raw == "" {
			raw = "0"
		}
		after, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 || strconv.FormatInt(after, 10) != raw {
			return domain.ErrInvalid
		}
		page, err := s.Events(r.Context(), owner(r), chi.URLParam(r, "id"), after)
		if err != nil {
			return err
		}
		return httpapi.OK(w, r, 200, page)
	}
	for _, prefix := range []string{"/api/v2/tasks", "/api/v2/assistant-runs"} {
		register("GET", prefix+"/{id}", detail)
		register("GET", prefix+"/{id}/events", events)
		register("POST", prefix+"/{id}/cancel", cancel)
	}
	register("POST", "/api/v2/tasks/batch-status", func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			IDs            []string `json:"ids"`
			IncludeResults bool     `json:"includeResults"`
		}
		if err := httpapi.Decode(w, r, &body); err != nil {
			return err
		}
		if body.IDs == nil || len(body.IDs) > 100 {
			return domain.ErrInvalid
		}
		tasks := []domain.Task{}
		for _, id := range body.IDs {
			t, err := s.Get(r.Context(), owner(r), id)
			if err != nil {
				return err
			}
			if !body.IncludeResults {
				for i := range t.Plans {
					t.Plans[i].Outputs = []domain.Output{}
				}
			}
			tasks = append(tasks, t)
		}
		return httpapi.OK(w, r, 200, map[string]any{"tasks": tasks})
	})
	register("GET", "/api/v2/assistant/conversations/{cid}/runs", func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		if len(q) != 1 || len(q["state"]) != 1 || q.Get("state") != "active" {
			return domain.ErrInvalid
		}
		tasks, e := s.ActiveAssistant(r.Context(), owner(r), chi.URLParam(r, "cid"))
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, map[string]any{"records": tasks})
	})
	createRun := func(w http.ResponseWriter, r *http.Request) error {
		cid := chi.URLParam(r, "cid")
		var cmd application.AssistantCommand
		if err := httpapi.Decode(w, r, &cmd); err != nil {
			return err
		}
		t, err := s.Assistant(r.Context(), owner(r), cid, r.Header.Get("Idempotency-Key"), cmd)
		if err != nil {
			return err
		}
		return reply(w, r, 202, t)
	}
	register("POST", "/api/v2/conversations/{cid}/runs", createRun)
	register("POST", "/api/v2/assistant/conversations/{cid}/runs", createRun)
	prefix := "/api/v2/assistant/conversations/{cid}/runs/{id}"
	register("GET", prefix, detail)
	register("GET", prefix+"/events", events)
	register("POST", prefix+"/cancel", cancel)
	register("GET", "/api/v2/history", func(w http.ResponseWriter, r *http.Request) error {
		q := application.HistoryQuery{ProjectID: r.URL.Query().Get("projectId"), NodeID: r.URL.Query().Get("nodeId"), Type: r.URL.Query().Get("type"), Page: 1, Size: 20}
		for key, dst := range map[string]*int{"page": &q.Page, "size": &q.Size} {
			if raw := r.URL.Query().Get(key); raw != "" {
				n, err := strconv.Atoi(raw)
				if err != nil || strconv.Itoa(n) != raw {
					return domain.ErrInvalid
				}
				*dst = n
			}
		}
		page, err := s.History(r.Context(), owner(r), q)
		if err != nil {
			return err
		}
		return httpapi.OK(w, r, 200, page)
	})
	register("GET", "/api/v2/history/{eid}", func(w http.ResponseWriter, r *http.Request) error {
		h, err := s.HistoryDetail(r.Context(), owner(r), chi.URLParam(r, "eid"))
		if err != nil {
			return err
		}
		w.Header().Set("ETag", etag(h.Revision))
		return httpapi.OK(w, r, 200, h)
	})
	register("POST", "/api/v2/history/delete", func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			IDs []string `json:"ids"`
		}
		if err := httpapi.Decode(w, r, &body); err != nil {
			return err
		}
		ids, err := s.DeleteHistoryIdempotent(r.Context(), owner(r), r.Header.Get("Idempotency-Key"), body.IDs)
		if err != nil {
			return err
		}
		return httpapi.OK(w, r, 200, map[string]any{"deletedIds": ids})
	})
	register("DELETE", "/api/v2/history/{eid}/outputs/{oid}", func(w http.ResponseWriter, r *http.Request) error {
		rev, err := revision(r)
		if err != nil {
			return err
		}
		t, err := s.DeleteOutput(r.Context(), owner(r), chi.URLParam(r, "eid"), chi.URLParam(r, "oid"), rev)
		if err != nil {
			return err
		}
		return reply(w, r, 200, t)
	})
	return nil
}
func reply(w http.ResponseWriter, r *http.Request, status int, t domain.Task) error {
	w.Header().Set("ETag", etag(t.Revision))
	return httpapi.OK(w, r, status, t)
}
func etag(rev int64) string { return `"` + strconv.FormatInt(rev, 10) + `"` }
func revision(r *http.Request) (int64, error) {
	v := r.Header.Values("If-Match")
	if len(v) == 0 {
		return 0, httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要最新revision。")
	}
	if len(v) != 1 || len(v[0]) < 3 || !strings.HasPrefix(v[0], `"`) || !strings.HasSuffix(v[0], `"`) {
		return 0, domain.ErrInvalid
	}
	raw := strings.Trim(v[0], `"`)
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != raw {
		return 0, domain.ErrInvalid
	}
	return n, nil
}
func mapError(err error) error {
	if err == nil {
		return nil
	}
	var changed *application.CanvasRevisionConflict
	if errors.As(err, &changed) {
		return httpapi.Fail(412, "VERSION_CONFLICT", "画布已更新，请重新读取后再执行。")
	}
	switch {
	case errors.Is(err, domain.ErrMaterialOnly):
		return httpapi.Fail(422, "GENERATION_TARGET_REQUIRED", "此节点是上传素材，不能直接生成；请将素材连接到生成节点后再运行。")
	case errors.Is(err, domain.ErrInvalid):
		return httpapi.Fail(422, "VALIDATION_FAILED", "任务参数不符合能力协议。")
	case errors.Is(err, domain.ErrNotFound):
		return httpapi.Fail(404, "TASK_OR_PARENT_NOT_FOUND", "任务或所属资源不存在。")
	case errors.Is(err, domain.ErrConflict):
		return httpapi.Fail(409, "VERSION_OR_IDEMPOTENCY_CONFLICT", "资源已更新或重试键被其他请求使用。")
	case errors.Is(err, domain.ErrCancellationUnsupported):
		return httpapi.Fail(501, "CANCELLATION_UNSUPPORTED", "当前真实模型运行暂不支持停止，请等待结果。")
	case errors.Is(err, domain.ErrBusy):
		return httpapi.Fail(409, "CONVERSATION_BUSY", "请等待当前回复完成。")
	case errors.Is(err, gateway.ErrNotConfigured):
		return httpapi.Fail(501, "MODEL_ROUTER_NOT_CONFIGURED", "模型基础服务尚未配置。")
	}
	var media *application.MediaInputError
	if errors.As(err, &media) {
		return httpapi.Fail(422, "MEDIA_INPUT_INVALID", media.Message)
	}
	var fault *gateway.Fault
	if errors.As(err, &fault) {
		if message, known := gateway.OfficialVideoErrorMessage(fault.Code); known {
			status := http.StatusUnprocessableEntity
			if fault.Code == "OFFICIAL_VIDEO_RATE_LIMITED" {
				status = http.StatusTooManyRequests
			}
			if fault.Code == "PROVIDER_CREDENTIALS_DISABLED" || fault.Code == "OFFICIAL_VIDEO_NOT_CONFIGURED" {
				status = http.StatusServiceUnavailable
			}
			return httpapi.Fail(status, fault.Code, message)
		}
		if fault.Code == "VIDEO_CANCEL_UNSUPPORTED" {
			return httpapi.Fail(501, fault.Code, "当前视频模型不支持中途停止，请等待生成结果。")
		}
		if fault.Code == "PROMPT_TEMPLATE_NOT_CONFIGURED" || fault.Code == "PROMPT_CONDITIONING_UNSUPPORTED" {
			return httpapi.Fail(501, fault.Code, "此功能的 STUDIO 场景或预设尚未配置。")
		}
		if fault.Code == "MODEL_EXECUTION_DISABLED" {
			return httpapi.Fail(501, fault.Code, "真实模型调用尚未启用。")
		}
		if fault.Code == "UNTRUSTED_PROMPT_INSTRUCTIONS" || fault.Code == "PROMPT_CAPABILITY_MISMATCH" || fault.Code == "PROMPT_CONDITIONING_INVALID" || fault.Code == "PROMPT_REFERENCE_REQUIRED" || fault.Code == "PROMPT_SPEC_INVALID" {
			return httpapi.Fail(422, fault.Code, "功能用途、参考条件或提示词结构不符合 STUDIO 协议。")
		}
		if fault.Code == "INVALID_REQUEST" || fault.Code == "CAPABILITY_UNAVAILABLE" {
			return httpapi.Fail(422, fault.Code, "当前模型能力或参数不可用。")
		}
		return httpapi.Retry(503, "MODEL_ROUTER_UNAVAILABLE", "模型基础服务暂时不可用。")
	}
	var api *httpapi.Error
	if errors.As(err, &api) {
		return api
	}
	return httpapi.Retry(503, "EXECUTION_STORAGE_UNAVAILABLE", "任务存储暂时不可用。")
}
