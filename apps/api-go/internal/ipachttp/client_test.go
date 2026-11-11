package ipachttp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	ipacruntime "studio.example.invalid/maintainer/ipac-client-kit/runtime"
)

func TestClientsAndOfficialRuntimeShareBoundWithoutSkippingRequests(t *testing.T) {
	var active, maximum, calls atomic.Int32
	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		current := active.Add(1)
		defer active.Add(-1)
		for current > maximum.Load() {
			previous := maximum.Load()
			if current <= previous || maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		entered <- struct{}{}
		<-release
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ipacruntime.Decision{
			Allowed: true, SubjectStatus: "ACTIVE", ApplicationStatus: "ACTIVE", CurrentSessionVersion: 3,
		})
	}))
	defer server.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	clientA, clientB := NewClient(3*time.Second), NewClient(3*time.Second)
	runtime, err := ipacruntime.NewHTTPClient(ipacruntime.HTTPConfig{
		BaseURL: server.URL, ApplicationID: "test-app", ApplicationSecret: "test-only-secret",
		AllowInsecureHTTP: true, HTTPClient: NewClient(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func(i int) {
			if i%2 == 0 {
				_, err := runtime.Check(context.Background(), ipacruntime.CheckRequest{
					SubjectID: "test-subject", SessionVersion: 3, CapabilityCode: "tv.access",
					Scope: ipacruntime.Scope{ProjectID: "test-project", EnvironmentID: "test-environment"},
				})
				done <- err
				return
			}
			client := clientA
			if i%4 == 3 {
				client = clientB
			}
			request, err := http.NewRequest(http.MethodPost, server.URL+"/oidc/session-status", strings.NewReader(`{"subject_id":"test-subject","session_id":"test-session","session_version":3}`))
			if err != nil {
				done <- err
				return
			}
			request.SetBasicAuth("test-app", "test-only-secret")
			response, err := client.Do(request)
			if err == nil {
				_, err = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
			}
			done <- err
		}(i)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("two requests did not enter the upstream")
		}
	}
	select {
	case <-entered:
		t.Fatal("more than two requests entered before a slot was released")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	for i := 0; i < 8; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("queued request did not complete")
		}
	}
	if calls.Load() != 8 || maximum.Load() != 2 {
		t.Fatalf("forwarded %d requests, maximum concurrency %d", calls.Load(), maximum.Load())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func testTransport(base http.RoundTripper) *boundedTransport {
	return &boundedTransport{base: base, slots: make(chan struct{}, 2)}
}

func testRequest(t *testing.T, ctx context.Context) *http.Request {
	t.Helper()
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://ipac.example.test/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

type trackedBody struct {
	io.Reader
	closed   atomic.Int32
	closeErr error
}

func (b *trackedBody) Close() error {
	b.closed.Add(1)
	return b.closeErr
}

func TestResponseBodyKeepsSlotUntilEOFOrCloseAndReleasesOnlyOnce(t *testing.T) {
	base := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: &trackedBody{Reader: strings.NewReader("response")}}, nil
	})
	transport := testTransport(base)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	first, err := transport.RoundTrip(testRequest(t, ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	second, err := transport.RoundTrip(testRequest(t, ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer second.Body.Close()
	third := make(chan *http.Response, 1)
	failures := make(chan error, 1)
	request := testRequest(t, ctx)
	go func() {
		response, err := transport.RoundTrip(request)
		if err != nil {
			failures <- err
			return
		}
		third <- response
	}()
	select {
	case <-third:
		t.Fatal("response headers released a slot before body consumption")
	case <-time.After(30 * time.Millisecond):
	}
	if _, err := io.Copy(io.Discard, first.Body); err != nil {
		t.Fatal(err)
	}
	if err := first.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-third:
		defer response.Body.Close()
	case err := <-failures:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("EOF did not release a slot")
	}
	// EOF followed by Close must not release a second permit: second and third
	// still own both permits, so a fourth request must expire in the queue.
	waitCtx, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stop()
	if _, err := transport.RoundTrip(testRequest(t, waitCtx)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("duplicate body release admitted a fourth request: %v", err)
	}
	if err := second.Body.Close(); err != nil {
		t.Fatal(err)
	}
	fourth, err := transport.RoundTrip(testRequest(t, ctx))
	if err != nil {
		t.Fatal("early Close did not free a slot", err)
	}
	_ = fourth.Body.Close()
}

func TestQueuedCancellationClosesRequestBodyWithoutCallingUpstream(t *testing.T) {
	for _, behavior := range []string{"cancel", "deadline", "already canceled"} {
		t.Run(behavior, func(t *testing.T) {
			var calls atomic.Int32
			transport := testTransport(roundTripFunc(func(*http.Request) (*http.Response, error) {
				calls.Add(1)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("held"))}, nil
			}))
			if behavior != "already canceled" {
				for i := 0; i < 2; i++ {
					response, err := transport.RoundTrip(testRequest(t, context.Background()))
					if err != nil {
						t.Fatal(err)
					}
					defer response.Body.Close()
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			want := context.Canceled
			if behavior == "deadline" {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 30*time.Millisecond)
				want = context.DeadlineExceeded
			}
			defer cancel()
			request := testRequest(t, ctx)
			body := &trackedBody{Reader: strings.NewReader("request")}
			request.Body = body
			if behavior == "already canceled" {
				cancel()
			}
			result := make(chan error, 1)
			go func() {
				_, err := transport.RoundTrip(request)
				result <- err
			}()
			if behavior == "cancel" {
				select {
				case err := <-result:
					t.Fatalf("full transport did not queue the request: %v", err)
				case <-time.After(30 * time.Millisecond):
				}
				cancel()
			}
			select {
			case err := <-result:
				if !errors.Is(err, want) {
					t.Fatalf("expected %v, got %v", want, err)
				}
			case <-time.After(time.Second):
				t.Fatal("queue did not observe cancellation")
			}
			wantCalls := int32(2)
			if behavior == "already canceled" {
				wantCalls = 0
			}
			if calls.Load() != wantCalls || body.closed.Load() != 1 {
				t.Fatalf("canceled request reached upstream or leaked its body: calls=%d closed=%d", calls.Load(), body.closed.Load())
			}
		})
	}
}

func TestTransportFailureAndEmptyResponsesDoNotLeakSlots(t *testing.T) {
	failure := errors.New("test-only transport error")
	for _, behavior := range []string{"error", "nil response", "nil body", "no body", "close error"} {
		t.Run(behavior, func(t *testing.T) {
			transport := testTransport(roundTripFunc(func(*http.Request) (*http.Response, error) {
				switch behavior {
				case "error":
					return nil, failure
				case "nil response":
					return nil, nil
				case "nil body":
					return &http.Response{StatusCode: 200}, nil
				case "no body":
					return &http.Response{StatusCode: 204, Body: http.NoBody}, nil
				default:
					return &http.Response{StatusCode: 500, Body: &trackedBody{Reader: strings.NewReader("error"), closeErr: failure}}, nil
				}
			}))
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			for i := 0; i < 4; i++ {
				response, err := transport.RoundTrip(testRequest(t, ctx))
				if behavior == "error" {
					if !errors.Is(err, failure) {
						t.Fatalf("transport failure changed: %v", err)
					}
				} else if err != nil {
					t.Fatal("slot leaked", err)
				}
				if response != nil && response.Body != nil {
					err := response.Body.Close()
					if behavior == "close error" && !errors.Is(err, failure) {
						t.Fatalf("body close error changed: %v", err)
					}
				}
			}
		})
	}
}
