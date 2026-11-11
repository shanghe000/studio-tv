// Package http exposes product requirements and actual Router availability.
package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc

func RegisterRoutes(router chi.Router, gateway application.Gateway, protect Protect) error {
	if router == nil || gateway == nil || protect == nil {
		return errors.New("model gateway and trusted route decorator are required")
	}
	register := func(path string, next httpapi.Handler) {
		handler := protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if httpapi.IdentityFrom(r).UserID == "" {
				return httpapi.Fail(401, "UNAUTHENTICATED", "需要已验证的登录身份。")
			}
			return next(w, r)
		})
		router.MethodFunc(http.MethodGet, path, func(w http.ResponseWriter, r *http.Request) {
			if path == capabilityVersionPath || path == "/api/v2/model-capabilities" {
				w.Header().Set("Cache-Control", "no-store")
			}
			handler(w, r)
		})
	}
	register("/api/v2/model-requirements", func(w http.ResponseWriter, r *http.Request) error {
		if _, err := query(r); err != nil {
			return err
		}
		return httpapi.OK(w, r, 200, struct {
			Items         []application.Requirement `json:"items"`
			SchemaVersion string                    `json:"schemaVersion"`
		}{application.Requirements(), "1"})
	})
	register("/api/v2/model-capabilities", func(w http.ResponseWriter, r *http.Request) error {
		values, err := query(r, "kind", "limit", "cursor")
		if err != nil {
			return err
		}
		q := application.CapabilityQuery{Kind: values.Get("kind"), Cursor: values.Get("cursor"), Limit: 100}
		if values.Has("kind") && !kindPattern.MatchString(q.Kind) {
			return httpapi.Fail(400, "VALIDATION_FAILED", "能力kind格式不正确。")
		}
		if len(q.Cursor) > 2000 {
			return httpapi.Fail(400, "VALIDATION_FAILED", "分页游标过长。")
		}
		if raw, ok := values["limit"]; ok {
			q.Limit, err = strconv.Atoi(raw[0])
			if err != nil || strconv.Itoa(q.Limit) != raw[0] || q.Limit < 1 || q.Limit > 100 {
				return httpapi.Fail(400, "VALIDATION_FAILED", "limit须为1至100。")
			}
		}
		actor := application.Actor{SubjectRef: httpapi.IdentityFrom(r).UserID}
		result, err := gateway.Capabilities(r.Context(), actor, q)
		if err != nil {
			if errors.Is(err, application.ErrNotConfigured) {
				return httpapi.Fail(501, "MODEL_ROUTER_NOT_CONFIGURED", "模型基础服务尚未配置。")
			}
			var fault *application.Fault
			if errors.As(err, &fault) && (fault.Code == "INVALID_QUERY" || fault.Code == "INVALID_REQUEST") {
				return httpapi.Fail(400, "VALIDATION_FAILED", "模型目录查询参数不支持。")
			}
			return httpapi.Retry(503, "MODEL_CATALOG_UNAVAILABLE", "模型能力目录暂时不可用。")
		}
		items := make([]capabilityDTO, 0, len(result.Items))
		for _, item := range result.Items {
			items = append(items, capabilityDTO{item.Ref, item.Version, item.Kind, item.ExecutionKind, item.ParameterSchemaVersion, item.ParameterSchema, item.InputKinds, item.OutputKinds, item.SupportsSession, item.SessionMode, item.SupportsStream, item.SupportsCancel, item.Available, item.Reason, item.Title, item.TestMode, item.Model})
		}
		return httpapi.OK(w, r, 200, struct {
			Items         []capabilityDTO `json:"items"`
			NextCursor    *string         `json:"nextCursor"`
			SchemaVersion string          `json:"schemaVersion"`
		}{items, result.NextCursor, "1"})
	})
	registerCapabilityVersion(register, gateway)
	registerProviderCredentials(router, gateway, protect)
	registerPriceEstimates(router, gateway, protect)
	return nil
}

type capabilityDTO struct {
	Ref                    string                       `json:"capabilityRef"`
	Version                string                       `json:"version"`
	Kind                   string                       `json:"kind"`
	ExecutionKind          string                       `json:"executionKind"`
	ParameterSchemaVersion string                       `json:"parameterSchemaVersion"`
	ParameterSchema        json.RawMessage              `json:"parameterSchema"`
	InputKinds             []string                     `json:"inputKinds"`
	OutputKinds            []string                     `json:"outputKinds"`
	SupportsSession        bool                         `json:"supportsSession"`
	SessionMode            *string                      `json:"sessionMode,omitempty"`
	SupportsStream         bool                         `json:"supportsStream"`
	SupportsCancel         bool                         `json:"supportsCancel"`
	Available              bool                         `json:"available"`
	Reason                 *string                      `json:"reason"`
	Title                  string                       `json:"title,omitempty"`
	TestMode               bool                         `json:"testMode"`
	Model                  *application.ModelDescriptor `json:"model,omitempty"`
}

var kindPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

func query(r *http.Request, allowed ...string) (url.Values, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, httpapi.Fail(400, "VALIDATION_FAILED", "查询参数格式不正确。")
	}
	for name, entries := range values {
		known := false
		for _, field := range allowed {
			if name == field {
				known = true
				break
			}
		}
		if !known {
			return nil, httpapi.Fail(400, "UNKNOWN_QUERY_PARAMETER", "包含未知查询参数。")
		}
		if len(entries) != 1 || !utf8.ValidString(entries[0]) {
			return nil, httpapi.Fail(400, "VALIDATION_FAILED", "查询参数不可重复。")
		}
	}
	return values, nil
}
