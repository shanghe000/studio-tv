package telemetry

import (
	"context"
	"errors"
	"net/http"
	"time"
)

type measuredTransport struct {
	server     *Server
	dependency string
	next       http.RoundTripper
}

// WrapTransport records aggregate attempts until headers arrive. It leaves
// request/response bodies, credentials, context, and transport errors intact.
// Arbitrary dependency strings collapse to unknown; URLs are never labels.
func (s *Server) WrapTransport(dependency string, next http.RoundTripper) http.RoundTripper {
	if dependency != "ipac" && dependency != "models_router" {
		dependency = "unknown"
	}
	if next == nil {
		next = http.DefaultTransport
	}
	return &measuredTransport{server: s, dependency: dependency, next: next}
}

func (t *measuredTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	started := time.Now()
	response, err := t.next.RoundTrip(r)
	class, outcome := "none", "response"
	if response != nil {
		class = statusClass(response.StatusCode)
	}
	if err != nil {
		outcome = "error"
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			outcome = "canceled"
		}
	}
	t.server.upstreamRequests.WithLabelValues(t.dependency, class, outcome).Inc()
	t.server.upstreamDuration.WithLabelValues(t.dependency, class, outcome).Observe(time.Since(started).Seconds())
	return response, err
}

// Preserve http.Client.CloseIdleConnections for transports that support it.
func (t *measuredTransport) CloseIdleConnections() {
	if closer, ok := t.next.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
