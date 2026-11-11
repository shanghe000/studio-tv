package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	app "studiotv.local/service/api/internal/modules/longform/application"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/principal"
)

type Protect func(string, httpapi.Handler) http.HandlerFunc
type ArchivedAssetReader func(http.ResponseWriter, *http.Request, string) error

func RegisterRoutes(r chi.Router, s *app.Service, protect Protect, archivedReaders ...ArchivedAssetReader) error {
	if r == nil || s == nil || protect == nil {
		return errors.New("longform HTTP dependencies required")
	}
	if len(archivedReaders) > 1 {
		return errors.New("one archived asset reader expected")
	}
	var archivedReader ArchivedAssetReader
	if len(archivedReaders) == 1 {
		archivedReader = archivedReaders[0]
	}
	register := func(method, path string, h httpapi.Handler) {
		r.MethodFunc(method, path, protect("tv.access", func(w http.ResponseWriter, req *http.Request) error {
			i := httpapi.IdentityFrom(req)
			if i.UserID == "" {
				return httpapi.Fail(401, "UNAUTHENTICATED", "请登录。")
			}
			req = req.WithContext(principal.WithActor(req.Context(), i.UserID))
			w.Header().Set("Cache-Control", "no-store")
			return mapped(h(w, req))
		}))
	}
	caller := func(r *http.Request) app.Caller {
		return app.Caller{Identity: httpapi.IdentityFrom(r), ClientID: r.Header.Get(collaboration.CanvasSessionHeader)}
	}
	register("GET", "/api/v2/longform/capabilities", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.Capabilities(r.Context(), httpapi.IdentityFrom(r).UserID)
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, v)
	})
	register("POST", "/api/v2/longform/projects", func(w http.ResponseWriter, r *http.Request) error {
		var v app.Create
		if e := httpapi.DecodeLimit(w, r, &v, 4<<20); e != nil {
			return e
		}
		out, e := s.Create(r.Context(), caller(r), v)
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 201, out)
	})
	register("GET", "/api/v2/longform/projects", func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		for k, v := range q {
			if k != "canvasId" && k != "nodeId" || len(v) != 1 {
				return httpapi.Fail(400, "VALIDATION_FAILED", "长片查询参数无效。")
			}
		}
		if q.Get("canvasId") == "" {
			return httpapi.Fail(400, "VALIDATION_FAILED", "需要画布标识。")
		}
		v, e := s.List(r.Context(), httpapi.IdentityFrom(r).UserID, q.Get("canvasId"), q.Get("nodeId"))
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, v)
	})
	register("GET", "/api/v2/longform/projects/{id}", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.Get(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "id"))
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, v)
	})
	register("POST", "/api/v2/longform/projects/{id}/actions", func(w http.ResponseWriter, r *http.Request) error {
		raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
		if e != nil || !json.Valid(raw) {
			return httpapi.Fail(400, "VALIDATION_FAILED", "长片操作无效。")
		}
		v, e := s.Action(r.Context(), caller(r), chi.URLParam(r, "id"), raw)
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, v)
	})
	register("GET", "/api/v2/longform/projects/{id}/artifacts/{artifactId}/content", func(w http.ResponseWriter, r *http.Request) error {
		i := httpapi.IdentityFrom(r)
		stored, e := s.ArchivedURL(r.Context(), i.UserID, i.SessionID, chi.URLParam(r, "id"), chi.URLParam(r, "artifactId"))
		if e != nil {
			return e
		}
		if stored != "" {
			location, e := archivedAssetLocation(stored)
			if e != nil {
				return e
			}
			if archivedReader == nil {
				return httpapi.Retry(503, "LONGFORM_ARCHIVE_READER_UNAVAILABLE", "长片归档读取暂不可用。")
			}
			// rawV2 deliberately rejects redirects. Reuse the existing signed
			// asset reader internally instead, preserving Range and live session
			// authorization without a browser-visible URL or network proxy.
			local := r.Clone(r.Context())
			local.URL, _ = url.Parse(location)
			local.RequestURI = location
			return archivedReader(w, local, strings.TrimPrefix(local.URL.Path, "/storage/assets/"))
		}
		a, b, e := s.Artifact(r.Context(), httpapi.IdentityFrom(r).UserID, chi.URLParam(r, "id"), chi.URLParam(r, "artifactId"))
		if e != nil {
			return e
		}
		w.Header().Set("Content-Type", a.MediaType)
		w.Header().Set("Content-Disposition", `inline; filename="longform.mp4"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, "longform.mp4", time.Time{}, bytes.NewReader(b))
		return nil
	})
	return nil
}

var archivedAssetPath = regexp.MustCompile(`^/storage/assets/ast_[A-Za-z0-9_-]{1,200}$`)

// The asset store signs the local asset path, not its deployment origin. Keep
// the exact signature query and local path for internal asset dispatch. An
// internal HTTP PublicBaseURL must never become a browser navigation or permit
// arbitrary paths to reach the storage reader.
func archivedAssetLocation(raw string) (string, error) {
	invalid := func() (string, error) {
		return "", httpapi.Retry(503, "LONGFORM_ARCHIVE_URL_INVALID", "长片归档下载地址暂不可用。")
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil || strings.ContainsAny(raw, "\\\r\n\x00") || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.RawPath != "" || !archivedAssetPath.MatchString(u.Path) {
		return invalid()
	}
	if u.Scheme == "" {
		if u.Host != "" {
			return invalid()
		}
	} else if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return invalid()
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query) != 1 || len(query["token"]) != 1 || query.Get("token") == "" {
		return invalid()
	}
	return u.Path + "?" + u.RawQuery, nil
}

func mapped(e error) error {
	var api *httpapi.Error
	if e == nil || errors.As(e, &api) {
		return e
	}
	var f *gateway.Fault
	if errors.As(e, &f) {
		if f.Code == "LONGFORM_STATE_TOO_LARGE" {
			return httpapi.Fail(413, "LONGFORM_STATE_TOO_LARGE", "长片完整历史超过16MiB读取上限，请拆分项目；原任务仍保留，未重新生成。")
		}

		if f.HTTPStatus >= 400 && f.HTTPStatus < 500 {
			message := "长片参数不支持，请按当前提示调整后重试。"
			switch f.Code {
			case "LONGFORM_REVISION_CONFLICT", "REVISION_CONFLICT":
				message = "长片状态已更新，请重新载入后继续。"
			case "LONGFORM_PREDECESSOR_REQUIRED", "PREDECESSOR_REQUIRED":
				message = "请先生成并采用前一段，再续拍此段。"
			case "LONGFORM_CONTEXT_RESOLUTION_MISMATCH", "CONTEXT_RESOLUTION_MISMATCH":
				message = "续接上下文与当前分辨率不同，请统一尺寸后重新生成。"
			case "LONGFORM_STALE_SEGMENTS", "STALE_SEGMENTS":
				message = "后续片段仍沿用旧衔接，请重做后续或明确保留旧段后再合片。"
			}
			return httpapi.Fail(f.HTTPStatus, f.Code, message)
		}
		switch f.Code {
		case "NOT_FOUND", "PROJECT_NOT_FOUND", "ARTIFACT_NOT_FOUND":
			return httpapi.Fail(404, "LONGFORM_NOT_FOUND", "长片或产物不存在。")
		case "INVALID_REQUEST", "INVALID_ACTION", "VALIDATION_FAILED":
			return httpapi.Fail(422, "LONGFORM_INVALID", "长片参数不支持，请检查当前片段设置。")
		case "REVISION_CONFLICT", "VERSION_CONFLICT", "CONFLICT", "JOB_ACTIVE", "PROJECT_BUSY", "IDEMPOTENCY_CONFLICT":
			return httpapi.Fail(409, "LONGFORM_CONFLICT", "长片正在处理或状态已更新，请重新载入后继续。")
		case "ADAPTER_NOT_CONFIGURED", "LONGFORM_NOT_CONFIGURED":
			return httpapi.Fail(501, "LONGFORM_NOT_CONFIGURED", "分段长片服务尚未配置。")
		}
		return httpapi.Retry(503, "LONGFORM_UNAVAILABLE", "分段长片服务暂不可用，请保留当前任务后重试。")
	}
	return e
}
