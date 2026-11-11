// Package bootstrap assembles the API's concrete adapters and owns their
// lifecycle. Business modules do not read environment or open databases here.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	ipacruntime "studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"studiotv.local/service/api/internal/auth"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/ipachttp"
	"studiotv.local/service/api/internal/principal"
	"studiotv.local/service/api/internal/security"
)

// ModulesRegistrar explicitly registers implemented product routes. The router
// already enforces verified identity and live tv.access for every module route;
// handlers must enforce owner isolation using httpapi.IdentityFrom. This seam
// never discovers packages or loads routes from the proposed domain contract.
type ModulesRegistrar func(chi.Router, *pgxpool.Pool) error
type RuntimeRegistrar func(public chi.Router, business chi.Router, pool *pgxpool.Pool, resources *core.Resources) error

type authentication interface {
	httpapi.Authenticator
	authorization.SessionVerifier
	RegisterRoutes(chi.Router)
}

// These small, private adapter seams let lifecycle tests inject failures without
// PostgreSQL, a listener, or an upstream identity service.
type dependencies struct {
	open         func(context.Context, string) (*pgxpool.Pool, error)
	ping         func(context.Context, *pgxpool.Pool) error
	migrate      func(context.Context, *pgxpool.Pool) error
	close        func(*pgxpool.Pool)
	authenticate func(config.Config, *pgxpool.Pool, *security.Tokens) (authentication, error)
	authorize    func(config.Config, authorization.SessionVerifier) (*authorization.Service, error)
	observers    Observability
}

func productionDependencies(observers ...Observability) dependencies {
	var instrumentation Observability
	if len(observers) > 0 {
		instrumentation = observers[0]
	}
	return dependencies{
		observers: instrumentation,
		open:      database.Open,
		ping:      func(ctx context.Context, db *pgxpool.Pool) error { return db.Ping(ctx) },
		migrate:   database.Migrate,
		close:     func(db *pgxpool.Pool) { db.Close() },
		authenticate: func(cfg config.Config, db *pgxpool.Pool, tokens *security.Tokens) (authentication, error) {
			return auth.New(cfg, db, tokens, func(next http.RoundTripper) http.RoundTripper {
				return upstreamTransport(instrumentation.Metrics, "ipac", next)
			})
		},
		authorize: func(cfg config.Config, sessions authorization.SessionVerifier) (*authorization.Service, error) {
			ipac, err := auth.LoadConfig(cfg)
			if err != nil {
				return nil, err
			}
			client := ipachttp.NewClient(0)
			client.Transport = upstreamTransport(instrumentation.Metrics, "ipac", client.Transport)
			return newAuthorization(ipac, sessions, client)
		},
	}
}

func loadAuthorization(cfg config.Config, sessions authorization.SessionVerifier) (*authorization.Service, error) {
	ipac, err := auth.LoadConfig(cfg)
	if err != nil {
		return nil, err
	}
	return newAuthorization(ipac, sessions)
}

func newAuthorization(cfg auth.Config, sessions authorization.SessionVerifier, clients ...*http.Client) (*authorization.Service, error) {
	if len(clients) > 1 {
		return nil, errors.New("one IPAC HTTP client is permitted")
	}
	if cfg.BaseURL == "" || cfg.ClientID == "" || cfg.ClientSecret == "" {
		// Keep the explanatory login configuration endpoint available, while
		// business operations continue to fail closed when IPAC is unconfigured.
		return authorization.New(nil, cfg.ClientID, sessions), nil
	}
	httpClient := ipachttp.NewClient(0)
	if len(clients) == 1 && clients[0] != nil {
		httpClient = clients[0]
	}
	client, err := ipacruntime.NewHTTPClient(ipacruntime.HTTPConfig{
		BaseURL: cfg.BaseURL, ApplicationID: cfg.ClientID,
		ApplicationSecret: cfg.ClientSecret, AllowInsecureHTTP: cfg.AllowInsecureHTTP,
		HTTPClient: httpClient,
	})
	if err != nil {
		return nil, errors.New("invalid IPAC authorization configuration")
	}
	return authorization.New(client, cfg.ClientID, sessions), nil
}

type httpServer interface {
	ListenAndServe() error
	Shutdown(context.Context) error
	Close() error
}

// Application owns one pool and HTTP server. Close is safe to call after Serve,
// or when a caller uses Handler directly instead of opening a listener.
type Application struct {
	handler        http.Handler
	server         httpServer
	closeDatabase  func()
	closed         sync.Once
	cleanupMu      sync.Mutex
	cleanups       []func()
	cleanupStarted bool
	port           int
	edition        string
	metricsServer  httpServer
	metricsHandler http.Handler
	observers      Observability
}

// New initializes the database, authentication, authorization, storage and
// contracts, then registers explicitly supplied modules. On any error after
// opening the database it releases the pool before returning.
func New(ctx context.Context, cfg config.Config, modules ...ModulesRegistrar) (*Application, error) {
	observers, err := prepareObservers(cfg, Observability{})
	if err != nil {
		return nil, errors.New("observability configuration")
	}
	return initialize(ctx, cfg, productionDependencies(observers), modules...)
}
func NewWithRuntime(ctx context.Context, cfg config.Config, module RuntimeRegistrar, instrumentation ...Observability) (*Application, error) {
	if len(instrumentation) > 1 {
		return nil, errors.New("one observability composition is permitted")
	}
	if module == nil {
		return nil, errors.New("runtime registrar required")
	}
	var observers Observability
	if len(instrumentation) == 1 {
		observers = instrumentation[0]
	}
	observers, err := prepareObservers(cfg, observers)
	if err != nil {
		return nil, errors.New("observability configuration")
	}
	return initializeRuntime(ctx, cfg, productionDependencies(observers), []RuntimeRegistrar{module})
}

func initialize(ctx context.Context, cfg config.Config, deps dependencies, modules ...ModulesRegistrar) (*Application, error) {
	return initializeRuntime(ctx, cfg, deps, nil, modules...)
}
func initializeRuntime(ctx context.Context, cfg config.Config, deps dependencies, runtimeModules []RuntimeRegistrar, modules ...ModulesRegistrar) (*Application, error) {
	observers, err := prepareObservers(cfg, deps.observers)
	if err != nil {
		return nil, errors.New("observability configuration")
	}
	initialized := false
	defer func() {
		if !initialized {
			closeObserver(observers.Logger)
		}
	}()
	db, err := deps.open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, errors.New("database configuration")
	}
	defer func() {
		if !initialized {
			deps.close(db)
		}
	}()
	if err = deps.ping(ctx, db); err != nil {
		return nil, errors.New("database connection")
	}
	if err = deps.migrate(ctx, db); err != nil {
		return nil, errors.New("database migration")
	}
	if db != nil {
		observers.Logger.SetActorNameResolver(func(ctx context.Context, actorID string) (string, error) {
			var name string
			err := db.QueryRow(ctx, "SELECT display_name FROM public.users WHERE id=$1", actorID).Scan(&name)
			return name, err
		})
	}
	identity, err := deps.authenticate(cfg, db, security.New(cfg))
	if err != nil {
		return nil, errors.New("authentication configuration")
	}
	if identity == nil {
		return nil, errors.New("authentication configuration")
	}
	access, err := deps.authorize(cfg, identity)
	if err != nil || access == nil {
		return nil, errors.New("authorization configuration")
	}
	resources, err := core.PrepareResources(cfg)
	if err != nil {
		return nil, errors.New("HTTP contract or storage initialization")
	}
	if observers.Metrics != nil {
		if db != nil {
			if err = observers.Metrics.RegisterPool(db); err != nil {
				return nil, errors.New("database metrics registration")
			}
		}
		resources.HTTPMiddleware = append(resources.HTTPMiddleware, observers.Metrics.Middleware)
	}
	resources.HTTPMiddleware = append(resources.HTTPMiddleware, observers.Logger.Middleware)
	router, err := core.NewWithAuthorization(cfg, db, identity, access, resources)
	if err != nil {
		return nil, errors.New("HTTP contract or storage initialization")
	}
	identity.RegisterRoutes(router)
	var registrationError error
	router.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return httpapi.RequireAuth(identity, func(w http.ResponseWriter, request *http.Request) error {
				if err := access.Check(request.Context(), httpapi.IdentityFrom(request), authorization.TVAccess); err != nil {
					return err
				}
				request = request.WithContext(principal.WithActor(request.Context(), httpapi.IdentityFrom(request).UserID))
				if len(request.Header.Values(collaboration.CanvasSessionHeader)) > 1 {
					return httpapi.Fail(400, "VALIDATION_FAILED", "画布会话标识不能重复。")
				}
				request = request.WithContext(collaboration.WithCanvasLeaseRequest(request.Context(), httpapi.IdentityFrom(request), request.Header.Get(collaboration.CanvasSessionHeader)))
				frozen := request.Clone(request.Context())
				request = httpapi.WithLiveAuthorization(request, httpapi.LiveAuthorization{Revalidate: func(ctx context.Context) (httpapi.Identity, error) {
					verified, err := identity.Authenticate(ctx, frozen)
					if err != nil {
						return httpapi.Identity{}, err
					}
					if err = access.Check(ctx, verified, authorization.TVAccess); err != nil {
						return httpapi.Identity{}, err
					}
					return verified, nil
				}})
				next.ServeHTTP(w, request)
				return nil
			})
		})
		for _, register := range modules {
			if register == nil {
				registrationError = errors.New("missing module registrar")
				return
			}
			if registrationError = register(r, db); registrationError != nil {
				return
			}
		}
		for _, register := range runtimeModules {
			if register == nil {
				registrationError = errors.New("runtime registrar required")
				return
			}
			if registrationError = register(router, r, db, resources); registrationError != nil {
				return
			}
		}
	})
	if registrationError != nil {
		return nil, errors.New("HTTP module initialization")
	}
	app := &Application{
		handler: router, closeDatabase: func() { deps.close(db) }, port: cfg.Port, edition: cfg.Edition, observers: observers,
		server: &http.Server{
			Addr: fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), Handler: router,
			ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024,
		},
	}
	if cfg.MetricsEnabled && observers.Metrics != nil {
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", observers.Metrics.Handler())
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
		app.metricsHandler = mux
		app.metricsServer = &http.Server{Addr: cfg.MetricsAddress, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, WriteTimeout: 10 * time.Second, MaxHeaderBytes: 8 * 1024}
	}
	initialized = true
	return app, nil
}

func (a *Application) Handler() http.Handler        { return a.handler }
func (a *Application) MetricsHandler() http.Handler { return a.metricsHandler }

func (a *Application) BeforeClose(cleanup func()) error {
	if cleanup == nil {
		return errors.New("cleanup is required")
	}
	a.cleanupMu.Lock()
	defer a.cleanupMu.Unlock()
	if a.cleanupStarted {
		return errors.New("application is closed")
	}
	a.cleanups = append(a.cleanups, cleanup)
	return nil
}
func (a *Application) Close() {
	a.closed.Do(func() {
		if a.server != nil {
			_ = a.server.Close()
		}
		if a.metricsServer != nil {
			_ = a.metricsServer.Close()
		}
		a.cleanupMu.Lock()
		a.cleanupStarted = true
		hooks := append([]func(){}, a.cleanups...)
		a.cleanupMu.Unlock()
		for i := len(hooks) - 1; i >= 0; i-- {
			hooks[i]()
		}
		closeObserver(a.observers.Logger)
		a.closeDatabase()
	})
}

// Serve releases the pool after listener failure or shutdown. A timed-out
// graceful shutdown forcibly closes connections before releasing resources.
func (a *Application) Serve(ctx context.Context) error {
	defer a.Close()
	if ctx.Err() != nil {
		return nil
	}
	type listenerResult struct {
		err     error
		metrics bool
	}
	result := make(chan listenerResult, 2)
	go func() { result <- listenerResult{err: a.server.ListenAndServe()} }()
	if a.metricsServer != nil {
		go func() { result <- listenerResult{err: a.metricsServer.ListenAndServe(), metrics: true} }()
	}
	slog.Info("API started", "port", a.port, "edition", a.edition, "authentication", "IPAC_FEISHU")
	select {
	case ended := <-result:
		if a.metricsServer != nil {
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = a.shutdownHTTP(shutdown)
		}
		if errors.Is(ended.err, http.ErrServerClosed) {
			return nil
		}
		if ended.metrics {
			return errors.New("metrics HTTP listener")
		}
		return errors.New("HTTP listener")
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := a.shutdownHTTP(shutdown); err != nil {
			return errors.New("HTTP graceful shutdown")
		}
		return nil
	}
}

func (a *Application) shutdownHTTP(ctx context.Context) error {
	var failed bool
	if a.metricsServer != nil {
		if err := a.metricsServer.Shutdown(ctx); err != nil {
			_ = a.metricsServer.Close()
			failed = true
		}
	}
	if err := a.server.Shutdown(ctx); err != nil {
		_ = a.server.Close()
		failed = true
	}
	if failed {
		return errors.New("HTTP graceful shutdown")
	}
	return nil
}

// Run is the production composition root. Environment is read only for normal
// startup; the command's healthcheck path never enters this function.
func Run(ctx context.Context, modules ...ModulesRegistrar) error {
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("configuration: %s", err.Error())
	}
	initializing, cancel := context.WithTimeout(ctx, 60*time.Second)
	app, err := New(initializing, cfg, modules...)
	cancel()
	if err != nil {
		return err
	}
	return app.Serve(ctx)
}
