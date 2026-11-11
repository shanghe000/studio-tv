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
	"studiotv.local/service/api/internal/product"
	"studiotv.local/service/api/internal/testdb"
)

// Exercise the production registrar under the actual bootstrap middleware and
// real PG persistence. Only IPAC itself uses explicit test fixtures.
func TestPostgresProductRegistrarRequiresVerifiedToolAccess(t *testing.T) {
	disposable := testdb.New(t)
	db := disposable.Open(t)
	ctx := context.Background()
	identity, runtime := &identityStub{}, &runtimeStub{allowed: true}
	closed := 0
	deps := testDependencies(identity, &closed)
	deps.open = func(context.Context, string) (*pgxpool.Pool, error) { return db, nil }
	deps.ping = func(ctx context.Context, db *pgxpool.Pool) error { return db.Ping(ctx) }
	deps.migrate = database.Migrate
	deps.close = func(db *pgxpool.Pool) { closed++; db.Close() }
	deps.authorize = func(_ config.Config, verifier authorization.SessionVerifier) (*authorization.Service, error) {
		return authorization.New(runtime, "test-client", verifier), nil
	}
	cfg := testConfig(t)
	cfg.DatabaseURL = disposable.URL()
	app, err := initialize(ctx, cfg, deps, product.RegisterRoutes)
	if err != nil {
		t.Fatal("production product registrar failed to initialize", err)
	}
	t.Cleanup(app.Close)
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES
	  ('usr_test','registrar-a@example.test','','A'),('usr_other','registrar-b@example.test','','B');
	  INSERT INTO projects(id,owner_id,name) VALUES('project_test','usr_test','A'),('project_other','usr_other','B');
	  INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id,title) VALUES('foreign_conversation','usr_other','CANVAS','project_other','B');`); err != nil {
		t.Fatal("cannot seed explicit product registrar fixture")
	}
	call := func(method, path, bearer, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if bearer != "" {
			r.Header.Set("Authorization", bearer)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", "16b56e5a-268d-46cc-82e7-0e2dd6d7fbb1")
		r.Header.Set("X-Router-Subject-Ref", "usr_other")
		r.Header.Set("X-Workspace-Id", "forged-workspace")
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: got%d expected%d", method, path, w.Code, status)
		}
		return w
	}
	call("GET", "/api/v2/conversations", "", "", 401)
	if len(runtime.requests) != 0 || len(runtime.checks) != 0 {
		t.Fatal("unauthenticated request reached live authorization")
	}
	created := call("POST", "/api/v2/conversations", "Bearer test-access", `{"kind":"CANVAS","projectId":"project_test","title":"persisted"}`, 201)
	var envelope struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(created.Body.Bytes(), &envelope) != nil || envelope.Data.ID == "" {
		t.Fatal("registered create did not return persisted root")
	}
	var owner string
	if db.QueryRow(ctx, "SELECT owner_id FROM assistant.conversations WHERE id=$1", envelope.Data.ID).Scan(&owner) != nil || owner != "usr_test" {
		t.Fatal("browser headers changed trusted product owner")
	}
	call("GET", "/api/v2/conversations/"+envelope.Data.ID+"/messages", "Bearer test-access", "", 200)
	call("GET", "/api/v2/conversations/foreign_conversation/messages", "Bearer test-access", "", 404)
	call("POST", "/api/v2/conversations/"+envelope.Data.ID+"/runs", "Bearer test-access", `{}`, 501)
	runtime.allowed = false
	identity.sessionID = "ses_product_denied"
	call("GET", "/api/v2/conversations", "Bearer test-access", "", 403)
	runtime.allowed, runtime.stale = true, true
	identity.sessionID = "ses_product_stale"
	call("GET", "/api/v2/conversations", "Bearer test-access", "", 401)
	if len(identity.revoked) != 1 || identity.revoked[0] != identity.sessionID {
		t.Fatal("revoked upstream identity did not revoke local product session")
	}
	app.Close()
	if closed != 1 {
		t.Fatal("product bootstrap did not release database exactly once")
	}
}
