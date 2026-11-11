// Package telemetry exposes aggregate operational metrics without business
// identities, URLs, query strings, headers, bodies, or error messages.
package telemetry

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var durationBuckets = []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60}

// Server owns its registry. It never registers collectors with the process-wide
// default registry and does not start a listener or modify business handlers.
type Server struct {
	registry         *prometheus.Registry
	requests         *prometheus.CounterVec
	duration         *prometheus.HistogramVec
	bytes            *prometheus.CounterVec
	inflight         prometheus.Gauge
	upstreamRequests *prometheus.CounterVec
	upstreamDuration *prometheus.HistogramVec
	generationQueue  *generationQueueCollector
}

func New() *Server {
	labels := []string{"method", "route", "status_class"}
	upstreamLabels := []string{"dependency", "status_class", "outcome"}
	s := &Server{
		registry:         prometheus.NewRegistry(),
		requests:         prometheus.NewCounterVec(prometheus.CounterOpts{Name: "studiotv_http_requests_total", Help: "Completed business HTTP requests, grouped by registered route template."}, labels),
		duration:         prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "studiotv_http_request_duration_seconds", Help: "Business HTTP handler duration including the complete lifetime of streams.", Buckets: durationBuckets}, labels),
		bytes:            prometheus.NewCounterVec(prometheus.CounterOpts{Name: "studiotv_http_response_bytes_total", Help: "Business response body bytes successfully written; excludes headers and direct writes to hijacked connections."}, labels),
		inflight:         prometheus.NewGauge(prometheus.GaugeOpts{Name: "studiotv_http_requests_in_flight", Help: "Business HTTP handlers currently running, including streams."}),
		upstreamRequests: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "studiotv_upstream_http_requests_total", Help: "Outbound HTTP transport attempts; no URL, identity, or error text is recorded."}, upstreamLabels),
		upstreamDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "studiotv_upstream_http_request_duration_seconds", Help: "Outbound HTTP transport duration until response headers or transport failure, excluding body consumption.", Buckets: durationBuckets}, upstreamLabels),
		generationQueue:  newGenerationQueueCollector(),
	}
	s.registry.MustRegister(s.requests, s.duration, s.bytes, s.inflight, s.upstreamRequests, s.upstreamDuration, s.generationQueue,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return s
}

// Handler is intended for a separate, private listener. It does not instrument
// scrapes as business requests. Network access control belongs to that listener.
func (s *Server) Handler() http.Handler {
	return promhttp.HandlerFor(s.registry, promhttp.HandlerOpts{EnableOpenMetrics: true, MaxRequestsInFlight: 2, Timeout: 5 * time.Second})
}

func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodConnect, http.MethodOptions, http.MethodTrace:
		return method
	default:
		return "OTHER"
	}
}

func statusClass(code int) string {
	switch {
	case code >= 100 && code < 200:
		return "1xx"
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500 && code < 600:
		return "5xx"
	default:
		return "other"
	}
}
