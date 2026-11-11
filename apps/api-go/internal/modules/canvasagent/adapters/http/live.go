package http

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"studiotv.local/service/api/internal/canvaswake"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

// RegisterLiveRoutes exposes bounded JSON replay and opt-in authenticated SSE.
// Streaming requires the composition root's live revalidation proof as well.
func RegisterLiveRoutes(router chi.Router, service *application.LiveService, protect Protect, hubs ...*canvaswake.Hub) error {
	stream := newProjectStream(service)
	if len(hubs) > 0 {
		stream.wake = hubs[0]
	}
	return registerLiveRoutes(router, stream, protect, false)
}
func registerLiveRoutes(router chi.Router, stream *projectStream, protect Protect, roomEnabled bool) error {
	if router == nil || stream.service == nil || protect == nil {
		return errors.New("project live route dependencies required")
	}
	service := stream.service
	router.MethodFunc("GET", "/api/v2/projects/{projectId}/live-snapshot", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		identity := httpapi.IdentityFrom(r)
		if identity.UserID == "" {
			return httpapi.Fail(401, "UNAUTHENTICATED", "请先使用飞书登录。")
		}
		if r.URL.RawQuery != "" {
			return httpapi.Fail(400, "VALIDATION_FAILED", "实时快照不接受查询参数。")
		}
		value, err := service.Snapshot(r.Context(), identity.UserID, chi.URLParam(r, "projectId"))
		if err != nil {
			return liveHTTPError(err)
		}
		if roomEnabled {
			w.Header().Set("X-STUDIO-Canvas-Room", "ws-v1")
		}
		w.Header().Set("X-STUDIO-Canvas-Update", "delta-v1")
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", value.GraphRevision))
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, value)
	}))
	router.MethodFunc("GET", "/api/v2/projects/{projectId}/live-update", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		id := httpapi.IdentityFrom(r)
		if id.UserID == "" {
			return httpapi.Fail(401, "UNAUTHENTICATED", "请先登录。")
		}
		q, e := url.ParseQuery(r.URL.RawQuery)
		if e != nil || len(q) != 1 || len(q["fromRevision"]) != 1 {
			return httpapi.Fail(400, "VALIDATION_FAILED", "请提供一个有效的画布修订。")
		}
		from, e := domain.ParseEventCursor(q.Get("fromRevision"))
		if e != nil || from < 1 || from > 9007199254740991 {
			return httpapi.Fail(400, "VALIDATION_FAILED", "画布修订无效。")
		}
		value, e := service.Update(r.Context(), id.UserID, chi.URLParam(r, "projectId"), from)
		if e != nil {
			return liveHTTPError(e)
		}
		if roomEnabled {
			w.Header().Set("X-STUDIO-Canvas-Room", "ws-v1")
		}
		w.Header().Set("X-STUDIO-Canvas-Update", "delta-v1")
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", value.GraphRevision))
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, value)
	}))
	router.MethodFunc("GET", "/api/v2/projects/{projectId}/events", protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		identity := httpapi.IdentityFrom(r)
		if identity.UserID == "" {
			return httpapi.Fail(401, "UNAUTHENTICATED", "请先使用飞书登录。")
		}
		after, limit, err := eventQuery(r)
		if err != nil {
			return err
		}
		if onlyEventStreamAccepted(r.Header.Values("Accept")) {
			return stream.serve(w, r, identity, chi.URLParam(r, "projectId"), after, limit)
		}
		value, err := service.Events(r.Context(), identity.UserID, chi.URLParam(r, "projectId"), after, limit)
		if err != nil {
			return liveHTTPError(err)
		}
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, value)
	}))
	return nil
}

func eventQuery(r *http.Request) (int64, int, error) {
	query, err := parseLiveQuery(r)
	if err != nil {
		return 0, 0, err
	}
	after := query["after"]
	if after == "" {
		after = "0"
	}
	// Last-Event-ID shares exactly the same authority for JSON and SSE recovery.
	// Conflicting or repeated authorities are rejected rather than guessed.
	values := r.Header.Values("Last-Event-ID")
	if len(values) > 1 || (len(values) == 1 && query["after"] != "" && values[0] != query["after"]) {
		return 0, 0, httpapi.Fail(400, "VALIDATION_FAILED", "事件游标重复或冲突。")
	}
	if len(values) == 1 {
		after = values[0]
	}
	sequence, err := domain.ParseEventCursor(after)
	if err != nil {
		return 0, 0, httpapi.Fail(400, "VALIDATION_FAILED", "after必须为非负十进制事件游标。")
	}
	limit := domain.MaxEventPageSize
	if raw, exists := query["limit"]; exists {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > domain.MaxEventPageSize || strconv.Itoa(parsed) != raw {
			return 0, 0, httpapi.Fail(400, "VALIDATION_FAILED", "limit必须为1到100的整数。")
		}
		limit = parsed
	}
	return sequence, limit, nil
}

func parseLiveQuery(r *http.Request) (map[string]string, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, httpapi.Fail(400, "VALIDATION_FAILED", "查询参数无效。")
	}
	query := map[string]string{}
	for key, entries := range values {
		if (key != "after" && key != "limit") || len(entries) != 1 || entries[0] == "" {
			return nil, httpapi.Fail(400, "VALIDATION_FAILED", "查询包含未知、空或重复字段。")
		}
		query[key] = entries[0]
	}
	return query, nil
}

func onlyEventStreamAccepted(values []string) bool {
	stream := false
	for _, header := range values {
		for _, part := range strings.Split(header, ",") {
			kind, params, err := mime.ParseMediaType(strings.TrimSpace(part))
			if err != nil {
				continue
			}
			if raw, ok := params["q"]; ok {
				quality, err := strconv.ParseFloat(raw, 64)
				if err != nil || quality <= 0 || quality > 1 {
					continue
				}
			}
			if kind == "application/json" || kind == "application/*" || kind == "*/*" {
				return false
			}
			stream = stream || kind == "text/event-stream"
		}
	}
	return stream
}

func liveHTTPError(err error) error {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return httpapi.Fail(404, "PROJECT_NOT_FOUND", "作品不存在或无权访问。")
	case errors.Is(err, domain.ErrInvalid):
		return httpapi.Fail(400, "VALIDATION_FAILED", "项目或事件查询无效。")
	case errors.Is(err, domain.ErrEventCursorAhead):
		return httpapi.Fail(409, "EVENT_CURSOR_AHEAD", "事件游标超出当前项目，请重新读取快照。")
	case errors.Is(err, domain.ErrLiveUnavailable):
		return httpapi.Retry(503, "PROJECT_EVENTS_UNAVAILABLE", "画布快照或事件暂时无法读取。")
	default:
		return err
	}
}
