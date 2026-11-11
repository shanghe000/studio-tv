// Package observability provides structured request logs and bounded Feishu
// notifications with IPAC-compatible correlation and visible message fields.
// It never captures request/response bodies, queries, headers or panic values.
package observability

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/httpapi"
)

var (
	ErrDisabled    = errors.New("notifications are disabled")
	ErrClosed      = errors.New("observability is closed")
	ErrQueueFull   = errors.New("notification queue is full")
	ErrRateLimited = errors.New("notification is rate limited")
	ErrDelivery    = errors.New("notification delivery failed")
	labelPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$`)
	codePattern    = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
)

type Config struct {
	LogDirectory                         string
	Output                               io.Writer
	Level                                slog.Level
	ServiceName, Environment, ServerName string
	WebhookURL                           string // External secret; never logged or returned in an error.
	HTTPClient                           *http.Client
	QueueCapacity, MaxDedupKeys          int
	RateWindow, SendTimeout              time.Duration
	// Composition-root hooks share the trusted HTTP diagnostic context without
	// coupling httpapi to observability. ErrorCode must return a symbolic code.
	ErrorCode   func(*http.Request) string
	RecordError func(*http.Request, string)
	Clock       func() time.Time
}

type Observer struct {
	files                                       *frameworkFiles
	config                                      Config
	logger                                      *slog.Logger
	client                                      *http.Client
	queue                                       chan notification
	done                                        chan struct{}
	workerContext                               context.Context
	cancel                                      context.CancelFunc
	mu                                          sync.Mutex
	closing                                     bool
	windows                                     map[string]time.Time
	actorName                                   func(context.Context, string) (string, error)
	enqueued, sent, failed, dropped, suppressed atomic.Uint64
}

type Stats struct{ Enqueued, Sent, Failed, Dropped, Suppressed uint64 }

func New(config Config) (*Observer, error) {
	if config.Output == nil {
		config.Output = os.Stdout
	}
	if config.ServiceName == "" {
		config.ServiceName = "studio-tv"
	}
	if config.Environment == "" {
		config.Environment = "deployment-host"
	}
	if config.ServerName == "" {
		config.ServerName = "deployment-host"
	}
	for _, value := range []string{config.ServiceName, config.Environment, config.ServerName} {
		if !labelPattern.MatchString(value) {
			return nil, errors.New("invalid observability label")
		}
	}
	if config.QueueCapacity == 0 {
		config.QueueCapacity = 128
	}
	if config.MaxDedupKeys == 0 {
		config.MaxDedupKeys = 1024
	}
	if config.RateWindow == 0 {
		config.RateWindow = time.Minute
	}
	if config.SendTimeout == 0 {
		config.SendTimeout = 5 * time.Second
	}
	if config.QueueCapacity < 1 || config.QueueCapacity > 4096 || config.MaxDedupKeys < 1 || config.MaxDedupKeys > 8192 || config.RateWindow < time.Millisecond || config.RateWindow > 24*time.Hour || config.SendTimeout < time.Millisecond || config.SendTimeout > 30*time.Second {
		return nil, errors.New("invalid observability bounds")
	}
	if config.Clock == nil {
		config.Clock = time.Now
	}
	client, err := notificationClient(config)
	if err != nil {
		return nil, err
	}
	var files *frameworkFiles
	if config.LogDirectory != "" {
		files, err = newFrameworkFiles(config.LogDirectory)
		if err != nil {
			return nil, err
		}
		config.Output = io.MultiWriter(config.Output, files)
	}
	logger := slog.New(slog.NewJSONHandler(config.Output, &slog.HandlerOptions{Level: config.Level, ReplaceAttr: redactAttribute})).With("service", config.ServiceName, "source", config.Environment, "server", config.ServerName)
	ctx, cancel := context.WithCancel(context.Background())
	o := &Observer{files: files, config: config, logger: logger, client: client, queue: make(chan notification, config.QueueCapacity), done: make(chan struct{}), workerContext: ctx, cancel: cancel, windows: make(map[string]time.Time)}
	if config.WebhookURL == "" {
		close(o.done)
	} else {
		go o.run()
	}
	return o, nil
}

func (o *Observer) Logger() *slog.Logger { return o.logger }
func (o *Observer) Stats() Stats {
	return Stats{o.enqueued.Load(), o.sent.Load(), o.failed.Load(), o.dropped.Load(), o.suppressed.Load()}
}

// Close rejects new notifications and drains existing ones until ctx expires.
// Network delivery is always independent of a normal HTTP request's lifetime.
func (o *Observer) Close(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	o.mu.Lock()
	if !o.closing {
		o.closing = true
		close(o.queue)
	}
	o.mu.Unlock()
	select {
	case <-o.done:
		o.cancel()
		if o.files != nil {
			return o.files.Close()
		}
		return nil
	case <-ctx.Done():
		o.cancel()
		return ctx.Err()
	}
}

type logIDContextKey struct{}

func LogID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(logIDContextKey{}).(string)
	return id
}

func trustedRequestID(r *http.Request) string {
	id := httpapi.RequestID(r)
	if len(id) == 36 {
		if parsed, err := uuid.Parse(id); err == nil && parsed.String() == id && parsed != uuid.Nil {
			return id
		}
	}
	return uuid.NewString()
}

// Middleware belongs in chi.Router.Use, after the trusted RequestContext and
// outside security/CORS and handlers. Read RoutePattern after handler completion
// so nested routes have their final template; never fall back to raw URL.Path.
func (o *Observer) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := trustedRequestID(r)
		r = r.WithContext(context.WithValue(r.Context(), logIDContextKey{}, id))
		w.Header().Set("log_id", id)
		w.Header().Set("X-Log-ID", id)
		w.Header().Set("X-Request-ID", id)
		recorder, writer := recordResponse(w)
		started := time.Now()
		defer func() {
			value := recover()
			panicked := value != nil
			abort := value == http.ErrAbortHandler
			truncated := panicked && recorder.committed && !recorder.hijacked
			if panicked && !abort {
				if o.config.RecordError != nil {
					o.config.RecordError(r, "PANIC_RECOVERED")
				}
				if recorder.hijacked && recorder.connection != nil {
					_ = recorder.connection.Close()
				}
				if !recorder.committed && !recorder.hijacked {
					writer.Header().Set("Content-Type", "application/json; charset=utf-8")
					writer.WriteHeader(http.StatusInternalServerError)
					_ = json.NewEncoder(writer).Encode(&httpapi.Error{Code: "INTERNAL_ERROR", Message: "服务器暂时无法完成请求。", RequestID: id, Details: []httpapi.Detail{}})
				}
			}
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			method, route := safeMethod(r.Method), routeTemplate(r)
			code := ""
			if o.config.ErrorCode != nil {
				code = safeCode(o.config.ErrorCode(r))
			}
			if panicked && !abort {
				code = "PANIC_RECOVERED"
			} else if status >= 400 && code == "" {
				code = fmt.Sprintf("HTTP_%d", status)
			}
			canceled := r.Context().Err() != nil
			elapsed := float64(time.Since(started).Microseconds()) / 1000
			fields := []any{"log_id", id, "request_id", id, "method", method, "route", route, "status", status, "elapsed_ms", elapsed, "bytes", recorder.bytes, "error_code", code, "panic", panicked && !abort, "canceled", canceled, "aborted", abort}
			if status >= 400 {
				fields = append(fields, canvasFailureTags(r, method, route)...)
			}
			level, message := slog.LevelInfo, "http request"
			if status >= 500 {
				level = slog.LevelError
				message = "http request failed"
			}
			if status == http.StatusNotImplemented {
				level = slog.LevelWarn
				message = "http request unavailable"
			}
			if panicked && !abort {
				level = slog.LevelError
				message = "http request panicked"
			}
			o.logger.Log(r.Context(), level, message, fields...)
			if !canceled && !abort && ((status >= 500 && status != http.StatusNotImplemented) || panicked || (status >= 400 && generationRoute(method, route))) {
				title, kind := "Studio TV 接口错误", "HTTP_ERROR"
				if panicked {
					title = "Studio TV 恐慌告警"
					kind = "PANIC"
				} else if status < 500 && generationRoute(method, route) {
					title = "Studio TV 提交未通过"
					kind = "SUBMISSION_REJECTED"
				}
				detail := fmt.Sprintf("log_id=%s method=%s route=%s status=%d error_code=%s elapsed_ms=%.3f bytes=%d", id, method, route, status, code, elapsed, recorder.bytes)
				o.enqueue(notification{title: title, id: id, operation: method + " " + route, detail: detail, key: fmt.Sprintf("%s|%s|%s|%d|%s", kind, method, route, status, code)})
			}
			if abort || truncated {
				// A partial stream cannot be turned into a successful response.
				// Let net/http terminate it without printing the original panic.
				panic(http.ErrAbortHandler)
			}
		}()
		next.ServeHTTP(writer, r)
	})
}

func safeCode(code string) string {
	if len(code) <= 64 && codePattern.MatchString(code) {
		return code
	}
	return ""
}
func safeMethod(method string) string {
	switch method {
	case "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "CONNECT", "TRACE":
		return method
	default:
		return "OTHER"
	}
}

// Allow correlation with a reported project without retaining its URL, ID,
// credential values, or content. These labels describe a request, not a user.
func canvasFailureTags(r *http.Request, method, route string) []any {
	switch method + " " + route {
	case "PUT /api/v1/projects/{projectId}/snapshot", "POST /api/v2/projects/{projectId}/canvas-operations",
		"POST /api/v2/projects/{projectId}/node-leases":
	default:
		return nil
	}
	mode := "no_page_key"
	if r.Header.Get("X-STUDIO-Canvas-Proof") != "" && r.Header.Get("X-STUDIO-Canvas-Lease") != "" {
		mode = "key_and_lease"
	} else if r.Header.Get("X-STUDIO-Canvas-Session") != "" {
		mode = "page_id_only"
	}
	result := []any{"canvas_write_context", mode}
	if httpapi.IsRoomWrite(r) {
		result = append(result, "canvas_transport", "websocket")
	}
	project := chi.URLParam(r, "projectId")
	if len(project) == 40 && strings.HasPrefix(project, "prj_") {
		if _, e := uuid.Parse(project[4:]); e == nil {
			sum := sha256.Sum256([]byte(project))
			result = append(result, "canvas_ref", fmt.Sprintf("%x", sum[:12]))
		}
	}
	return result
}

func routeTemplate(r *http.Request) string {
	if ctx := chi.RouteContext(r.Context()); ctx != nil {
		pattern := ctx.RoutePattern()
		if len(pattern) > 0 && len(pattern) <= 512 && strings.HasPrefix(pattern, "/") && !strings.ContainsAny(pattern, "\r\n\t?#") && !strings.Contains(pattern, "://") {
			return pattern
		}
	}
	return "unmatched"
}

// Logger users must use static messages and safe metadata. Defense in depth
// removes common sensitive attribute names and error objects; middleware does
// not inspect or retain those values in the first place.
func redactAttribute(_ []string, attr slog.Attr) slog.Attr {
	key := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(attr.Key))
	for _, sensitive := range []string{"authorization", "cookie", "header", "body", "query", "token", "password", "secret", "webhook", "prompt", "credential", "url"} {
		if strings.Contains(key, sensitive) {
			return slog.String(attr.Key, "[redacted]")
		}
	}
	if key == "err" || key == "error" {
		return slog.String(attr.Key, "[redacted]")
	}
	if attr.Value.Kind() == slog.KindAny {
		if _, ok := attr.Value.Any().(error); ok {
			return slog.String(attr.Key, "[redacted]")
		}
	}
	return attr
}
