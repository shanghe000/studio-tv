package telemetry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTransportPreservesResponseErrorAndBoundsLabels(t *testing.T) {
	s := New()
	request, _ := http.NewRequest("GET", "http://private-user:private-password@invalid/private-project?token=private-query", nil)
	request.Header.Set("Authorization", "Bearer private-token")
	body := io.NopCloser(strings.NewReader("private-upstream-body"))
	response := &http.Response{StatusCode: 503, Body: body}
	failure := errors.New("private-upstream-error")
	for _, test := range []struct {
		dependency string
		response   *http.Response
		err        error
	}{{"ipac", response, nil}, {"models_router", nil, context.DeadlineExceeded}, {"private-subject-123", nil, failure}} {
		transport := s.WrapTransport(test.dependency, roundTripFunc(func(got *http.Request) (*http.Response, error) {
			if got != request || got.Header.Get("Authorization") != "Bearer private-token" {
				t.Fatal("request changed")
			}
			return test.response, test.err
		}))
		got, err := transport.RoundTrip(request)
		if got != test.response || err != test.err {
			t.Fatal("transport response/error changed")
		}
	}
	if response.Body != body {
		t.Fatal("body replaced or consumed")
	}
	metrics := scrape(t, s)
	for _, secret := range []string{"private-user", "private-password", "private-project", "private-query", "private-token", "private-upstream-body", "private-upstream-error", "private-subject"} {
		if strings.Contains(metrics, secret) {
			t.Fatalf("private outbound data leaked: %s", secret)
		}
	}
	for _, line := range []string{`studiotv_upstream_http_requests_total{dependency="ipac",outcome="response",status_class="5xx"} 1`, `studiotv_upstream_http_requests_total{dependency="models_router",outcome="canceled",status_class="none"} 1`, `studiotv_upstream_http_requests_total{dependency="unknown",outcome="error",status_class="none"} 1`} {
		if !strings.Contains(metrics, line) {
			t.Fatalf("missing %s", line)
		}
	}
	if s.WrapTransport("ipac", nil).(*measuredTransport).next != http.DefaultTransport {
		t.Fatal("nil transport default incorrect")
	}
}
