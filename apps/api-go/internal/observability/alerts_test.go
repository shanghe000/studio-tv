package observability

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func acceptedResponse() *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"code":0}`)), Header: make(http.Header)}
}

func TestDeduplicationUsesRouteStatusAndCodeNotRequestID(t *testing.T) {
	endpoint, _, calls := fakeWebhook(t)
	now := time.Now()
	var nanoseconds atomic.Int64
	nanoseconds.Store(now.UnixNano())
	o, output := testObserver(t, Config{WebhookURL: endpoint, RateWindow: time.Minute, Clock: func() time.Time { return time.Unix(0, nanoseconds.Load()) }, ErrorCode: func(r *http.Request) string {
		if chi.URLParam(r, "id") == "other-code" {
			return "PROVIDER_UNAVAILABLE"
		}
		return "UPSTREAM_UNAVAILABLE"
	}})
	router := chi.NewRouter()
	router.Use(o.Middleware)
	router.Get("/items/{id}", func(w http.ResponseWriter, r *http.Request) {
		if chi.URLParam(r, "id") == "other-status" {
			w.WriteHeader(502)
			return
		}
		w.WriteHeader(503)
	})
	for _, id := range []string{"one", "two", "three", "other-code", "other-status"} {
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/items/"+id, nil))
	}
	waitFor(t, func() bool { return o.Stats().Sent == 3 })
	if o.Stats().Suppressed != 2 {
		t.Fatal("fresh correlation IDs defeated error deduplication")
	}
	rows := requestLogs(t, output)
	if rows[0]["log_id"] == rows[1]["log_id"] {
		t.Fatal("test did not exercise distinct log IDs")
	}
	nanoseconds.Store(now.Add(time.Minute).UnixNano())
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/items/four", nil))
	closeObserver(t, o)
	if calls.Load() != 4 || o.Stats().Sent != 4 {
		t.Fatal("notification was not released at rate-window expiry")
	}
}

func TestConcurrentFailuresEnqueueOnlyOneNotification(t *testing.T) {
	endpoint, _, calls := fakeWebhook(t)
	o, _ := testObserver(t, Config{WebhookURL: endpoint})
	router := chi.NewRouter()
	router.Use(o.Middleware)
	router.Get("/items/{id}", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) })
	var group sync.WaitGroup
	for index := 0; index < 64; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/items/any", nil))
		}()
	}
	group.Wait()
	closeObserver(t, o)
	if calls.Load() != 1 || o.Stats().Enqueued != 1 || o.Stats().Suppressed != 63 {
		t.Fatal("concurrent failures escaped deduplication")
	}
}

func TestQueuedRequestAlertDoesNotBorrowCallerLifetime(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		select {
		case <-release:
			return acceptedResponse(), nil
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
	})}
	o, _ := testObserver(t, Config{WebhookURL: "https://hooks.invalid/private-capability", HTTPClient: client})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	handler := o.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/failure", nil).WithContext(ctx))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("alert did not start")
	}
	cancel()
	close(release)
	closeObserver(t, o)
	if o.Stats().Sent != 1 || o.Stats().Failed != 0 {
		t.Fatal("handler completion canceled an already queued genuine error alert")
	}
}

func TestQueueIsBoundedAndNeverBlocksRequestHandlers(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int64
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
			return acceptedResponse(), nil
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
	})}
	o, output := testObserver(t, Config{WebhookURL: "https://hooks.invalid/PRIVATE_CAPABILITY", HTTPClient: client, QueueCapacity: 1})
	router := chi.NewRouter()
	router.Use(o.Middleware)
	for _, route := range []string{"/first", "/queued", "/dropped"} {
		router.Get(route, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) })
	}
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/first", nil))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("delivery did not start")
	}
	done := make(chan struct{})
	go func() {
		for _, route := range []string{"/queued", "/dropped"} {
			router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", route, nil))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("webhook latency blocked a request handler")
	}
	stats := o.Stats()
	if stats.Enqueued != 2 || stats.Dropped != 1 || len(o.queue) != 1 {
		t.Fatal("queue bound was exceeded", stats)
	}
	close(release)
	closeObserver(t, o)
	if calls.Load() != 2 || strings.Contains(output.String(), "PRIVATE") {
		t.Fatal("queue delivery or privacy failed")
	}
}

func TestDedupMapHasFiniteCardinalityAndReclaimsExpiredKeys(t *testing.T) {
	endpoint, _, _ := fakeWebhook(t)
	now := time.Now()
	var timestamp atomic.Int64
	timestamp.Store(now.UnixNano())
	o, _ := testObserver(t, Config{WebhookURL: endpoint, MaxDedupKeys: 2, Clock: func() time.Time { return time.Unix(0, timestamp.Load()) }})
	for _, code := range []string{"FIRST", "SECOND"} {
		if err := o.KeyEvent(context.Background(), code); err != nil {
			t.Fatal(err)
		}
	}
	if err := o.KeyEvent(context.Background(), "THIRD"); !errors.Is(err, ErrQueueFull) {
		t.Fatal("unbounded dedup key was accepted")
	}
	o.mu.Lock()
	size := len(o.windows)
	o.mu.Unlock()
	if size != 2 {
		t.Fatal("dedup map exceeded its bound")
	}
	timestamp.Store(now.Add(time.Minute).UnixNano())
	if err := o.KeyEvent(context.Background(), "THIRD"); err != nil {
		t.Fatal("expired dedup entries were not reclaimed", err)
	}
	closeObserver(t, o)
}

func TestCheckAcknowledgesFeishuBusinessResponse(t *testing.T) {
	for _, sample := range []struct {
		name, body string
		status     int
		accepted   bool
	}{
		{"modern", `{"code":0}`, 200, true},
		{"legacy", `{"StatusCode":0}`, 200, true},
		{"both", `{"code":0,"StatusCode":0}`, 200, true},
		{"business-error", `{"code":19021,"msg":"PRIVATE_PROVIDER_ERROR"}`, 200, false},
		{"conflicting-status", `{"code":0,"StatusCode":1}`, 200, false},
		{"missing-code", `{"message":"success"}`, 200, false},
		{"null-code", `{"code":null}`, 200, false},
		{"empty", "", 200, false},
		{"non-json", "PRIVATE_PROVIDER_ERROR", 200, false},
		{"oversized", strings.Repeat("PRIVATE", 700), 200, false},
		{"transport-status", `{"code":0}`, 503, false},
	} {
		t.Run(sample.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json; charset=utf-8" {
					t.Error("invalid notification request")
				}
				w.WriteHeader(sample.status)
				_, _ = io.WriteString(w, sample.body)
			}))
			t.Cleanup(server.Close)
			o, output := testObserver(t, Config{WebhookURL: server.URL + "/PRIVATE_HOOK"})
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := o.Check(ctx)
			if sample.accepted && err != nil {
				t.Fatal("accepted notification reported failure", err)
			}
			if !sample.accepted && !errors.Is(err, ErrDelivery) {
				t.Fatal("delivery was accepted without a successful business response")
			}
			closeObserver(t, o)
			if strings.Contains(output.String(), "PRIVATE") || (err != nil && strings.Contains(err.Error(), "PRIVATE")) {
				t.Fatal("webhook URL or error response leaked")
			}
			if sample.accepted && o.Stats().Sent != 1 {
				t.Fatal("acknowledged message was not counted")
			}
		})
	}
}

func TestRedirectNeverForwardsCapabilityOrMessage(t *testing.T) {
	var redirected atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		_, _ = io.WriteString(w, `{"code":0}`)
	}))
	t.Cleanup(target.Close)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/PRIVATE_TARGET", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(server.Close)
	o, output := testObserver(t, Config{WebhookURL: server.URL + "/PRIVATE_HOOK", HTTPClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return nil }}})
	if err := o.Check(context.Background()); !errors.Is(err, ErrDelivery) {
		t.Fatal("redirect was considered successful")
	}
	closeObserver(t, o)
	if redirected.Load() != 0 || strings.Contains(output.String(), "PRIVATE") {
		t.Fatal("redirect followed or leaked")
	}
}

func TestCheckCancellationAndShutdownCancelInflightDelivery(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(map[bool]string{false: "check-cancel", true: "shutdown-deadline"}[shutdown], func(t *testing.T) {
			started, stopped := make(chan struct{}), make(chan struct{})
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				close(started)
				<-r.Context().Done()
				close(stopped)
				return nil, errors.New("PRIVATE_URL_SECRET")
			})}
			o, output := testObserver(t, Config{WebhookURL: "https://hooks.invalid/PRIVATE_HOOK", HTTPClient: client})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- o.Check(ctx) }()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("delivery did not start")
			}
			if shutdown {
				closeContext, stop := context.WithTimeout(context.Background(), 10*time.Millisecond)
				defer stop()
				if err := o.Close(closeContext); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("shutdown ignored its deadline")
				}
			} else {
				cancel()
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("inflight delivery was not canceled")
			}
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("canceled delivery was acknowledged")
				}
			case <-time.After(time.Second):
				t.Fatal("Check waiter leaked")
			}
			closeObserver(t, o)
			if strings.Contains(output.String(), "PRIVATE") {
				t.Fatal("transport error leaked")
			}
			if err := o.KeyEvent(context.Background(), "AFTER_CLOSE"); !errors.Is(err, ErrClosed) {
				t.Fatal("closed observer accepted a notification")
			}
		})
	}
}

func TestDisabledAndCanceledChecksNeverAttemptDelivery(t *testing.T) {
	var calls atomic.Int64
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { calls.Add(1); return acceptedResponse(), nil })}
	o, _ := testObserver(t, Config{HTTPClient: client})
	if err := o.Check(context.Background()); !errors.Is(err, ErrDisabled) {
		t.Fatal("disabled notification reported success")
	}
	enabled, _ := testObserver(t, Config{WebhookURL: "https://hooks.invalid/PRIVATE_HOOK", HTTPClient: client})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := enabled.Check(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled check was queued")
	}
	if err := enabled.KeyEvent(ctx, "EVENT"); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled key event was queued")
	}
	if calls.Load() != 0 || enabled.Stats().Enqueued != 0 {
		t.Fatal("disabled/canceled action contacted the webhook")
	}
}

func TestTransportPanicDoesNotKillWorkerOrLeakValue(t *testing.T) {
	var calls atomic.Int64
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			panic("PRIVATE_TRANSPORT_PANIC")
		}
		return acceptedResponse(), nil
	})}
	o, output := testObserver(t, Config{WebhookURL: "https://hooks.invalid/PRIVATE_HOOK", HTTPClient: client})
	if err := o.Check(context.Background()); !errors.Is(err, ErrDelivery) {
		t.Fatal("transport panic was not contained")
	}
	if err := o.KeyEvent(context.Background(), "RECOVERED"); err != nil {
		t.Fatal("worker did not survive transport panic", err)
	}
	closeObserver(t, o)
	if o.Stats().Sent != 1 || o.Stats().Failed != 1 || strings.Contains(output.String(), "PRIVATE") {
		t.Fatal("worker recovery or privacy failed")
	}
}

func TestInvalidConfigurationErrorsNeverContainEndpoint(t *testing.T) {
	for _, endpoint := range []string{"http://public.invalid/PRIVATE_HOOK", "https://PRIVATE_USER:PRIVATE_PASSWORD@hooks.invalid/hook", "https://hooks.invalid/hook?token=PRIVATE_QUERY", "https://hooks.invalid/PRIVATE_HOOK#fragment", strings.Repeat("PRIVATE", 400)} {
		_, err := New(Config{WebhookURL: endpoint, Output: io.Discard})
		if err == nil || strings.Contains(err.Error(), "PRIVATE") {
			t.Fatal("invalid configuration accepted or exposed credentials")
		}
	}
}
