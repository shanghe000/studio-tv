package http

import (
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc

func RegisterRoutes(router chi.Router, service *application.Service, protect Protect) error {
	if router == nil || service == nil || protect == nil {
		return errors.New("canvas context route dependencies required")
	}
	router.MethodFunc("GET", "/api/v2/projects/{projectId}/agent-context", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		if r.URL.RawQuery != "" {
			return httpapi.Fail(400, "VALIDATION_FAILED", "此接口不接受查询参数。")
		}
		identity := httpapi.IdentityFrom(r)
		if identity.UserID == "" {
			return httpapi.Fail(401, "UNAUTHENTICATED", "请先使用飞书登录。")
		}
		value, err := service.Read(r.Context(), identity.UserID, chi.URLParam(r, "projectId"))
		if errors.Is(err, domain.ErrNotFound) {
			return httpapi.Fail(404, "PROJECT_NOT_FOUND", "作品不存在或无权访问。")
		}
		if errors.Is(err, domain.ErrInvalid) {
			return httpapi.Fail(422, "CANVAS_CONTEXT_INVALID", "画布上下文无效。")
		}
		if err != nil {
			return err
		}
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", value.GraphRevision))
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, value)
	}))
	return nil
}
