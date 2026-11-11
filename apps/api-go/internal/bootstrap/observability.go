package bootstrap

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/observability"
	"studiotv.local/service/api/internal/telemetry"
)

// Observability is owned by one application. Supplying the shared registry from
// main lets the Router and IPAC transports contribute to the same private scrape.
type Observability struct {
	Logger  *observability.Observer
	Metrics *telemetry.Server
}

func metricsFor(cfg config.Config) *telemetry.Server {
	if cfg.MetricsEnabled {
		return telemetry.New()
	}
	return nil
}

func NewObserver(cfg config.Config) (*observability.Observer, error) {
	level := slog.LevelInfo
	switch cfg.LogLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	return observability.New(observability.Config{LogDirectory: cfg.LogDirectory, Level: level, ServiceName: "studiotv-api", Environment: cfg.Environment, ServerName: "deployment-host", WebhookURL: cfg.AlertWebhookURL, ErrorCode: httpapi.ErrorCode, RecordError: httpapi.RecordError})
}

func prepareObservers(cfg config.Config, value Observability) (Observability, error) {
	if value.Metrics == nil {
		value.Metrics = metricsFor(cfg)
	}
	if value.Logger == nil {
		logger, err := NewObserver(cfg)
		if err != nil {
			return value, err
		}
		value.Logger = logger
	}
	return value, nil
}

func closeObserver(value *observability.Observer) {
	if value == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = value.Close(ctx)
}

type correlationTransport struct{ next http.RoundTripper }

func (t correlationTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	id := observability.LogID(r.Context())
	if id == "" {
		id = httpapi.RequestID(r)
	}
	if id != "" {
		copy := r.Clone(r.Context())
		copy.Header = r.Header.Clone()
		copy.Header.Set("log_id", id)
		r = copy
	}
	return t.next.RoundTrip(r)
}
func (t correlationTransport) CloseIdleConnections() {
	if c, ok := t.next.(interface{ CloseIdleConnections() }); ok {
		c.CloseIdleConnections()
	}
}
func upstreamTransport(metrics *telemetry.Server, dependency string, next http.RoundTripper) http.RoundTripper {
	if next == nil {
		next = http.DefaultTransport
	}
	var result http.RoundTripper = correlationTransport{next}
	if metrics != nil {
		result = metrics.WrapTransport(dependency, result)
	}
	return result
}
