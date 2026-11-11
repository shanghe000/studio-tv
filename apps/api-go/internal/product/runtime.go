package product

import (
	"context"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"log/slog"
	"studiotv.local/service/api/internal/canvasdelta"
	"studiotv.local/service/api/internal/canvaswake"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/core"
	agentRuntime "studiotv.local/service/api/internal/modules/agentrun/adapters/codexappserver"
	agentHTTP "studiotv.local/service/api/internal/modules/agentrun/adapters/http"
	agentExecutor "studiotv.local/service/api/internal/modules/agentrun/adapters/pfhttp"
	agentPG "studiotv.local/service/api/internal/modules/agentrun/adapters/postgres"
	agent "studiotv.local/service/api/internal/modules/agentrun/application"
	assistantPG "studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	assistant "studiotv.local/service/api/internal/modules/assistant/application"
	canvasHTTP "studiotv.local/service/api/internal/modules/canvasagent/adapters/http"
	canvasPG "studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	canvas "studiotv.local/service/api/internal/modules/canvasagent/application"
	canvasDomain "studiotv.local/service/api/internal/modules/canvasagent/domain"
	executionHTTP "studiotv.local/service/api/internal/modules/execution/adapters/http"
	executionPostgres "studiotv.local/service/api/internal/modules/execution/adapters/postgres"
	styleCatalog "studiotv.local/service/api/internal/modules/execution/adapters/stylecatalog"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	libraryHTTP "studiotv.local/service/api/internal/modules/library/adapters/http"
	libraryPG "studiotv.local/service/api/internal/modules/library/adapters/postgres"
	library "studiotv.local/service/api/internal/modules/library/application"
	longformHTTP "studiotv.local/service/api/internal/modules/longform/adapters/http"
	longformPG "studiotv.local/service/api/internal/modules/longform/adapters/postgres"
	longform "studiotv.local/service/api/internal/modules/longform/application"
	chromium "studiotv.local/service/api/internal/modules/media/adapters/chromium"
	ffmpeg "studiotv.local/service/api/internal/modules/media/adapters/ffmpeg"
	mediaHTTP "studiotv.local/service/api/internal/modules/media/adapters/http"
	studiopg "studiotv.local/service/api/internal/modules/media/adapters/studiopg"
	media "studiotv.local/service/api/internal/modules/media/application"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	modelmediaHTTP "studiotv.local/service/api/internal/modules/modelmedia/adapters/http"
	modelmediaPG "studiotv.local/service/api/internal/modules/modelmedia/adapters/postgres"
	modelmediaFiles "studiotv.local/service/api/internal/modules/modelmedia/adapters/storage"
	modelmedia "studiotv.local/service/api/internal/modules/modelmedia/application"
	organizationHTTP "studiotv.local/service/api/internal/modules/organization/adapters/http"
	organizationPG "studiotv.local/service/api/internal/modules/organization/adapters/postgres"
	organization "studiotv.local/service/api/internal/modules/organization/application"
	resourceHTTP "studiotv.local/service/api/internal/modules/resources/adapters/http"
	resourcePG "studiotv.local/service/api/internal/modules/resources/adapters/postgres"
	resource "studiotv.local/service/api/internal/modules/resources/application"
	hfHTTP "studiotv.local/service/api/internal/modules/studioassistant/adapters/http"
	hfPG "studiotv.local/service/api/internal/modules/studioassistant/adapters/postgres"
	hf "studiotv.local/service/api/internal/modules/studioassistant/application"
	"studiotv.local/service/api/internal/observability"
	"studiotv.local/service/api/internal/telemetry"
	"sync"
	"time"
)

// Runtime assembles product execution explicitly after the pool has migrated.
// Worker shutdown belongs to bootstrap's BeforeClose, before releasing the pool.
type Runtime struct {
	canvasWakes  *canvaswake.Hub
	canvasListen *pgx.ConnConfig
	observer     *observability.Observer
	cfg          config.Config
	gateway      gateway.ExecutionGateway
	execution    *execution.Service
	agent        *agent.Service
	metrics      *telemetry.Server
	queue        execution.QueueReader
	longform     *longform.Service
}

// WithMetrics attaches aggregate telemetry before runtime assembly. It adds no
// business endpoints and does not alter model or canvas execution contracts.
func (rt *Runtime) WithMetrics(metrics *telemetry.Server) { rt.metrics = metrics }

func NewRuntime(cfg config.Config, g gateway.Gateway, observers ...*observability.Observer) (*Runtime, error) {
	executionGateway, ok := g.(gateway.ExecutionGateway)
	if !ok {
		return nil, errors.New("execution gateway is required")
	}
	rt := &Runtime{cfg: cfg, gateway: executionGateway}
	if len(observers) > 0 {
		rt.observer = observers[0]
	}
	return rt, nil
}
func (rt *Runtime) RegisterRoutes(r chi.Router, pool *pgxpool.Pool) error {
	return rt.assemble(r, r, pool, nil)
}
func (rt *Runtime) assemble(public, r chi.Router, pool *pgxpool.Pool, coreResources *core.Resources) error {
	if err := registerRoutes(r, pool, rt.gateway); err != nil {
		return err
	}
	store, err := executionPostgres.New(pool)
	if err != nil {
		return err
	}
	store.WithObserver(rt.observer)
	rt.queue = store
	registerGenerationDiagnostics(r, pool, rt.observer)
	presence, err := collaboration.NewPresenceService(pool)
	if err != nil {
		return err
	}
	if err = collaboration.RegisterPresenceRoutes(r, presence, protectedHandler); err != nil {
		return err
	}
	assets, err := core.NewProductAssetStore(rt.cfg, pool)
	if err != nil {
		return err
	}
	var longformGateway gateway.LongformGateway
	if g, ok := rt.gateway.(gateway.LongformGateway); ok {
		longformGateway = g
	}
	rt.longform = longform.New(longformPG.New(pool), longformGateway, assets, rt.cfg.ModelRealExecutionEnabled)
	var archivedReader longformHTTP.ArchivedAssetReader
	if coreResources != nil {
		archivedReader = coreResources.ServeSignedAsset
	}
	if err = longformHTTP.RegisterRoutes(r, rt.longform, protectedHandler, archivedReader); err != nil {
		return err
	}
	service, err := execution.New(store, rt.gateway, assets)
	if err != nil {
		return err
	}
	service.WithProjectAccess(func(ctx context.Context, actor, project string) (string, error) {
		scope, e := collaboration.RequireProject(ctx, pool, actor, project, "EDITOR", false)
		return scope.StorageOwnerID, e
	})
	if err = collaboration.RegisterRoutes(r, pool, protectedHandler); err != nil {
		return err
	}
	if err = collaboration.RegisterAssetRoutes(r, pool, rt.cfg.StorageRoot, protectedHandler); err != nil {
		return err
	}
	service.WithApps(appCatalog{pool})
	canvasContext, err := canvas.New(canvasPG.New(pool))
	if err != nil {
		return err
	}
	if err = canvasHTTP.RegisterRoutes(r, canvasContext, protectedHandler); err != nil {
		return err
	}
	service.WithCanvasContext(canvasContextInput{canvasContext})
	canvasCommands, err := canvas.NewCommandService(canvasPG.NewCommandUnitOfWork(pool), core.ValidateProductGraph)
	if err != nil {
		return err
	}
	canvasCommands.WithCapabilityResolver(func(ctx context.Context, owner string, selection *canvasDomain.CommandCapability) error {
		cap, e := service.ResolveCanvasSelection(ctx, owner, selection.Ref, selection.Version, selection.Parameters)
		if e != nil {
			return canvasDomain.ErrCommandInvalid
		}
		selection.Kind, selection.ParameterSchemaVersion = cap.Kind, cap.ParameterSchemaVersion
		return nil
	})
	if err = canvasHTTP.RegisterCommandRoutes(r, canvasCommands, protectedHandler); err != nil {
		return err
	}
	var deltaCache *canvasdelta.Cache
	if coreResources != nil {
		deltaCache = coreResources.CanvasDeltas
	}
	canvasLive, err := canvas.NewLiveService(canvasPG.New(pool), deltaCache)
	if err != nil {
		return err
	}
	rt.canvasWakes = canvaswake.New()
	rt.canvasListen = pool.Config().ConnConfig.Copy()
	if coreResources != nil && coreResources.CanvasWrite != nil {
		err = canvasHTTP.RegisterLiveRoom(public, r, canvasLive, protectedHandler, rt.canvasWakes, rt.cfg.AllowedOrigins, coreResources.AuthorizeProductBearer, coreResources.CanvasWrite, coreResources.HTTPMiddleware...)
	} else {
		err = canvasHTTP.RegisterLiveRoutes(r, canvasLive, protectedHandler, rt.canvasWakes)
	}
	if err != nil {
		return err
	}
	styles, err := styleCatalog.New(pool)
	if err != nil {
		return err
	}
	service.WithStyles(styles)
	service.WithRealExecution(rt.cfg.ModelRealExecutionEnabled)
	if err = modelmediaHTTP.Register(public, modelmedia.New(modelmediaPG.New(pool, store), modelmediaFiles.New(rt.cfg.StorageRoot)), rt.cfg.ModelMediaTokenFile,
		modelmediaHTTP.ExportConfig{PublicOrigin: rt.cfg.PublicBaseURL, SigningSecret: rt.cfg.SigningSecret}); err != nil {
		return err
	}
	if err = executionHTTP.RegisterRoutes(r, service, protectedHandler); err != nil {
		return err
	}
	assets.RegisterProductAssetRoutes(r, protectedHandler)
	resourceRepository, err := resourcePG.New(pool)
	if err != nil {
		return err
	}
	importing, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	err = resourceRepository.ImportCatalog(importing)
	if err == nil {
		err = styles.Import(importing)
	}
	cancel()
	if err != nil {
		return errors.New("product catalog import failed")
	}
	resourceService, err := resource.NewWithMedia(resourceRepository, assets)
	if err != nil {
		return err
	}
	resourceService.History = creationHistory{pool}
	if err = resourceHTTP.RegisterRoutes(r, resourceService, protectedHandler); err != nil {
		return err
	}
	libraryRepository, err := libraryPG.NewEntries(pool)
	if err != nil {
		return err
	}
	libraryEntries, err := library.NewEntries(libraryRepository)
	if err != nil {
		return err
	}
	if err = libraryHTTP.RegisterEntryRoutes(r, libraryEntries, protectedHandler); err != nil {
		return err
	}
	assistantUow, err := assistantPG.New(pool)
	if err != nil {
		return err
	}
	assistantService, err := assistant.New(assistantUow)
	if err != nil {
		return err
	}
	hfStore, err := hfPG.New(pool)
	if err != nil {
		return err
	}
	hfService, err := hf.New(hfStore, assistantService, service, rt.gateway)
	if err != nil {
		return err
	}
	if err = hfHTTP.RegisterRoutes(r, hfService, protectedHandler); err != nil {
		return err
	}
	engine, err := ffmpeg.New("ffmpeg", rt.cfg.FFprobePath, rt.cfg.MaxUploadBytes)
	if err != nil {
		return err
	}
	mediaService, err := media.New(store, assets, assets, engine)
	if err != nil {
		return err
	}
	mediaService.WithProjectAccess(func(ctx context.Context, actor, project string) (string, error) {
		scope, e := collaboration.RequireProject(ctx, pool, actor, project, "EDITOR", false)
		return scope.StorageOwnerID, e
	})
	studioRepository, err := studiopg.New(pool, store)
	if err != nil {
		return err
	}
	renderer, err := chromium.New("chromium", "ffmpeg", rt.cfg.FFprobePath, rt.cfg.MaxUploadBytes, rt.cfg.ChromiumSandboxMode)
	if err != nil {
		return err
	}
	studioService, err := media.NewStudio(store, studioRepository, renderer, assets)
	if err != nil {
		return err
	}
	mediaService.WithStudio(studioService)
	service.WithProcessor(mediaService)
	mediaHTTP.RegisterRoutes(r, mediaService, protectedHandler)
	if coreResources != nil {
		mediaHTTP.RegisterStudioRoutes(public, r, studioService, studioRepository, rt.cfg, protectedHandler, coreResources.AuthorizeSignedRequest)
	}
	organizationRepo, err := organizationPG.New(pool)
	if err != nil {
		return err
	}
	organizationService, err := organization.New(organizationRepo)
	if err != nil {
		return err
	}
	if err = organizationHTTP.RegisterRoutes(r, organizationService, protectedHandler); err != nil {
		return err
	}
	rt.execution = service
	agentStore, err := agentPG.New(pool)
	if err != nil {
		return err
	}
	var executor agent.Executor
	if coreResources != nil {
		executor, err = agentExecutor.New(fmt.Sprintf("http://127.0.0.1:%d", rt.cfg.Port), nil, func(ctx context.Context, bearer string) (agent.Actor, error) {
			i, e := coreResources.AuthorizeProductBearer(ctx, bearer)
			return agent.Actor{OwnerID: i.UserID, SessionID: i.SessionID, IssuedAt: i.AccessIssuedAt, AccessExpiresAt: i.AccessExpiresAt, SessionExpiresAt: i.SessionExpiresAt}, e
		})
		if err != nil {
			return err
		}
	}
	adapter := agentRuntime.New(agentRuntime.Config{Enabled: rt.cfg.AgentEnabled, ProfileValidated: rt.cfg.AgentProfileValidated, SocketPath: rt.cfg.AgentSocketPath, Models: []agent.Model{{ID: "gpt-6.1-sol", Efforts: []string{"low", "high"}, DefaultEffort: "low", Available: true}}})
	agentStore.WithObserver(rt.observer)
	agentService, err := agent.New(agentStore, adapter, executor, agent.Config{PromptSpec: execution.AgentCanvasPromptSpec()})
	if err != nil {
		return err
	}
	if err = agentHTTP.RegisterRoutes(r, agentService, protectedHandler); err != nil {
		return err
	}
	rt.agent = agentService
	return nil
}
func (rt *Runtime) RegisterRuntimeRoutes(public, business chi.Router, pool *pgxpool.Pool, resources *core.Resources) error {
	return rt.assemble(public, business, pool, resources)
}
func (rt *Runtime) Run(ctx context.Context) {
	var workers sync.WaitGroup
	if rt.canvasWakes != nil && rt.canvasListen != nil {
		workers.Add(1)
		go func() { defer workers.Done(); rt.canvasWakes.Run(ctx, rt.canvasListen) }()
	}
	if rt.longform != nil {
		workers.Add(1)
		go func() { defer workers.Done(); rt.longform.Run(ctx) }()
	}
	if rt.metrics != nil && rt.queue != nil {
		workers.Add(1)
		go func() {
			defer workers.Done()
			rt.metrics.RunGenerationQueue(ctx, func(reading context.Context) ([]telemetry.GenerationQueueGroup, error) {
				groups, err := rt.queue.GenerationQueue(reading)
				if err != nil {
					return nil, err
				}
				result := make([]telemetry.GenerationQueueGroup, len(groups))
				for i, group := range groups {
					result[i] = telemetry.GenerationQueueGroup{Kind: group.Kind, CapabilityFamily: group.CapabilityFamily, Queued: group.Queued, Running: group.Running, OldestQueuedAgeSeconds: group.OldestQueuedAgeSeconds}
				}
				return result, nil
			})
		}()
	}
	if rt.agent != nil {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for ctx.Err() == nil {
				if err := rt.agent.Worker(ctx); err == nil {
					return
				}
				slog.Error("Agent worker initialization failed")
				select {
				case <-ctx.Done():
					return
				case <-time.After(3 * time.Second):
				}
			}
		}()
	}
	if rt.execution != nil {
		rt.execution.Run(ctx)
	}
	workers.Wait()
}
