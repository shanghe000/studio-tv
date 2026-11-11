package telemetry

import (
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/felixge/httpsnoop"
	"github.com/go-chi/chi/v5"
)

// Middleware belongs in chi.Use outside the application's recovery middleware.
// It observes an inner recovery's actual status and never recovers a panic or
// writes an error response itself. An escaping panic with no committed status
// is counted as 5xx; a response already committed retains its actual class.
func (s *Server) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		s.inflight.Inc()
		var mu sync.Mutex
		code, written := 0, int64(0)
		completed := false
		commit := func(status int) {
			mu.Lock()
			defer mu.Unlock()
			if code == 0 {
				code = status
			}
		}
		addBytes := func(n int64) {
			mu.Lock()
			defer mu.Unlock()
			if code == 0 {
				code = http.StatusOK
			}
			written += n
		}
		wrapped := httpsnoop.Wrap(w, httpsnoop.Hooks{
			WriteHeader: func(next httpsnoop.WriteHeaderFunc) httpsnoop.WriteHeaderFunc {
				return func(status int) {
					next(status)
					if status < 100 || status >= 200 || status == http.StatusSwitchingProtocols {
						commit(status)
					}
				}
			},
			Write: func(next httpsnoop.WriteFunc) httpsnoop.WriteFunc {
				return func(p []byte) (int, error) { n, err := next(p); addBytes(int64(n)); return n, err }
			},
			ReadFrom: func(next httpsnoop.ReadFromFunc) httpsnoop.ReadFromFunc {
				return func(reader io.Reader) (int64, error) { n, err := next(reader); addBytes(n); return n, err }
			},
			Flush: func(next httpsnoop.FlushFunc) httpsnoop.FlushFunc {
				return func() { next(); commit(http.StatusOK) }
			},
		})
		defer func() {
			s.inflight.Dec()
			mu.Lock()
			status, size := code, written
			mu.Unlock()
			if status == 0 {
				status = http.StatusOK
				if !completed {
					status = http.StatusInternalServerError
				}
			}
			method, route, class := methodLabel(r.Method), routeLabel(r), statusClass(status)
			s.requests.WithLabelValues(method, route, class).Inc()
			s.duration.WithLabelValues(method, route, class).Observe(time.Since(started).Seconds())
			s.bytes.WithLabelValues(method, route, class).Add(float64(size))
		}()
		next.ServeHTTP(wrapped, r)
		completed = true
	})
}

func routeLabel(r *http.Request) string {
	rctx := chi.RouteContext(r.Context())
	if rctx == nil || rctx.Routes == nil {
		return "unmatched"
	}
	path := r.URL.Path
	if r.URL.RawPath != "" {
		path = r.URL.RawPath
	}
	// Find returns a registered pattern, including nested mounts. It excludes
	// partially matched mounts, not-found paths and unsupported methods. Never
	// fall back to r.URL.Path or a parameter value.
	pattern := rctx.Routes.Find(chi.NewRouteContext(), r.Method, path)
	if pattern == "" || len(pattern) > 512 || !strings.HasPrefix(pattern, "/") || strings.ContainsAny(pattern, "?#\r\n") {
		return "unmatched"
	}
	return pattern
}
