package bootstrap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"image"
	"image/png"
	"net/http/httptest"
	"os"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/modelgateway/adapters/router"
	gatewayapp "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/product"
	"studiotv.local/service/api/internal/testdb"
	"strings"
	"testing"
	"time"
)

// Real production composition, middleware, PG, HTTP Router and worker. Only
// the upstream IPAC identity fixture replaces login in this isolated test.
func TestPostgresCompleteRuntimeRouterMockAndHF(t *testing.T) {
	origin := os.Getenv("TEST_MODELS_ROUTER_MOCK_BASE_URL")
	if origin == "" {
		t.Skip("explicit isolated mock Router required")
	}
	secret := func(name string) string {
		p := os.Getenv(name + "_FILE")
		if p == "" {
			return os.Getenv(name)
		}
		b, e := os.ReadFile(p)
		if e != nil {
			t.Fatal("test credential file unavailable")
		}
		return strings.TrimSpace(string(b))
	}
	key, e := base64.StdEncoding.DecodeString(secret("TEST_MODELS_ROUTER_SIGNING_KEY_B64"))
	if e != nil {
		t.Fatal(e)
	}
	gateway, e := router.New(router.Config{BaseURL: origin, ClientApp: os.Getenv("TEST_MODELS_ROUTER_CLIENT_APP"), ServiceToken: secret("TEST_MODELS_ROUTER_TOKEN"), SigningKey: key})
	if e != nil {
		t.Fatal(e)
	}
	disposable := testdb.New(t)
	db := disposable.Open(t)
	ctx := context.Background()
	identity, permission := &identityStub{}, &runtimeStub{allowed: true}
	closed := 0
	deps := testDependencies(identity, &closed)
	deps.open = func(context.Context, string) (*pgxpool.Pool, error) { return db, nil }
	deps.ping = func(c context.Context, p *pgxpool.Pool) error { return p.Ping(c) }
	deps.migrate = database.Migrate
	deps.close = func(p *pgxpool.Pool) { closed++; p.Close() }
	deps.authorize = func(_ config.Config, v authorization.SessionVerifier) (*authorization.Service, error) {
		return authorization.New(permission, "test-client", v), nil
	}
	cfg := testConfig(t)
	cfg.DatabaseURL = disposable.URL()
	cfg.ChromiumSandboxMode = os.Getenv("TEST_CHROMIUM_SANDBOX_MODE")
	cfg.MaxUploadBytes = 16 << 20
	cfg.FFprobePath = "ffprobe"
	runtime, e := product.NewRuntime(cfg, gateway)
	if e != nil {
		t.Fatal(e)
	}
	app, e := initializeRuntime(ctx, cfg, deps, []RuntimeRegistrar{runtime.RegisterRuntimeRoutes})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(app.Close)
	if _, e = db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('usr_test','runtime-a@example.test','A'),('usr_other','runtime-b@example.test','B');INSERT INTO public.projects(id,owner_id,name)VALUES('runtime_project','usr_test','Runtime'),('runtime_foreign','usr_other','Foreign');`); e != nil {
		t.Fatal(e)
	}
	working, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); runtime.Run(working) }()
	if e = app.BeforeClose(func() { stop(); <-done }); e != nil {
		t.Fatal(e)
	}
	call := func(method, path, body, etag, key, bearer string, status int) map[string]any {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if bearer != "" {
			r.Header.Set("Authorization", bearer)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Router-Subject-Ref", "usr_other")
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		if etag != "" {
			r.Header.Set("If-Match", etag)
		}
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s got%d want%d body=%s", method, path, w.Code, status, w.Body.String())
		}
		var envelope struct{ Data map[string]any }
		_ = json.Unmarshal(w.Body.Bytes(), &envelope)
		return envelope.Data
	}
	const bearer = "Bearer test-access"
	for _, path := range []string{"/api/v2/characters", "/api/v2/library/entries", "/api/v2/project-folders", "/api/v1/notifications"} {
		call("GET", path, "", "", "", "", 401)
		call("GET", path, "", "", "", bearer, 200)
	}
	call("GET", "/api/v2/projects/runtime_foreign/folder", "", "", "", bearer, 404)
	call("GET", "/api/v2/not-a-product-api", "", "", "", bearer, 404)
	var appRevision int64
	var appContent []byte
	if e = db.QueryRow(ctx, "SELECT revision,content FROM resources.items WHERE id='2104978260240449537' AND family='APP'").Scan(&appRevision, &appContent); e != nil {
		t.Fatal(e)
	}
	var appForm struct {
		InputNodes []struct {
			NodeID    string `json:"nodeId"`
			FieldName string `json:"fieldName"`
		}
	}
	if json.Unmarshal(appContent, &appForm) != nil || len(appForm.InputNodes) == 0 {
		t.Fatal("actual app form absent")
	}
	inputs := []any{}
	for _, field := range appForm.InputNodes {
		inputs = append(inputs, map[string]any{"nodeId": field.NodeID, "fieldName": field.FieldName, "fieldValue": "explicit MOCK app test"})
	}
	appBody, _ := json.Marshal(map[string]any{"projectId": "runtime_project", "nodeId": "app-node", "appId": "2104978260240449537", "appRevision": appRevision, "inputNodes": inputs, "capabilityRef": "mock-text-to-image", "capabilityVersion": "1", "parameters": map[string]any{}})
	appKey := uuid.NewString()
	appTask := call("POST", "/api/v2/app-runs", string(appBody), "", appKey, bearer, 202)
	appId := appTask["id"].(string)
	if call("POST", "/api/v2/app-runs", string(appBody), "", appKey, bearer, 202)["id"] != appId {
		t.Fatal("app replay duplicated task")
	}
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		appTask = call("GET", "/api/v2/tasks/"+appId, "", "", "", bearer, 200)
		if appTask["state"] == "SUCCEEDED" {
			break
		}
		if appTask["state"] == "FAILED" {
			t.Fatal("actual app task failed", appTask["errorCode"])
		}
		time.Sleep(100 * time.Millisecond)
	}
	if appTask["state"] != "SUCCEEDED" || appTask["testMode"] != true {
		t.Fatal("app did not complete with explicit test provenance")
	}
	creations := call("GET", "/api/v2/apps/2104978260240449537/creations?page=1&size=20", "", "", "", bearer, 200)
	if creations["total"] != float64(1) {
		t.Fatal("app output not persisted as actual creations", creations["total"])
	}
	c := call("POST", "/api/v2/conversations", `{"kind":"HF","title":"Actual HF mock"}`, "", uuid.NewString(), bearer, 201)
	cid := c["id"].(string)
	agent := call("POST", "/api/v2/hf/conversations/"+cid+"/agent", `{}`, "", uuid.NewString(), bearer, 201)["agentId"].(string)
	command, _ := json.Marshal(map[string]string{"agentId": agent, "message": "explicit mock HF turn"})
	runKey := uuid.NewString()
	run := call("POST", "/api/v2/hf/conversations/"+cid+"/runs", string(command), "", runKey, bearer, 202)
	id := run["id"].(string)
	replay := call("POST", "/api/v2/hf/conversations/"+cid+"/runs", string(command), "", runKey, bearer, 202)
	if replay["id"] != id {
		t.Fatal("HF replay created another run")
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		run = call("GET", "/api/v2/assistant-runs/"+id, "", "", "", bearer, 200)
		if run["state"] == "SUCCEEDED" {
			break
		}
		if run["state"] == "FAILED" {
			t.Fatalf("HF model failed %v", run["errorCode"])
		}
		time.Sleep(100 * time.Millisecond)
	}
	if run["state"] != "SUCCEEDED" || run["testMode"] != true {
		t.Fatal("HF task not completed with test provenance")
	}
	messages := call("GET", "/api/v2/conversations/"+cid+"/messages", "", "", "", bearer, 200)
	if messages["total"] != float64(2) {
		t.Fatal("HF turn not durably committed", messages["total"])
	}
	// A vault upload referenced only by this HF conversation is protected
	// while visible, and can be removed after its underlying Canvas is gone.
	assetStore, e := core.NewProductAssetStore(cfg, db)
	if e != nil {
		t.Fatal(e)
	}
	vault, e := assetStore.EnsureVault(ctx, "usr_test", "ASSET_VAULT")
	if e != nil {
		t.Fatal(e)
	}
	var pngBytes bytes.Buffer
	if e = png.Encode(&pngBytes, image.NewNRGBA(image.Rect(0, 0, 4, 4))); e != nil {
		t.Fatal(e)
	}
	hash := sha256.Sum256(pngBytes.Bytes())
	imageKind := "IMAGE"
	asset, e := assetStore.Import(ctx, "usr_test", vault, "hf-reference-test", gatewayapp.Artifact{Ref: "actual-test-upload", Kind: &imageKind, MediaType: "image/png", SizeBytes: int64(pngBytes.Len()), SHA256: hex.EncodeToString(hash[:])}, pngBytes.Bytes())
	if e != nil {
		t.Fatal(e)
	}
	currentConversation := call("GET", "/api/v2/conversations/"+cid, "", "", "", bearer, 200)
	attachmentBody, _ := json.Marshal(map[string]any{"content": []any{map[string]string{"type": "ASSET", "assetId": asset.ID}}})
	versionBytes, _ := json.Marshal(currentConversation["revision"])
	call("POST", "/api/v2/conversations/"+cid+"/messages", string(attachmentBody), "\""+string(versionBytes)+"\"", uuid.NewString(), bearer, 201)
	call("DELETE", "/api/v1/assets/"+asset.ID, "", "", "", bearer, 409)
	hf := call("POST", "/api/v2/hf/projects", `{"title":"Actual HF project","projectId":"runtime_project"}`, "", uuid.NewString(), bearer, 201)
	hfid := hf["id"].(string)
	binding, _ := json.Marshal(map[string]string{"sessionId": cid})
	call("POST", "/api/v2/hf/projects/"+hfid+"/sessions", string(binding), "", uuid.NewString(), bearer, 200)
	var bound string
	if e = db.QueryRow(ctx, "SELECT hf_project_id FROM assistant.conversations WHERE id=$1", cid).Scan(&bound); e != nil || bound != hfid {
		t.Fatal("HF binding not persisted", e)
	}
	// Binding a visible HF conversation to a live Canvas must retain protection.
	call("DELETE", "/api/v1/assets/"+asset.ID, "", "", "", bearer, 409)
	active := call("GET", "/api/v2/assistant/conversations/"+cid+"/runs?state=active", "", "", "", bearer, 200)
	if len(active["records"].([]any)) != 0 {
		t.Fatal("terminal task reported active")
	}
	call("GET", "/api/v2/assistant/conversations/foreign/runs?state=active", "", "", "", bearer, 404)
	// HF inherits the actual owning Canvas lifecycle even though its task has
	// no direct project_id. Reads and new model requests must agree with history.
	if _, e = db.Exec(ctx, "UPDATE public.projects SET deleted_at=now(),revision=revision+1 WHERE id=$1", "runtime_project"); e != nil {
		t.Fatal(e)
	}
	call("GET", "/api/v2/conversations/"+cid+"/messages", "", "", "", bearer, 404)
	call("GET", "/api/v2/assistant/conversations/"+cid+"/runs?state=active", "", "", "", bearer, 404)
	call("GET", "/api/v2/assistant-runs/"+id, "", "", "", bearer, 404)
	var retainedReferences int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM assistant.message_assets WHERE asset_id=$1 AND conversation_id=$2", asset.ID, cid).Scan(&retainedReferences); e != nil || retainedReferences != 1 {
		t.Fatal("HF lifecycle must preserve its historical asset reference", e)
	}
	call("DELETE", "/api/v1/assets/"+asset.ID, "", "", "", bearer, 200)
	permission.allowed = false
	identity.sessionID = "ses_runtime_denied"
	call("GET", "/api/v2/characters", "", "", "", bearer, 403)
	permission.allowed = true
	stop()
	<-done
	app.Close()
	if closed != 1 {
		t.Fatal("runtime did not release pool exactly once")
	}
}
