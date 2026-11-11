package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/observability"
	"studiotv.local/service/api/internal/telemetry"
)

type observationOutput struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (o *observationOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.b.Write(p)
}

func (o *observationOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.b.String()
}

func observedTestApplication(t *testing.T, register RuntimeRegistrar) (*Application, *observationOutput) {
	t.Helper()
	output := &observationOutput{}
	logger, err := observability.New(observability.Config{Output: output, ErrorCode: httpapi.ErrorCode, RecordError: httpapi.RecordError})
	if err != nil {
		t.Fatal(err)
	}
	cfg, closed := testConfig(t), 0
	cfg.MetricsEnabled, cfg.MetricsAddress = true, "127.0.0.1:9090"
	deps := testDependencies(&identityStub{}, &closed)
	deps.observers = Observability{Logger: logger, Metrics: telemetry.New()}
	var registrars []RuntimeRegistrar
	if register != nil {
		registrars = []RuntimeRegistrar{register}
	}
	app, err := initializeRuntime(context.Background(), cfg, deps, registrars)
	if err != nil {
		closeObserver(logger)
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app, output
}

func privateMetrics(t *testing.T, app *Application) string {
	t.Helper()
	if app.MetricsHandler() == nil {
		t.Fatal("private metrics handler missing")
	}
	w := httptest.NewRecorder()
	app.MetricsHandler().ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	if w.Code != 200 {
		t.Fatalf("private metrics status=%d", w.Code)
	}
	return w.Body.String()
}

func requireMetric(t *testing.T, body, expected string) {
	t.Helper()
	if !strings.Contains(body, "\n"+expected+"\n") {
		t.Fatalf("missing metric %s", expected)
	}
}

type observationRoundTripper func(*http.Request) (*http.Response, error)

func (f observationRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestObservabilitySharedRegistryAndPrivateEndpoint(t *testing.T) {
	app, _ := observedTestApplication(t, nil)
	prepared, err := prepareObservers(testConfig(t), app.observers)
	if err != nil || prepared.Metrics != app.observers.Metrics || prepared.Logger != app.observers.Logger {
		t.Fatal("application replaced prepared instrumentation")
	}
	for _, dependency := range []string{"ipac", "models_router"} {
		transport := upstreamTransport(prepared.Metrics, dependency, observationRoundTripper(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}")), Request: r}, nil
		}))
		response, err := transport.RoundTrip(httptest.NewRequest("GET", "http://fixture.invalid/private-subject?token=private-query", nil))
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
	}
	public := httptest.NewRecorder()
	app.Handler().ServeHTTP(public, httptest.NewRequest("GET", "/metrics", nil))
	if public.Code != 404 || strings.Contains(public.Body.String(), "studiotv_http_") {
		t.Fatal("business listener exposed metrics")
	}
	for _, path := range []string{"/healthz", "/api/v1/auth/config"} {
		w := httptest.NewRecorder()
		app.MetricsHandler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		want := 200
		if path != "/healthz" {
			want = 404
		}
		if w.Code != want {
			t.Fatalf("private listener %s status=%d", path, w.Code)
		}
	}
	first := privateMetrics(t, app)
	second := privateMetrics(t, app)
	for _, body := range []string{first, second} {
		requireMetric(t, body, `studiotv_http_requests_total{method="GET",route="unmatched",status_class="4xx"} 1`)
		requireMetric(t, body, `studiotv_upstream_http_requests_total{dependency="ipac",outcome="response",status_class="2xx"} 1`)
		requireMetric(t, body, `studiotv_upstream_http_requests_total{dependency="models_router",outcome="response",status_class="2xx"} 1`)
		requireMetric(t, body, "studiotv_http_requests_in_flight 0")
		if strings.Contains(body, "private-subject") || strings.Contains(body, "private-query") {
			t.Fatal("upstream identity or query leaked into shared registry")
		}
	}
	// A second application's registry must not inherit the first one's requests.
	other, _ := observedTestApplication(t, nil)
	if body := privateMetrics(t, other); strings.Contains(body, "studiotv_http_requests_total{") || strings.Contains(body, "studiotv_upstream_http_requests_total{") {
		t.Fatal("application registry was shared globally")
	}
}

func TestObservabilityIPACCorrelationClonesRequest(t *testing.T) {
	metrics := telemetry.New()
	handler := httpapi.RequestContext(http.HandlerFunc(func(w http.ResponseWriter, inbound *http.Request) {
		request := httptest.NewRequest("POST", "http://fixture.invalid/oidc/session-status", strings.NewReader("private-body")).WithContext(inbound.Context())
		request.Header.Set("log_id", "untrusted-outbound-id")
		request.Header.Set("Authorization", "Basic fixture-only")
		before := request.Header.Clone()
		transport := upstreamTransport(metrics, "ipac", observationRoundTripper(func(got *http.Request) (*http.Response, error) {
			if got == request || got.Header.Get("log_id") != httpapi.RequestID(inbound) || got.Header.Get("log_id") == "untrusted-inbound-id" {
				t.Error("trusted correlation was not added to a request clone")
			}
			if got.Context() != request.Context() || got.Body != request.Body || got.URL.String() != request.URL.String() || got.Header.Get("Authorization") != before.Get("Authorization") {
				t.Error("correlation changed upstream request semantics")
			}
			got.Header.Set("X-Transport-Fixture", "changed")
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}, nil
		}))
		response, err := transport.RoundTrip(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if !reflect.DeepEqual(request.Header, before) {
			t.Fatal("transport mutated the caller's original headers")
		}
		w.WriteHeader(204)
	}))
	inbound := httptest.NewRequest("GET", "/fixture", nil)
	inbound.Header.Set("X-Request-ID", "untrusted-inbound-id")
	handler.ServeHTTP(httptest.NewRecorder(), inbound)
}

func TestObservabilityNestedRecoveryKeepsErrorSemantics(t *testing.T) {
	app, output := observedTestApplication(t, func(public, _ chi.Router, _ *pgxpool.Pool, _ *core.Resources) error {
		public.Get("/api/v2/observation/panic", func(http.ResponseWriter, *http.Request) { panic("private-panic-value") })
		public.Get("/api/v2/observation/reserved", httpapi.Wrap(func(http.ResponseWriter, *http.Request) error {
			return httpapi.Fail(501, "RESERVED_FIXTURE", "reserved fixture")
		}))
		return nil
	})
	for _, test := range []struct {
		path, code, class, loggedCode string
		status                        int
	}{
		{"/api/v2/observation/panic", "INTERNAL_ERROR", "5xx", "PANIC_RECOVERED", 500},
		{"/api/v2/observation/reserved", "RESERVED_FIXTURE", "5xx", "RESERVED_FIXTURE", 501},
		{"/api/v1/projects", "UNAUTHENTICATED", "4xx", "UNAUTHENTICATED", 401},
	} {
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, httptest.NewRequest("GET", test.path+"?token=private-query", nil))
		var body httpapi.Error
		if json.Unmarshal(w.Body.Bytes(), &body) != nil || w.Code != test.status || body.Code != test.code || body.RequestID == "" || body.RequestID != w.Header().Get("log_id") || body.Details == nil || body.Retryable {
			t.Fatalf("%s response semantics changed: %d %s", test.path, w.Code, w.Body.String())
		}
		requireMetric(t, privateMetrics(t, app), `studiotv_http_requests_total{method="GET",route="`+test.path+`",status_class="`+test.class+`"} 1`)
		if !strings.Contains(output.String(), `"error_code":"`+test.loggedCode+`"`) {
			t.Fatalf("missing diagnostic code %s", test.loggedCode)
		}
	}
	for _, secret := range []string{"private-panic-value", "private-query"} {
		if strings.Contains(output.String(), secret) || strings.Contains(privateMetrics(t, app), secret) {
			t.Fatal("request diagnostic leaked private data")
		}
	}
	requireMetric(t, privateMetrics(t, app), "studiotv_http_requests_in_flight 0")
}

func TestObservabilitySSEStatusFlushAndLifetime(t *testing.T) {
	const payload = "event: update\ndata: private-event-body\n\n"
	release := make(chan struct{})
	var releaseOnce sync.Once
	finish := func() { releaseOnce.Do(func() { close(release) }) }
	defer finish()
	app, output := observedTestApplication(t, func(public, _ chi.Router, _ *pgxpool.Pool, _ *core.Resources) error {
		public.Get("/api/v2/observation/projects/{project}/events", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("X-Fixture", "preserved")
			if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Error("response controller could not reach the native writer", err)
			}
			if _, err := io.WriteString(w, payload); err != nil {
				t.Error("SSE write failed", err)
				return
			}
			flusher, ok := w.(http.Flusher)
			if !ok {
				t.Error("instrumentation removed Flusher")
				return
			}
			flusher.Flush()
			select {
			case <-release:
			case <-r.Context().Done():
			}
		})
		return nil
	})
	server := httptest.NewServer(app.Handler())
	defer func() {
		finish()
		server.Close()
	}()
	client := server.Client()
	client.Timeout = 5 * time.Second
	response, err := client.Get(server.URL + "/api/v2/observation/projects/private-project-id/events?token=private-query")
	if err != nil {
		t.Fatal("SSE did not flush before handler completion", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("X-Fixture") != "preserved" {
		t.Fatal("SSE response headers/status changed")
	}
	during := privateMetrics(t, app)
	requireMetric(t, during, "studiotv_http_requests_in_flight 1")
	if strings.Contains(during, `route="/api/v2/observation/projects/{project}/events",status_class="2xx"} 1`) {
		t.Fatal("stream was counted completed before handler finished")
	}
	finish()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != payload {
		t.Fatal("instrumentation changed SSE bytes", err)
	}
	after := privateMetrics(t, app)
	requireMetric(t, after, "studiotv_http_requests_in_flight 0")
	requireMetric(t, after, `studiotv_http_requests_total{method="GET",route="/api/v2/observation/projects/{project}/events",status_class="2xx"} 1`)
	requireMetric(t, after, `studiotv_http_response_bytes_total{method="GET",route="/api/v2/observation/projects/{project}/events",status_class="2xx"} 40`)
	for _, secret := range []string{"private-project-id", "private-query", "private-event-body"} {
		if strings.Contains(after, secret) || strings.Contains(output.String(), secret) {
			t.Fatal("SSE private data entered diagnostics")
		}
	}
	if !strings.Contains(output.String(), `"status":200`) || !strings.Contains(output.String(), `"route":"/api/v2/observation/projects/{project}/events"`) {
		t.Fatal("SSE actual status or route template was not logged")
	}
}

type observationOrder struct {
	mu     sync.Mutex
	events []string
}

func (o *observationOrder) add(value string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.events = append(o.events, value)
}

func (o *observationOrder) snapshot() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.events...)
}

type observationListener struct {
	name                string
	order               *observationOrder
	started, stopped    chan struct{}
	stopOnce, closeOnce sync.Once
	listenError         error
}

func (s *observationListener) ListenAndServe() error {
	close(s.started)
	if s.listenError != nil {
		return s.listenError
	}
	<-s.stopped
	return http.ErrServerClosed
}

func (s *observationListener) Shutdown(context.Context) error {
	s.order.add(s.name + ":shutdown")
	s.stopOnce.Do(func() { close(s.stopped) })
	return nil
}

func (s *observationListener) Close() error {
	s.closeOnce.Do(func() {
		s.order.add(s.name + ":close")
		s.stopOnce.Do(func() { close(s.stopped) })
	})
	return nil
}

func TestObservabilityClosesBothListenersBeforeResources(t *testing.T) {
	for _, mode := range []string{"direct", "api failure", "metrics failure"} {
		t.Run(mode, func(t *testing.T) {
			order := &observationOrder{}
			api := &observationListener{name: "api", order: order, started: make(chan struct{}), stopped: make(chan struct{})}
			metrics := &observationListener{name: "metrics", order: order, started: make(chan struct{}), stopped: make(chan struct{})}
			checkStopped := func() {
				for _, listener := range []*observationListener{api, metrics} {
					select {
					case <-listener.stopped:
					default:
						t.Error("resource cleanup ran before listener stopped", listener.name)
					}
				}
			}
			app := &Application{server: api, metricsServer: metrics, closeDatabase: func() { checkStopped(); order.add("database") }}
			if err := app.BeforeClose(func() { checkStopped(); order.add("hook") }); err != nil {
				t.Fatal(err)
			}
			if mode == "direct" {
				app.Close()
			} else {
				want := "HTTP listener"
				api.listenError = errors.New("private-listener-failure")
				if mode == "metrics failure" {
					api.listenError = nil
					metrics.listenError = errors.New("private-listener-failure")
					want = "metrics HTTP listener"
				}
				done := make(chan error, 1)
				go func() { done <- app.Serve(context.Background()) }()
				select {
				case err := <-done:
					if err == nil || err.Error() != want {
						t.Fatalf("listener failure was not redacted: %v", err)
					}
				case <-time.After(time.Second):
					t.Fatal("listener failure did not close application")
				}
				for _, listener := range []*observationListener{api, metrics} {
					select {
					case <-listener.started:
					case <-time.After(time.Second):
						t.Fatal("listener goroutine was not started", listener.name)
					}
				}
			}
			before := order.snapshot()
			app.Close()
			if got := order.snapshot(); !reflect.DeepEqual(got, before) || len(got) < 4 || !reflect.DeepEqual(got[len(got)-2:], []string{"hook", "database"}) {
				t.Fatalf("cleanup order or idempotence incorrect: %v", got)
			}
			if mode == "direct" && !reflect.DeepEqual(before, []string{"api:close", "metrics:close", "hook", "database"}) {
				t.Fatalf("direct Close order=%v", before)
			}
			if err := app.BeforeClose(func() {}); err == nil {
				t.Fatal("closed application accepted a new resource hook")
			}
		})
	}
}
