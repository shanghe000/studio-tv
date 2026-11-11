package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

// RegisterCommandRoutes registers only this implemented command/receipt slice.
// The host supplies verified login and a live tv.access check through Protect.
func RegisterCommandRoutes(router chi.Router, service *application.CommandService, protect Protect) error {
	if router == nil || service == nil || protect == nil {
		return errors.New("canvas command route dependencies required")
	}
	router.MethodFunc("POST", "/api/v2/projects/{projectId}/canvas-commands", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		identity := httpapi.IdentityFrom(r)
		if identity.UserID == "" {
			return httpapi.Fail(401, "UNAUTHENTICATED", "请先使用飞书登录。")
		}
		if r.URL.RawQuery != "" {
			return httpapi.Fail(400, "VALIDATION_FAILED", "画布命令不接受查询参数。")
		}
		revision, err := commandRevision(r)
		if err != nil {
			return err
		}
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 {
			return httpapi.Fail(400, "VALIDATION_FAILED", "需要唯一的UUID Idempotency-Key。")
		}
		key, err := application.NormalizeCommandKey(keys[0])
		if err != nil {
			return commandHTTPError(err)
		}
		var raw json.RawMessage
		if err = httpapi.Decode(w, r, &raw); err != nil {
			return err
		}
		receipt, err := service.Submit(r.Context(), identity.UserID, chi.URLParam(r, "projectId"), revision, key, raw)
		if err != nil {
			return commandHTTPError(err)
		}
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", receipt.GraphRevision))
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, receipt)
	}))
	router.MethodFunc("GET", "/api/v2/projects/{projectId}/canvas-commands/{commandId}", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		identity := httpapi.IdentityFrom(r)
		if identity.UserID == "" {
			return httpapi.Fail(401, "UNAUTHENTICATED", "请先使用飞书登录。")
		}
		if r.URL.RawQuery != "" {
			return httpapi.Fail(400, "VALIDATION_FAILED", "命令回执不接受查询参数。")
		}
		receipt, err := service.Receipt(r.Context(), identity.UserID, chi.URLParam(r, "projectId"), chi.URLParam(r, "commandId"))
		if err != nil {
			return commandHTTPError(err)
		}
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", receipt.GraphRevision))
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, receipt)
	}))
	return nil
}

var commandStrongETag = regexp.MustCompile(`^"[1-9][0-9]*"$`)

func commandRevision(r *http.Request) (int64, error) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		return 0, httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要画布revision的强ETag作为If-Match。")
	}
	if len(values) != 1 || len(values[0]) > 32 || !commandStrongETag.MatchString(values[0]) {
		return 0, httpapi.Fail(400, "VALIDATION_FAILED", "If-Match必须为正整数强ETag。")
	}
	revision, err := strconv.ParseInt(values[0][1:len(values[0])-1], 10, 64)
	if err != nil {
		return 0, httpapi.Fail(400, "VALIDATION_FAILED", "画布revision无效。")
	}
	return revision, nil
}
func commandHTTPError(err error) error {
	var conflict *domain.CommandVersionConflict
	if errors.As(err, &conflict) {
		result := httpapi.Fail(412, "VERSION_CONFLICT", "画布已更新，请读取当前快照并重新制定命令。")
		result.Details = []httpapi.Detail{{Field: "/headers/If-Match", Code: "CURRENT_REVISION", Message: fmt.Sprint(conflict.Current)}}
		return result
	}
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return httpapi.Fail(404, "PROJECT_NOT_FOUND", "作品不存在或无权访问。")
	case errors.Is(err, domain.ErrCommandReceiptNotFound):
		return httpapi.Fail(404, "CANVAS_COMMAND_NOT_FOUND", "命令回执不存在或无权访问。")
	case errors.Is(err, domain.ErrCommandConflict):
		return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "此幂等键已用于另一条画布命令。")
	case errors.Is(err, domain.ErrAgentContextUnavailable):
		return httpapi.Fail(501, "AGENT_CONTEXT_NOT_IMPLEMENTED", "已登记Agent工具调用尚未接入，不能接受自报Agent身份。")
	case errors.Is(err, domain.ErrCommandUnsupported):
		return httpapi.Fail(501, "CANVAS_COMMAND_NOT_IMPLEMENTED", "此操作、节点输入schema或连线端口尚未实现。")
	case errors.Is(err, domain.ErrCommandInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "画布命令字段、输入或版本无效。")
	case errors.Is(err, domain.ErrGraphOperation):
		return httpapi.Fail(422, "INVALID_GRAPH_OPERATION", "画布命令引用、输入结构或最终变更无效。")
	case errors.Is(err, domain.ErrCommandUnavailable):
		return httpapi.Retry(503, "CANVAS_COMMAND_UNAVAILABLE", "画布命令暂时无法保存，请用原幂等键重试或查询回执。")
	default:
		return err
	}
}
