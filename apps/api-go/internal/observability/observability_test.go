package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/httpapi"
)

type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *synchronizedBuffer) Write(body []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(body)
}
func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func testObserver(t *testing.T, config Config) (*Observer, *synchronizedBuffer) {
	t.Helper()
	output := &synchronizedBuffer{}
	config.Output = output
	o, err := New(config)
	if err != nil {
		t.Fatal("observer construction failed", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = o.Close(ctx)
	})
	return o, output
}
func closeObserver(t *testing.T, o *Observer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := o.Close(ctx); err != nil {
		t.Fatal("observer drain failed", err)
	}
}
func requestLogs(t *testing.T, output *synchronizedBuffer) []map[string]any {
	t.Helper()
	var rows []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		if line == "" {
			continue
		}
		var row map[string]any
		if json.Unmarshal([]byte(line), &row) != nil {
			t.Fatal("log is not JSON")
		}
		if strings.HasPrefix(row["msg"].(string), "http request") {
			rows = append(rows, row)
		}
	}
	return rows
}
func fakeWebhook(t *testing.T) (string, *synchronizedBuffer, *atomic.Int64) {
	t.Helper()
	body := &synchronizedBuffer{}
	calls := &atomic.Int64{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
		_, _ = body.Write(raw)
		calls.Add(1)
		_, _ = io.WriteString(w, `{"code":0}`)
	}))
	t.Cleanup(server.Close)
	return server.URL, body, calls
}
func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !predicate() {
		if time.Now().After(deadline) {
			t.Fatal("bounded asynchronous condition not reached")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRequestUsesTrustedUUIDNestedTemplateAndNeverCapturesSecrets(t *testing.T) {
	endpoint, notification, calls := fakeWebhook(t)
	o, output := testObserver(t, Config{WebhookURL: endpoint, ErrorCode: func(*http.Request) string { return "UPSTREAM_UNAVAILABLE" }})
	router := chi.NewRouter()
	router.Use(httpapi.Base(nil))
	router.Use(o.Middleware)
	var handlerID string
	router.Route("/api/v2/projects/{projectID}", func(r chi.Router) {
		r.Get("/assets/{assetID}", func(w http.ResponseWriter, r *http.Request) {
			handlerID = httpapi.RequestID(r)
			w.WriteHeader(503)
			_, _ = io.WriteString(w, "PRIVATE_RESPONSE_PROMPT")
		})
	})
	request := httptest.NewRequest("GET", "/api/v2/projects/PRIVATE_PROJECT/assets/PRIVATE_ASSET?token=PRIVATE_QUERY", strings.NewReader("PRIVATE_BODY"))
	request.Header.Set("Authorization", "Bearer PRIVATE_JWT")
	request.Header.Set("Cookie", "refresh=PRIVATE_COOKIE")
	request.Header.Set("log_id", "PRIVATE_UNTRUSTED_LOG_ID")
	request.Header.Set("X-Log-ID", strings.Repeat("PRIVATE", 10000))
	request.Header.Set("X-Request-ID", "PRIVATE_REQUEST_ID")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	closeObserver(t, o)
	rows := requestLogs(t, output)
	if len(rows) != 1 {
		t.Fatal("missing request log")
	}
	row := rows[0]
	if _, err := uuid.Parse(handlerID); err != nil || row["log_id"] != handlerID || row["request_id"] != handlerID {
		t.Fatal("existing trusted request ID was not reused")
	}
	for _, key := range []string{"log_id", "X-Log-ID", "X-Request-ID"} {
		if response.Header().Get(key) != handlerID {
			t.Fatal("correlation response headers differ")
		}
	}
	if row["route"] != "/api/v2/projects/{projectID}/assets/{assetID}" || row["status"] != float64(503) || row["bytes"] != float64(len("PRIVATE_RESPONSE_PROMPT")) || row["error_code"] != "UPSTREAM_UNAVAILABLE" || row["level"] != "ERROR" {
		t.Fatal("incorrect request metadata", row)
	}
	if calls.Load() != 1 || o.Stats().Sent != 1 {
		t.Fatal("5xx notification was not accepted")
	}
	if strings.Contains(output.String(), "PRIVATE") || strings.Contains(notification.String(), "PRIVATE") {
		t.Fatal("private request/response data leaked")
	}
	var payload struct {
		MsgType string      `json:"msg_type"`
		Content postContent `json:"content"`
	}
	if json.Unmarshal([]byte(notification.String()), &payload) != nil || payload.MsgType != "post" || payload.Content.Post["zh_cn"].Title != "Studio TV 接口错误" {
		t.Fatal("Feishu rich text envelope is not an object")
	}
}

func TestIDsNeverTrustHeadersAndUnmatchedPathsAreNotLogged(t *testing.T) {
	o, output := testObserver(t, Config{})
	router := chi.NewRouter()
	router.Use(o.Middleware)
	router.Get("/ok", func(w http.ResponseWriter, r *http.Request) {
		if LogID(r.Context()) == "" {
			t.Fatal("missing request log context")
		}
		w.WriteHeader(204)
	})
	for _, path := range []string{"/ok", "/PRIVATE_URL_TOKEN?prompt=PRIVATE_QUERY"} {
		request := httptest.NewRequest("GET", path, nil)
		request.Header.Set("log_id", uuid.NewString())
		request.Header.Set("X-Request-ID", "\"\nPRIVATE")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if id, err := uuid.Parse(response.Header().Get("log_id")); err != nil || id == uuid.Nil || response.Header().Get("log_id") == request.Header.Get("log_id") {
			t.Fatal("untrusted ID was accepted")
		}
	}
	rows := requestLogs(t, output)
	if len(rows) != 2 || rows[0]["route"] != "/ok" || rows[1]["route"] != "unmatched" {
		t.Fatal("raw URL became a route label")
	}
	if strings.Contains(output.String(), "PRIVATE") {
		t.Fatal("unknown request path or header leaked")
	}
}

func TestExpected501FourXXAndCanceledRequestsDoNotNotify(t *testing.T) {
	endpoint, _, calls := fakeWebhook(t)
	o, output := testObserver(t, Config{WebhookURL: endpoint})
	router := chi.NewRouter()
	router.Use(o.Middleware)
	for _, status := range []int{400, 401, 403, 404, 409, 429, 501} {
		status := status
		router.Get(fmt.Sprintf("/status/%d", status), func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) })
	}
	router.Get("/cancel", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) })
	for _, status := range []int{400, 401, 403, 404, 409, 429, 501} {
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", fmt.Sprintf("/status/%d", status), nil))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest("GET", "/cancel", nil).WithContext(ctx)
	router.ServeHTTP(httptest.NewRecorder(), request)
	closeObserver(t, o)
	if calls.Load() != 0 || o.Stats().Enqueued != 0 {
		t.Fatal("expected failure/cancellation notified")
	}
	rows := requestLogs(t, output)
	if rows[6]["level"] != "WARN" || rows[7]["canceled"] != true || rows[7]["status"] != float64(503) {
		t.Fatal("expected failure was not logged accurately")
	}
}

func TestPanicRecoveryIsSafeBeforeAndAfterResponseCommit(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint(committed), func(t *testing.T) {
			endpoint, notification, calls := fakeWebhook(t)
			var recorded string
			o, output := testObserver(t, Config{WebhookURL: endpoint, RecordError: func(_ *http.Request, code string) { recorded = code }})
			router := chi.NewRouter()
			router.Use(o.Middleware)
			router.Get("/panic", func(w http.ResponseWriter, r *http.Request) {
				if committed {
					_, _ = io.WriteString(w, "prefix")
				}
				panic(map[string]string{"token": "PRIVATE_PANIC_TOKEN", "prompt": "PRIVATE_MODEL_PROMPT"})
			})
			response := httptest.NewRecorder()
			func() {
				defer func() {
					value := recover()
					if committed && value != http.ErrAbortHandler {
						t.Fatal("partial response was not aborted")
					}
					if !committed && value != nil {
						t.Fatal("uncommitted response was aborted")
					}
				}()
				router.ServeHTTP(response, httptest.NewRequest("GET", "/panic", nil))
			}()
			closeObserver(t, o)
			if recorded != "PANIC_RECOVERED" || calls.Load() != 1 {
				t.Fatal("panic diagnostic or notification missing")
			}
			if committed {
				if response.Code != 200 || response.Body.String() != "prefix" {
					t.Fatal("panic corrupted an already committed stream")
				}
			} else {
				if response.Code != 500 {
					t.Fatal("panic was not recovered as500")
				}
				var reply httpapi.Error
				if json.Unmarshal(response.Body.Bytes(), &reply) != nil || reply.Code != "INTERNAL_ERROR" || reply.RequestID != response.Header().Get("log_id") {
					t.Fatal("unsafe/uncorrelated panic response")
				}
			}
			if strings.Contains(output.String(), "PRIVATE") || strings.Contains(notification.String(), "PRIVATE") || strings.Contains(response.Body.String(), "PRIVATE") {
				t.Fatal("panic value leaked")
			}
			rows := requestLogs(t, output)
			if len(rows) != 1 || rows[0]["panic"] != true || rows[0]["error_code"] != "PANIC_RECOVERED" {
				t.Fatal("panic request was not logged")
			}
		})
	}
}

func TestAbortHandlerIsPreservedWithoutNotification(t *testing.T) {
	endpoint, _, calls := fakeWebhook(t)
	o, output := testObserver(t, Config{WebhookURL: endpoint})
	handler := o.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }))
	func() {
		defer func() {
			if value := recover(); value != http.ErrAbortHandler {
				t.Fatal("net/http abort semantics changed")
			}
		}()
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/abort", nil))
	}()
	closeObserver(t, o)
	rows := requestLogs(t, output)
	if calls.Load() != 0 || len(rows) != 1 || rows[0]["aborted"] != true {
		t.Fatal("abort notification/log classification incorrect")
	}
}

func TestErrorCodeValidationAndLoggerAttributeRedaction(t *testing.T) {
	o, output := testObserver(t, Config{ErrorCode: func(*http.Request) string { return "PRIVATE_TOKEN=https://credentials.invalid/secret" }})
	router := chi.NewRouter()
	router.Use(o.Middleware)
	router.Get("/failure", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) })
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/failure", nil))
	o.Logger().Info("safe metadata", "Authorization", "PRIVATE_AUTH", "model_prompt", "PRIVATE_PROMPT", "cookie", "PRIVATE_COOKIE", "webhook_url", "PRIVATE_HOOK", "error", errors.New("PRIVATE_ERROR"), "diagnostic", errors.New("PRIVATE_TYPED_ERROR"))
	rows := requestLogs(t, output)
	if rows[0]["error_code"] != "HTTP_500" {
		t.Fatal("untrusted error code was logged")
	}
	if strings.Contains(output.String(), "PRIVATE") {
		t.Fatal("sensitive logger attributes leaked")
	}
}

func TestFailedCanvasWriteCanBeCorrelatedWithoutItsProjectOrCredentials(t *testing.T) {
	o, output := testObserver(t, Config{})
	r := chi.NewRouter()
	r.Use(o.Middleware)
	r.Put("/api/v1/projects/{projectId}/snapshot", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(409) })
	project := "prj_01010101-0101-4101-8101-010101010101"
	for _, kind := range []string{"legacy", "current"} {
		req := httptest.NewRequest("PUT", "/api/v1/projects/"+project+"/snapshot", nil)
		req.Header.Set("X-STUDIO-Canvas-Session", "private-page-id")
		if kind == "current" {
			req.Header.Set("X-STUDIO-Canvas-Proof", "private-proof")
			req.Header.Set("X-STUDIO-Canvas-Lease", "private-lease")
		}
		r.ServeHTTP(httptest.NewRecorder(), req)
	}
	rows := requestLogs(t, output)
	if len(rows) != 2 || rows[0]["canvas_write_context"] != "page_id_only" || rows[1]["canvas_write_context"] != "key_and_lease" || rows[0]["canvas_ref"] == nil || rows[0]["canvas_ref"] != rows[1]["canvas_ref"] || strings.Contains(output.String(), project) || strings.Contains(output.String(), "private-") {
		t.Fatal("unsafe or missing canvas correlation")
	}
}
