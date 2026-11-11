package telemetry

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
)

func scrape(t *testing.T, s *Server) string {
	t.Helper()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("scrape status: %d", w.Code)
	}
	return w.Body.String()
}

func TestHTTPTemplatesBoundLabelsAndDoNotLeakPrivateFields(t *testing.T) {
	s := New()
	r := chi.NewRouter()
	r.Use(s.Middleware)
	r.Route("/api/v2", func(r chi.Router) {
		r.Get("/projects/{project}/tasks/{task}", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Private", "response-header-secret")
			w.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(w, "private-response-text")
		})
	})
	for i := range 100 {
		request := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v2/projects/private-project-%d/tasks/private-task-%d?token=private-query", i, i), nil)
		request.Header.Set("Authorization", "Bearer private-bearer")
		request.Header.Set("Cookie", "session=private-cookie")
		request.Header.Set("X-Actor-Id", "private-actor")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, request)
		if w.Code != 202 || w.Body.String() != "private-response-text" || w.Header().Get("X-Private") != "response-header-secret" {
			t.Fatal("instrumentation changed business response")
		}
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v2/unknown/private-%d", i), nil))
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(fmt.Sprintf("CUSTOM%d", i), "/other", nil))
	}
	body := scrape(t, s)
	for _, secret := range []string{"private-project", "private-task", "private-query", "private-bearer", "private-cookie", "private-actor", "private-response", "response-header-secret", "CUSTOM99"} {
		if strings.Contains(body, secret) {
			t.Fatalf("private input leaked in metrics: %s", secret)
		}
	}
	for _, expected := range []string{
		`studiotv_http_requests_total{method="GET",route="/api/v2/projects/{project}/tasks/{task}",status_class="2xx"} 100`,
		`studiotv_http_requests_total{method="GET",route="unmatched",status_class="4xx"} 100`,
		`studiotv_http_requests_total{method="OTHER",route="unmatched",status_class="4xx"} 100`,
		`studiotv_http_requests_in_flight 0`,
		`studiotv_http_request_duration_seconds_count{method="GET",route="/api/v2/projects/{project}/tasks/{task}",status_class="2xx"} 100`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing metric %s", expected)
		}
	}
	families, err := s.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() == "studiotv_http_requests_total" && len(family.Metric) != 3 {
			t.Fatalf("unbounded series: %d", len(family.Metric))
		}
	}
}

func TestPanicIsNotRecoveredAndInflightAlwaysReleased(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint(committed), func(t *testing.T) {
			s := New()
			w := httptest.NewRecorder()
			panicValue := &struct{ Secret string }{"private-panic-text"}
			h := s.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if committed {
					w.WriteHeader(202)
					_, _ = io.WriteString(w, "partial")
				}
				panic(panicValue)
			}))
			func() {
				defer func() {
					if recover() != panicValue {
						t.Fatal("middleware swallowed or changed panic")
					}
				}()
				h.ServeHTTP(w, httptest.NewRequest("GET", "/private-path", nil))
			}()
			body := scrape(t, s)
			class := "5xx"
			if committed {
				class = "2xx"
			}
			if !strings.Contains(body, `route="unmatched",status_class="`+class+`"} 1`) || !strings.Contains(body, "studiotv_http_requests_in_flight 0") {
				t.Fatal("panic metrics incorrect")
			}
			if strings.Contains(body, "private-panic") || strings.Contains(body, "private-path") {
				t.Fatal("panic leaked")
			}
			if !committed && w.Body.Len() != 0 {
				t.Fatal("middleware wrote a fabricated error")
			}
		})
	}
}

func TestInnerRecoveryStatusAndResponseRemainUntouched(t *testing.T) {
	s := New()
	r := chi.NewRouter()
	r.Use(s.Middleware)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recover() != nil {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(500)
					_, _ = io.WriteString(w, `{"error":"safe"}`)
				}
			}()
			next.ServeHTTP(w, r)
		})
	})
	r.Get("/panic", func(http.ResponseWriter, *http.Request) { panic("secret") })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/panic", nil))
	if w.Code != 500 || w.Body.String() != `{"error":"safe"}` || w.Header().Get("Content-Type") != "application/json" {
		t.Fatal("recovery response changed")
	}
	if !strings.Contains(scrape(t, s), `studiotv_http_requests_total{method="GET",route="/panic",status_class="5xx"} 1`) {
		t.Fatal("recovered 500 not counted")
	}
}

func TestInformationalAndDuplicateHeadersCountOnlyFinalCommittedStatus(t *testing.T) {
	s := New()
	r := chi.NewRouter()
	r.Use(s.Middleware)
	r.Get("/information", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusEarlyHints)
		w.WriteHeader(http.StatusServiceUnavailable)
		w.WriteHeader(http.StatusNoContent)
		_, _ = io.WriteString(w, "actual-error-response")
	})
	server := httptest.NewServer(r)
	defer server.Close()
	response, err := http.Get(server.URL + "/information")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 503 || string(body) != "actual-error-response" {
		t.Fatal("final response changed")
	}
	if !strings.Contains(scrape(t, s), `studiotv_http_requests_total{method="GET",route="/information",status_class="5xx"} 1`) {
		t.Fatal("informational/duplicate headers changed metrics status")
	}
}

func TestSSEFlushDeadlineInflightAndBodyArePreserved(t *testing.T) {
	s := New()
	r := chi.NewRouter()
	r.Use(s.Middleware)
	release := make(chan struct{})
	ready := make(chan struct{})
	r.Get("/projects/{project}/events", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Error("lost Flusher")
			return
		}
		if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Second * 5)); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: private-stream-body\n\n")
		w.(http.Flusher).Flush()
		close(ready)
		<-release
	})
	server := httptest.NewServer(r)
	defer server.Close()
	response, err := http.Get(server.URL + "/projects/private-project/events?token=private-query")
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	defer response.Body.Close()
	<-ready
	if !strings.Contains(scrape(t, s), "studiotv_http_requests_in_flight 1") {
		close(release)
		t.Fatal("stream not counted inflight")
	}
	close(release)
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "data: private-stream-body\n\n" || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal("SSE body or content type changed")
	}
	metrics := scrape(t, s)
	if !strings.Contains(metrics, "studiotv_http_requests_in_flight 0") || strings.Contains(metrics, "private-stream-body") || strings.Contains(metrics, "private-project") {
		t.Fatal("stream metrics unsafe")
	}
}

type fancyWriter struct {
	*httptest.ResponseRecorder
	readFrom, pushed, deadline bool
	peer                       net.Conn
}

func (w *fancyWriter) ReadFrom(r io.Reader) (int64, error) {
	w.readFrom = true
	return io.Copy(w.ResponseRecorder, r)
}
func (w *fancyWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	a, b := net.Pipe()
	w.peer = b
	return a, bufio.NewReadWriter(bufio.NewReader(a), bufio.NewWriter(a)), nil
}
func (w *fancyWriter) Push(string, *http.PushOptions) error { w.pushed = true; return nil }
func (w *fancyWriter) SetWriteDeadline(time.Time) error     { w.deadline = true; return nil }

type minimalWriter struct{ header http.Header }

func (w *minimalWriter) Header() http.Header       { return w.header }
func (*minimalWriter) WriteHeader(int)             {}
func (*minimalWriter) Write(p []byte) (int, error) { return len(p), nil }

func TestOptionalWriterInterfacesAndReaderFromBytesPreserved(t *testing.T) {
	s := New()
	original := &fancyWriter{ResponseRecorder: httptest.NewRecorder()}
	h := s.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(201)
		_, _ = w.Write([]byte("ab"))
		n, err := w.(io.ReaderFrom).ReadFrom(strings.NewReader("cdef"))
		if n != 4 || err != nil {
			t.Fatal("ReaderFrom failed")
		}
		w.(http.Flusher).Flush()
		if err := w.(http.Pusher).Push("/fixed", nil); err != nil {
			t.Fatal(err)
		}
		if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
			t.Fatal(err)
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
		original.peer.Close()
	}))
	h.ServeHTTP(original, httptest.NewRequest("GET", "/asset", nil))
	if !original.readFrom || !original.pushed || !original.deadline || original.Body.String() != "abcdef" {
		t.Fatal("optional interface not forwarded")
	}
	if !strings.Contains(scrape(t, s), `studiotv_http_response_bytes_total{method="GET",route="unmatched",status_class="2xx"} 6`) {
		t.Fatal("ReaderFrom body bytes incorrect")
	}
	h = s.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, ok := w.(http.Flusher); ok {
			t.Fatal("fabricated Flusher")
		}
		if _, ok := w.(http.Hijacker); ok {
			t.Fatal("fabricated Hijacker")
		}
		if _, ok := w.(io.ReaderFrom); ok {
			t.Fatal("fabricated ReaderFrom")
		}
	}))
	h.ServeHTTP(&minimalWriter{header: make(http.Header)}, httptest.NewRequest("GET", "/minimal", nil))
}

func TestRegistryIsolationAndGoMetrics(t *testing.T) {
	first, second := New(), New()
	first.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/private", nil))
	if strings.Contains(scrape(t, second), "studiotv_http_requests_total{") {
		t.Fatal("registries share business metrics")
	}
	if !strings.Contains(scrape(t, second), "go_goroutines") {
		t.Fatal("missing Go collector")
	}
	metric := prometheus.NewGauge(prometheus.GaugeOpts{Name: "telemetry_default_registry_sentinel", Help: "test"})
	prometheus.MustRegister(metric)
	defer prometheus.Unregister(metric)
	if strings.Contains(scrape(t, first), "telemetry_default_registry_sentinel") {
		t.Fatal("default registry leaked into private scrape")
	}
}
