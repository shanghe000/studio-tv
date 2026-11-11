package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/testdb"
)

type listenerStub struct {
	started, stopped chan struct{}
	listenError      error
	shutdownError    error
	order            *[]string
	stopOnce         sync.Once
}

func (s *listenerStub) ListenAndServe() error {
	close(s.started)
	if s.listenError != nil {
		return s.listenError
	}
	<-s.stopped
	return http.ErrServerClosed
}

func (s *listenerStub) Shutdown(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > 10*time.Second {
		return errors.New("missing shutdown deadline")
	}
	*s.order = append(*s.order, "shutdown")
	if s.shutdownError == nil {
		s.stopOnce.Do(func() { close(s.stopped) })
	}
	return s.shutdownError
}

func (s *listenerStub) Close() error {
	s.stopOnce.Do(func() {
		*s.order = append(*s.order, "force close")
		close(s.stopped)
	})
	return nil
}

func TestServeClosesDatabaseAfterListenerFailureOrShutdown(t *testing.T) {
	failure := errors.New("test-sensitive-value")
	for _, test := range []struct {
		name, wantError string
		listenerError   error
		shutdownError   error
		alreadyCanceled bool
		wantOrder       []string
	}{
		{"listener failure", "HTTP listener", failure, nil, false, []string{"force close", "database close"}},
		{"listener already closed", "", http.ErrServerClosed, nil, false, []string{"force close", "database close"}},
		{"graceful shutdown", "", nil, nil, false, []string{"shutdown", "database close"}},
		{"shutdown failure", "HTTP graceful shutdown", nil, failure, false, []string{"shutdown", "force close", "database close"}},
		{"already stopped", "", nil, nil, true, []string{"force close", "database close"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var order []string
			listener := &listenerStub{started: make(chan struct{}), stopped: make(chan struct{}), listenError: test.listenerError, shutdownError: test.shutdownError, order: &order}
			app := &Application{server: listener, closeDatabase: func() { order = append(order, "database close") }}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if test.alreadyCanceled {
				cancel()
			}
			result := make(chan error, 1)
			go func() { result <- app.Serve(ctx) }()
			if !test.alreadyCanceled {
				select {
				case <-listener.started:
				case <-time.After(time.Second):
					t.Fatal("listener did not start")
				}
				if test.listenerError == nil {
					cancel()
				}
			}
			select {
			case err := <-result:
				if test.wantError == "" && err != nil || test.wantError != "" && (err == nil || err.Error() != test.wantError) {
					t.Fatalf("got %v, want %s", err, test.wantError)
				}
			case <-time.After(time.Second):
				t.Fatal("Serve did not finish")
			}
			app.Close()
			if !reflect.DeepEqual(order, test.wantOrder) {
				t.Fatalf("cleanup order=%v, want %v", order, test.wantOrder)
			}
			if test.alreadyCanceled {
				select {
				case <-listener.started:
					t.Fatal("canceled startup opened a listener")
				default:
				}
			}
		})
	}
}

// This entry point must run against the same disposable PG 17 used by the full
// API suite. No user, session or production credentials are needed or seeded.
func TestPostgresBootstrapLifecycle(t *testing.T) {
	db := testdb.New(t)
	for _, key := range []string{"IPAC_BASE_URL", "IPAC_ISSUER_URL", "IPAC_APP_ID", "IPAC_APP_SECRET", "IPAC_ALLOW_INSECURE_HTTP", "IPAC_REDIRECT_URI"} {
		t.Setenv(key, "")
	}
	cfg := testConfig(t)
	cfg.DatabaseURL = db.URL()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var pool *pgxpool.Pool
	app, err := New(ctx, cfg, func(_ chi.Router, db *pgxpool.Pool) error { pool = db; return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	for _, path := range []string{"/readyz", "/api/v1/auth/config"} {
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		if path == "/api/v1/auth/config" && (!strings.Contains(w.Body.String(), `"provider":"IPAC_FEISHU"`) || !strings.Contains(w.Body.String(), `"configured":false`)) {
			t.Fatal("authentication explanatory endpoint changed")
		}
	}
	app.Close()
	if pool == nil || pool.Ping(ctx) == nil {
		t.Fatal("bootstrap pool was not released")
	}
}
