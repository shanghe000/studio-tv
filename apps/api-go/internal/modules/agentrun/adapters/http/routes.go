package http

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/url"
	"regexp"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	"strconv"
	"strings"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc

func actor(r *http.Request) application.Actor {
	i := httpapi.IdentityFrom(r)
	return application.Actor{OwnerID: i.UserID, SessionID: i.SessionID, IssuedAt: i.AccessIssuedAt, AccessExpiresAt: i.AccessExpiresAt, SessionExpiresAt: i.SessionExpiresAt}
}
func bearer(r *http.Request) (string, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", domain.ErrAuth
	}
	v := strings.TrimPrefix(values[0], "Bearer ")
	if v == "" || strings.ContainsAny(v, " \r\n\x00") {
		return "", domain.ErrAuth
	}
	return v, nil
}
func RegisterRoutes(router chi.Router, s *application.Service, protect Protect) error {
	if router == nil || s == nil || protect == nil {
		return errors.New("agent HTTP dependencies required")
	}
	streams := newAdmission()
	register := func(method, path string, h httpapi.Handler) {
		router.MethodFunc(method, path, protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if actor(r).OwnerID == "" {
				return mapError(domain.ErrAuth)
			}
			return mapError(h(w, r))
		}))
	}
	register("GET", "/api/v2/agent-capabilities", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := query(r); e != nil {
			return e
		}
		enabled := s.Enabled()
		caps := []any{}
		if enabled {
			caps = append(caps, map[string]any{"capabilityRef": application.CapabilityRef, "capabilityVersion": application.CapabilityVersion, "version": application.CapabilityVersion, "parameterSchemaVersion": "2", "parameterSchema": map[string]any{"type": "object", "properties": map[string]any{"reasoningEffort": map[string]any{"type": "string", "enum": []string{"low", "high"}, "default": "low"}}, "additionalProperties": false}, "inputKinds": []string{"TEXT"}, "historyTextOnly": true})
		}
		return httpapi.OK(w, r, 200, map[string]any{"enabled": enabled, "version": "1", "toolExecutionAvailable": enabled, "capabilities": caps})
	})
	register("POST", "/api/v2/conversations/{id}/agent-runs", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := query(r); e != nil {
			return e
		}
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 {
			return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
		}
		token, e := bearer(r)
		if e != nil {
			return e
		}
		var cmd application.CreateCommand
		if e = httpapi.Decode(w, r, &cmd); e != nil {
			return e
		}
		run, e := s.Create(r.Context(), actor(r), token, chi.URLParam(r, "id"), keys[0], cmd)
		if e != nil {
			return e
		}
		w.Header().Set("ETag", `"`+run.CredentialEpoch+`"`)
		return httpapi.OK(w, r, 202, run)
	})
	register("GET", "/api/v2/conversations/{id}/agent-runs", func(w http.ResponseWriter, r *http.Request) error {
		q, e := query(r, "state")
		if e != nil {
			return e
		}
		if q.Get("state") != "active" {
			return domain.ErrInvalid
		}
		runs, e := s.ListActive(r.Context(), actor(r).OwnerID, chi.URLParam(r, "id"))
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, map[string]any{"items": runs, "records": runs})
	})
	register("GET", "/api/v2/agent-runs/{id}", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := query(r); e != nil {
			return e
		}
		run, e := s.Get(r.Context(), actor(r).OwnerID, chi.URLParam(r, "id"))
		if e != nil {
			return e
		}
		w.Header().Set("ETag", `"`+run.CredentialEpoch+`"`)
		return httpapi.OK(w, r, 200, run)
	})
	register("POST", "/api/v2/agent-runs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := query(r); e != nil {
			return e
		}
		var body struct{}
		if e := httpapi.Decode(w, r, &body); e != nil {
			return e
		}
		run, e := s.Cancel(r.Context(), actor(r).OwnerID, chi.URLParam(r, "id"))
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 202, run)
	})
	register("GET", "/api/v2/agent-runs/{id}/auth-context", func(w http.ResponseWriter, r *http.Request) error {
		if _, err := query(r); err != nil {
			return err
		}
		run, err := s.Get(r.Context(), actor(r).OwnerID, chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		if actor(r).SessionID != run.ParentSessionID {
			return domain.ErrParentSession
		}
		w.Header().Set("ETag", `"`+run.CredentialEpoch+`"`)
		return httpapi.OK(w, r, 200, run)
	})
	register("PUT", "/api/v2/agent-runs/{id}/auth-context", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := query(r); e != nil {
			return e
		}
		var body struct{}
		if e := httpapi.Decode(w, r, &body); e != nil {
			return e
		}
		headers := r.Header.Values("If-Match")
		if len(headers) == 0 {
			return httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要credentialEpoch的强ETag。")
		}
		if len(headers) != 1 || !regexp.MustCompile(`^"[1-9][0-9]*"$`).MatchString(headers[0]) || len(headers[0]) > 22 {
			return domain.ErrInvalid
		}
		epoch := strings.Trim(headers[0], `"`)
		token, e := bearer(r)
		if e != nil {
			return e
		}
		run, e := s.UpdateAuth(r.Context(), actor(r), token, chi.URLParam(r, "id"), epoch)
		if e != nil {
			return e
		}
		w.Header().Set("ETag", `"`+run.CredentialEpoch+`"`)
		return httpapi.OK(w, r, 200, run)
	})
	register("GET", "/api/v2/agent/tools", func(w http.ResponseWriter, r *http.Request) error {
		q, e := query(r, "runId")
		if e != nil {
			return e
		}
		if q.Get("runId") == "" {
			return domain.ErrInvalid
		}
		if _, e = s.Get(r.Context(), actor(r).OwnerID, q.Get("runId")); e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, map[string]any{"schemaVersion": "1", "toolSchemaHash": application.SchemaHash(), "available": s.Enabled(), "items": application.Tools()})
	})
	register("GET", "/api/v2/agent-runs/{id}/events", func(w http.ResponseWriter, r *http.Request) error {
		q, e := query(r, "after", "limit")
		if e != nil {
			return e
		}
		raw := q.Get("after")
		last := r.Header.Values("Last-Event-ID")
		if len(last) > 1 || len(last) == 1 && raw != "" && raw != last[0] {
			return domain.ErrInvalid
		}
		if len(last) == 1 {
			raw = last[0]
		}
		if raw == "" {
			raw = "0"
		}
		after, e := strconv.ParseInt(raw, 10, 64)
		if e != nil || after < 0 || strconv.FormatInt(after, 10) != raw {
			return domain.ErrInvalid
		}
		limit := 100
		if q.Has("limit") {
			limit, e = strconv.Atoi(q.Get("limit"))
			if e != nil || limit < 1 || limit > 100 || strconv.Itoa(limit) != q.Get("limit") {
				return domain.ErrInvalid
			}
		}
		if wantsSSE(r) {
			return streams.serve(w, r, s, chi.URLParam(r, "id"), after, limit)
		}
		page, e := s.Events(r.Context(), actor(r).OwnerID, chi.URLParam(r, "id"), after, limit)
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, page)
	})
	return nil
}
func query(r *http.Request, allowed ...string) (url.Values, error) {
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, domain.ErrInvalid
	}
	for name, entries := range q {
		known := false
		for _, a := range allowed {
			if a == name {
				known = true
			}
		}
		if !known || len(entries) != 1 || entries[0] == "" {
			return nil, domain.ErrInvalid
		}
	}
	return q, nil
}
func mapError(e error) error {
	var version *domain.VersionConflict
	if errors.As(e, &version) {
		return httpapi.Fail(412, "VERSION_CONFLICT", "画布已更新，请重新读取。")
	}
	switch {
	case e == nil:
		return nil
	case errors.Is(e, domain.ErrInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "Agent请求字段不符合协议。")
	case errors.Is(e, domain.ErrNotFound):
		return httpapi.Fail(404, "AGENT_RESOURCE_NOT_FOUND", "Agent运行或会话不存在。")
	case errors.Is(e, domain.ErrActive):
		return httpapi.Fail(409, "ASSISTANT_TASK_ACTIVE", "当前会话已有活动运行。")
	case errors.Is(e, domain.ErrConflict):
		return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "请求摘要或画布修订与已冻结请求冲突。")
	case errors.Is(e, domain.ErrDisabled):
		return httpapi.Fail(501, "AGENT_RUNTIME_NOT_CONFIGURED", "Agent工具运行时未配置或所选型号尚未验收。")
	case errors.Is(e, domain.ErrAuth):
		return httpapi.Fail(401, "AGENT_AUTH_CONTEXT_REQUIRED", "需要同一用户和登录会话的有效凭证。")
	case errors.Is(e, domain.ErrAuthVersion):
		return httpapi.Fail(412, "CREDENTIAL_EPOCH_CONFLICT", "凭证已更新，请重新读取credentialEpoch。")
	case errors.Is(e, domain.ErrParentSession):
		return httpapi.Fail(409, "AGENT_PARENT_SESSION_MISMATCH", "旧Agent运行属于另一登录会话；可查看、取消或发起新运行。")
	case errors.Is(e, domain.ErrAuthRegression):
		return httpapi.Fail(409, "CREDENTIAL_REGRESSION", "旧凭证不能覆盖已验证的新凭证。")
	case errors.Is(e, domain.ErrUnavailable):
		return httpapi.Retry(503, "AGENT_UNAVAILABLE", "Agent持久化或授权服务暂时不可用。")
	default:
		return e
	}
}
