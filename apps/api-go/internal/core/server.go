package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"net/http"
	"os"
	"path/filepath"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/canvasdelta"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
	"studiotv.local/service/api/migrations"
	"strings"
	"time"
)

type DB interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}
type Server struct {
	canvasDeltas   *canvasdelta.Cache
	canvasPreviews canvasPreviewCache
	cfg            config.Config
	db             *pgxpool.Pool
	auth           httpapi.Authenticator
	authorization  *authorization.Service
	tokens         *security.Tokens
	schemas        map[string]*jsonschema.Schema
	registered     map[string]bool
}

func New(cfg config.Config, db *pgxpool.Pool, auth httpapi.Authenticator) (*chi.Mux, error) {
	sessions, _ := auth.(authorization.SessionVerifier)
	authorizer, err := authorization.FromEnv(cfg, sessions)
	if err != nil {
		return nil, err
	}
	return NewWithAuthorization(cfg, db, auth, authorizer)
}

// Resources holds the compiled v1 and canvas contracts and prepared storage.
// It deliberately does not load the proposed domain extension.
type Resources struct {
	CanvasDeltas *canvasdelta.Cache
	// CanvasWrite is the canonical operations handler for verified room messages.
	CanvasWrite     httpapi.Handler
	schemas         map[string]*jsonschema.Schema
	documents       []map[string]any
	signedAuthorize func(*http.Request, string, string) (*http.Request, error)
	signedAssetRead func(http.ResponseWriter, *http.Request, string) error
	bearerAuthorize func(context.Context, string) (httpapi.Identity, error)
	HTTPMiddleware  []func(http.Handler) http.Handler
}

// AuthorizeProductBearer is a private composition port for the trusted Agent
// executor. It shares live authentication and tv.access with ordinary requests.
func (r *Resources) AuthorizeProductBearer(ctx context.Context, bearer string) (httpapi.Identity, error) {
	if r == nil || r.bearerAuthorize == nil {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "登录校验尚未初始化。")
	}
	return r.bearerAuthorize(ctx, bearer)
}

func (r *Resources) AuthorizeSignedRequest(req *http.Request, owner, session string) (*http.Request, error) {
	if r == nil || r.signedAuthorize == nil {
		return nil, httpapi.Fail(401, "UNAUTHENTICATED", "签名素材认证尚未初始化。")
	}
	return r.signedAuthorize(req, owner, session)
}

// ServeSignedAsset reuses the native storage reader for an internally selected
// asset. Its ordinary signed token, live session and asset access checks remain
// mandatory; callers cannot replace them with a verified outer request alone.
func (r *Resources) ServeSignedAsset(w http.ResponseWriter, req *http.Request, assetID string) error {
	if r == nil || r.signedAssetRead == nil {
		return httpapi.Retry(503, "ASSET_STORAGE_UNAVAILABLE", "素材读取尚未初始化。")
	}
	return r.signedAssetRead(w, req, assetID)
}

// PrepareResources lets the composition root complete fallible initialization
// before assembling handlers. Legacy constructors also use this same path.
func PrepareResources(cfg config.Config) (*Resources, error) {
	resources := &Resources{CanvasDeltas: canvasdelta.New(), schemas: map[string]*jsonschema.Schema{}}
	raw, err := os.ReadFile(cfg.ContractPath)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	resource := "https://rhtv.local/contracts/openapi.json"
	if err = compiler.AddResource(resource, doc); err != nil {
		return nil, err
	}
	for _, name := range []string{"ProjectCreateRequest", "ProjectUpdateRequest", "ProjectSaveRequest", "AssetUploadRequest", "UploadCompleteRequest"} {
		schema, e := compiler.Compile(resource + "#/components/schemas/" + name)
		if e != nil {
			return nil, e
		}
		resources.schemas[name] = schema
	}
	if err = os.MkdirAll(cfg.StorageRoot, 0750); err != nil {
		return nil, err
	}
	resources.documents = []map[string]any{doc}
	extension := filepath.Join(filepath.Dir(cfg.ContractPath), "canvas-extension.json")
	if data, e := os.ReadFile(extension); e == nil {
		var ext map[string]any
		if err = json.Unmarshal(data, &ext); err != nil {
			return nil, err
		}
		resources.documents = append(resources.documents, ext)
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	return resources, nil
}

// NewWithAuthorization accepts explicitly prepared resources from bootstrap.
// Omitting them preserves the old four-argument constructor for callers/tests.
// A missing authorizer is always a denial, never authentication-only mode.
func NewWithAuthorization(cfg config.Config, db *pgxpool.Pool, auth httpapi.Authenticator, authorizer *authorization.Service, prepared ...*Resources) (*chi.Mux, error) {
	var resources *Resources
	switch len(prepared) {
	case 0:
		var err error
		resources, err = PrepareResources(cfg)
		if err != nil {
			return nil, err
		}
	case 1:
		resources = prepared[0]
	default:
		return nil, errors.New("expected one set of HTTP resources")
	}
	if resources == nil || len(resources.documents) == 0 || len(resources.schemas) == 0 {
		return nil, errors.New("HTTP resources are not prepared")
	}
	server := &Server{canvasDeltas: resources.CanvasDeltas, cfg: cfg, db: db, auth: auth, authorization: authorizer, tokens: security.New(cfg), schemas: resources.schemas, registered: map[string]bool{}}
	resources.signedAuthorize = func(req *http.Request, owner, session string) (*http.Request, error) {
		return server.signedRequest(req, owner, session, authorization.TVAccess)
	}
	resources.CanvasWrite = server.applyCanvasOperations
	resources.signedAssetRead = func(w http.ResponseWriter, req *http.Request, assetID string) error {
		route := chi.NewRouteContext()
		route.URLParams.Add("assetId", assetID)
		local := req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
		return server.readAsset(w, local)
	}
	resources.bearerAuthorize = func(ctx context.Context, bearer string) (httpapi.Identity, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", "http://studio-internal.invalid/", nil)
		if err != nil {
			return httpapi.Identity{}, err
		}
		req.Header.Set("Authorization", "Bearer "+bearer)
		identity, err := auth.Authenticate(ctx, req)
		if err != nil {
			return httpapi.Identity{}, err
		}
		if err = authorizer.Check(ctx, identity, authorization.TVAccess); err != nil {
			return httpapi.Identity{}, err
		}
		return identity, nil
	}
	r := chi.NewRouter()
	r.Use(httpapi.RequestContext)
	r.Use(collaboration.CanvasProofMiddleware)
	for _, middleware := range resources.HTTPMiddleware {
		if middleware == nil {
			return nil, errors.New("HTTP middleware required")
		}
		r.Use(middleware)
	}
	r.Use(httpapi.Base(cfg.AllowedOrigins))
	r.NotFound(httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
		return httpapi.Fail(404, "NOT_FOUND", "接口不存在。")
	}))
	r.MethodNotAllowed(httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
		return httpapi.Fail(404, "NOT_FOUND", "接口不存在。")
	}))
	server.route(r, "GET", "/healthz", false, func(w http.ResponseWriter, r *http.Request) error {
		return httpapi.JSON(w, 200, map[string]string{"status": "ok"})
	})
	server.route(r, "GET", "/readyz", false, server.ready)
	server.projects(r)
	server.projectPreviews(r)
	server.assets(r)
	for _, document := range resources.documents {
		paths, _ := document["paths"].(map[string]any)
		for path, value := range paths {
			operations, _ := value.(map[string]any)
			for verb, value := range operations {
				method := strings.ToUpper(verb)
				if !strings.Contains(" GET POST PUT PATCH DELETE HEAD ", " "+method+" ") {
					continue
				}
				url := "/api/v1" + path
				if server.registered[method+" "+url] {
					continue
				}
				operation, _ := value.(map[string]any)
				protected := true
				if authz, ok := operation["security"].([]any); ok && len(authz) == 0 {
					protected = false
				}
				op, _ := operation["operationId"].(string)
				model := op == "quoteGeneration" || op == "createGeneration" || op == "confirmGeneration" || op == "refreshGenerationQuote"
				server.route(r, method, url, protected, func(w http.ResponseWriter, r *http.Request) error {
					if model {
						return httpapi.Fail(501, "MODEL_PROVIDER_NOT_CONFIGURED", "模型供应商尚未配置，未执行生成。")
					}
					return httpapi.Fail(501, "NOT_IMPLEMENTED", "此接口协议已预留，功能尚未启用。")
				})
			}
		}
	}
	return r, nil
}
func (s *Server) route(r chi.Router, method, path string, protected bool, handler httpapi.Handler) {
	s.registered[method+" "+path] = true
	if feature := disabledFeature(path, s.cfg); feature != "" {
		r.MethodFunc(method, path, httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return httpapi.Fail(403, "FEATURE_DISABLED", "该功能未在当前版本启用。")
		}))
		return
	}
	if protected {
		r.MethodFunc(method, path, httpapi.RequireAuth(s.auth, s.requireCapability(method, path, handler)))
	} else {
		r.MethodFunc(method, path, httpapi.Wrap(handler))
	}
}
func disabledFeature(path string, cfg config.Config) string {
	feature := ""
	if strings.Contains(path, "/share-links") || strings.HasPrefix(path, "/api/v1/project-shares/") || strings.HasSuffix(path, "/share-link") {
		feature = "publicSharing"
	} else if strings.HasPrefix(path, "/api/v1/wallet") || strings.HasPrefix(path, "/api/v1/membership") || strings.HasPrefix(path, "/api/v1/orders") || strings.HasPrefix(path, "/api/v1/billing/") || path == "/api/v1/catalog/products" || path == "/api/v1/generation-quotes" || path == "/api/v1/generation-quotes/{quoteId}" || path == "/api/v1/generations/{generationId}/quote" || path == "/api/v1/generations/{generationId}/confirm" {
		feature = "billing"
	} else if strings.HasPrefix(path, "/api/v1/compositions") || strings.HasPrefix(path, "/api/v1/content/") {
		feature = "community"
	}
	// Guard the edition as well as resolved flags: programmatic config cannot enable internal billing.
	if feature != "" && (!cfg.Features[feature] || feature == "billing" && cfg.Edition != "external") {
		return feature
	}
	return ""
}
func (s *Server) ready(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var migrated bool
	entries, e := migrations.Files.ReadDir(".")
	if e != nil {
		return httpapi.Retry(503, "NOT_READY", "迁移清单尚未就绪。")
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			names = append(names, entry.Name())
		}
	}
	err := s.db.QueryRow(ctx, "SELECT count(*)=$2 FROM schema_migrations WHERE name=ANY($1::text[])", names, len(names)).Scan(&migrated)
	if err != nil || !migrated {
		return httpapi.Retry(503, "NOT_READY", "数据库或迁移尚未就绪。")
	}
	file, e := os.CreateTemp(s.cfg.StorageRoot, ".ready-")
	if e != nil {
		return httpapi.Retry(503, "NOT_READY", "存储尚未就绪。")
	}
	name := file.Name()
	file.Close()
	os.Remove(name)
	return httpapi.JSON(w, 200, map[string]string{"status": "ready", "database": "ready", "storage": "ready"})
}
func (s *Server) body(w http.ResponseWriter, r *http.Request, name string) (map[string]any, error) {
	var body map[string]any
	limit := int64(1024 * 1024)
	if name == "ProjectSaveRequest" {
		limit = 10 * 1024 * 1024
	}
	if err := httpapi.DecodeLimit(w, r, &body, limit); err != nil {
		return nil, err
	}
	keys := map[string]string{"ProjectCreateRequest": " name source ", "ProjectUpdateRequest": " name coverAssetId ", "ProjectSaveRequest": " graph ", "AssetUploadRequest": " projectId fileName mimeType byteSize checksumSha256 ", "UploadCompleteRequest": " etag "}
	for key := range body {
		if !strings.Contains(keys[name], " "+key+" ") {
			return nil, httpapi.Fail(400, "UNKNOWN_FIELD", "请求包含未知字段。")
		}
	}
	if err := s.schemas[name].Validate(body); err != nil {
		return nil, httpapi.Fail(400, "VALIDATION_FAILED", "请求字段不符合接口协议。")
	}
	return body, nil
}
func encode(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
func owner(r *http.Request) string { return httpapi.IdentityFrom(r).UserID }
func iso(value time.Time) string   { return value.UTC().Format("2006-01-02T15:04:05.000Z") }
func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}
func nullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}
func requireID(id string) error {
	if len(id) < 1 || len(id) > 64 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "资源ID无效。")
	}
	for i, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || i > 0 && (c == '_' || c == '-')) {
			return httpapi.Fail(400, "VALIDATION_FAILED", "资源ID无效。")
		}
	}
	return nil
}
func integerQuery(r *http.Request, key string, defaultValue, max int) (int, error) {
	value := r.URL.Query().Get(key)
	if value == "" {
		return defaultValue, nil
	}
	var v int
	if _, err := fmt.Sscan(value, &v); err != nil || fmt.Sprint(v) != value || v < 1 || v > max {
		return 0, httpapi.Fail(400, "VALIDATION_FAILED", "分页字段无效。")
	}
	return v, nil
}
