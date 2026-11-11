package bootstrap

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/database"
	modelapp "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/product"
	"studiotv.local/service/api/internal/testdb"
)

type productCatalogFixture struct {
	modelapp.Unconfigured
	actor modelapp.Actor
	calls int
}

func (g *productCatalogFixture) Capabilities(_ context.Context, actor modelapp.Actor, _ modelapp.CapabilityQuery) (modelapp.CapabilityPage, error) {
	g.actor = actor
	g.calls++
	return modelapp.CapabilityPage{Items: []modelapp.Capability{}}, nil
}

func TestPostgresProductCatalogAndLibraryAreToolProtected(t *testing.T) {
	disposable := testdb.New(t)
	db := disposable.Open(t)
	ctx := context.Background()
	identity, runtime := &identityStub{}, &runtimeStub{allowed: true}
	closed := 0
	deps := testDependencies(identity, &closed)
	deps.open = func(context.Context, string) (*pgxpool.Pool, error) { return db, nil }
	deps.ping = func(ctx context.Context, p *pgxpool.Pool) error { return p.Ping(ctx) }
	deps.migrate = database.Migrate
	deps.close = func(p *pgxpool.Pool) { closed++; p.Close() }
	deps.authorize = func(_ config.Config, verifier authorization.SessionVerifier) (*authorization.Service, error) {
		return authorization.New(runtime, "test-client", verifier), nil
	}
	cfg := testConfig(t)
	cfg.DatabaseURL = disposable.URL()
	gateway := &productCatalogFixture{}
	app, err := initialize(ctx, cfg, deps, product.WithModelGateway(gateway))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES('usr_test','catalog-test@example.test','','Test owner'),('usr_other','catalog-other@example.test','','Other owner');
	 INSERT INTO library.collections(owner_id) VALUES('usr_other');
	 INSERT INTO library.items(id,owner_id,title,kind) VALUES('foreign_gallery','usr_other','Foreign','ROLE');`); err != nil {
		t.Fatal(err)
	}
	call := func(method, path, bearer, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", bearer)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", "969766f7-53b0-4f45-acb1-047d05d071c4")
		r.Header.Set("X-Router-Subject-Ref", "usr_other")
		r.Header.Set("X-Workspace-Id", "forged")
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s returned %d expected%d", method, path, w.Code, want)
		}
		return w
	}
	for _, path := range []string{"/api/v2/model-requirements", "/api/v2/model-capabilities", "/api/v2/library/items"} {
		call("GET", path, "", "", 401)
	}
	if gateway.calls != 0 {
		t.Fatal("anonymous identity reached catalog")
	}
	call("GET", "/api/v2/model-requirements", "Bearer test-access", "", 200)
	call("GET", "/api/v2/model-capabilities", "Bearer test-access", "", 200)
	if gateway.calls != 1 || gateway.actor.SubjectRef != "usr_test" {
		t.Fatal("caller headers changed model owner")
	}
	page := call("GET", "/api/v2/library/items", "Bearer test-access", "", 200)
	if !strings.Contains(page.Body.String(), `"records":[]`) || !strings.Contains(page.Body.String(), `"total":0`) {
		t.Fatal("new owner received seeded or foreign gallery")
	}
	created := call("POST", "/api/v2/library/items", "Bearer test-access", `{"title":"Own fox","description":"","kind":"ROLE","assetIds":[],"mainAssetId":null}`, 201)
	var envelope struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(created.Body.Bytes(), &envelope) != nil || envelope.Data.ID == "" {
		t.Fatal("gallery was not persisted")
	}
	var owner string
	if db.QueryRow(ctx, "SELECT owner_id FROM library.items WHERE id=$1", envelope.Data.ID).Scan(&owner) != nil || owner != "usr_test" {
		t.Fatal("untrusted header changed gallery owner")
	}
	call("GET", "/api/v2/library/items/"+envelope.Data.ID, "Bearer test-access", "", 200)
	call("GET", "/api/v2/library/items/foreign_gallery", "Bearer test-access", "", 404)
	runtime.allowed = false
	identity.sessionID = "ses_catalog_denied"
	for _, path := range []string{"/api/v2/model-requirements", "/api/v2/model-capabilities", "/api/v2/library/items"} {
		call("GET", path, "Bearer test-access", "", 403)
	}
	if gateway.calls != 1 {
		t.Fatal("denied tool permission reached model service")
	}
	app.Close()
	if closed != 1 {
		t.Fatal("composition leaked pool")
	}
}
