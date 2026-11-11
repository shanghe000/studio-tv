package bootstrap

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	gatewayapp "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/observability"
	"studiotv.local/service/api/internal/product"
	"studiotv.local/service/api/internal/testdb"
)

func TestPostgresPreflightDiagnosticsPreserveInputEvidenceAndAccess(t *testing.T) {
	disposable := testdb.New(t)
	db, ctx := disposable.Open(t), context.Background()
	identity, runtime := &identityStub{}, &runtimeStub{allowed: true}
	closed, output := 0, &observationOutput{}
	logger, err := observability.New(observability.Config{Output: output, ErrorCode: httpapi.ErrorCode, RecordError: httpapi.RecordError})
	if err != nil {
		t.Fatal(err)
	}
	deps := testDependencies(identity, &closed)
	deps.open = func(context.Context, string) (*pgxpool.Pool, error) { return db, nil }
	deps.ping = func(ctx context.Context, db *pgxpool.Pool) error { return db.Ping(ctx) }
	deps.migrate = database.Migrate
	deps.close = func(db *pgxpool.Pool) { closed++; db.Close() }
	deps.authorize = func(_ config.Config, verifier authorization.SessionVerifier) (*authorization.Service, error) {
		return authorization.New(runtime, "test-client", verifier), nil
	}
	deps.observers = Observability{Logger: logger}
	cfg := testConfig(t)
	cfg.DatabaseURL = disposable.URL()
	// testConfig covers bootstrap alone; the complete production runtime also
	// requires the media-engine path normally supplied by config.FromEnv.
	// Only registration is exercised, so neither process is launched here.
	cfg.FFprobePath, cfg.ChromiumSandboxMode = "ffprobe", "sandbox"
	// The legacy product.RegisterRoutes seam only mounts the original modules.
	// Diagnostics belong to the complete production runtime and must receive the
	// same observer as bootstrap, as cmd/api does. No gateway is invoked here.
	productRuntime, err := product.NewRuntime(cfg, gatewayapp.Unconfigured{}, logger)
	if err != nil {
		t.Fatal(err)
	}
	var runtimeInitErr error
	register := func(public, business chi.Router, pool *pgxpool.Pool, resources *core.Resources) error {
		runtimeInitErr = productRuntime.RegisterRuntimeRoutes(public, business, pool, resources)
		return runtimeInitErr
	}
	app, err := initializeRuntime(ctx, cfg, deps, []RuntimeRegistrar{register})
	if err != nil {
		t.Fatalf("preflight runtime fixture initialization: %v (bootstrap: %v)", runtimeInitErr, err)
	}
	t.Cleanup(app.Close)
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES
	 ('usr_test','preflight-a@example.test','','Caller'),('usr_other','preflight-b@example.test','','Owner');
	 INSERT INTO projects(id,owner_id,name) VALUES('project_test','usr_test','Own'),('project_shared','usr_other','Shared'),('project_private','usr_other','Private');
	 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('project_shared','usr_test','EDITOR','usr_other');`); err != nil {
		t.Fatal(err)
	}
	call := func(bearer, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("POST", "/api/v2/generation-diagnostics", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			r.Header.Set("Authorization", bearer)
		}
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("diagnostic returned %d, want %d: %s", w.Code, status, w.Body.String())
		}
		return w
	}
	legacy := `{"projectId":"project_test","nodeId":"node_target","errorCode":"MODEL_INPUT_UNSUPPORTED"}`
	context := `"preflight":{"schemaVersion":"1","capabilityRef":"h3-motion-transfer-v1","capabilityVersion":"2","requestedKind":"IMAGE_TO_VIDEO","inputKinds":["IMAGE","VIDEO"],"issues":[{"field":"media.durationMs","reason":"MAXIMUM_EXCEEDED","inputKind":"VIDEO","inputIndex":1,"sourceNodeId":"node_source","assetId":"ast_media","actual":55519,"maximum":30000}]}`
	full := strings.TrimSuffix(legacy, "}") + "," + context + "}"
	call("", full, 401)
	call("Bearer test-access", strings.Replace(full, "project_test", "project_private", 1), 404)
	call("Bearer test-access", legacy, 202) // pre-existing clients remain valid
	result := call("Bearer test-access", full, 202)
	var envelope struct {
		Data struct {
			LogID string `json:"logId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(result.Body.Bytes(), &envelope); err != nil || envelope.Data.LogID == "" {
		t.Fatal("missing trusted correlation", err)
	}
	call("Bearer test-access", strings.Replace(full, "project_test", "project_shared", 1), 202)
	if _, err := db.Exec(ctx, `UPDATE collaboration.project_members SET role='VIEWER' WHERE project_id='project_shared' AND user_id='usr_test'`); err != nil {
		t.Fatal(err)
	}
	call("Bearer test-access", strings.Replace(full, "project_test", "project_shared", 1), 403)
	for _, row := range []struct {
		name, body string
		status     int
	}{
		{"arbitrary message", strings.Replace(full, `"schemaVersion":"1"`, `"schemaVersion":"1","message":"private-prompt"`, 1), 400},
		{"unknown issue field", strings.Replace(full, `"field":"media.durationMs"`, `"field":"prompt"`, 1), 422},
		{"unknown component", strings.Replace(full, `"actual":55519`, `"actual":55519,"component":"private-prompt"`, 1), 422},
		{"arbitrary reason", strings.Replace(full, "MAXIMUM_EXCEEDED", "private-prompt", 1), 422},
		{"model URL", strings.Replace(full, "h3-motion-transfer-v1", "https://private.invalid/?token=value", 1), 422},
		{"negative measurement", strings.Replace(full, `"actual":55519`, `"actual":-1`, 1), 422},
		{"huge measurement", strings.Replace(full, `"actual":55519`, `"actual":9007199254740992`, 1), 422},
		{"negative index", strings.Replace(full, `"inputIndex":1`, `"inputIndex":-1`, 1), 422},
		{"unknown kind", strings.Replace(full, `"inputKind":"VIDEO"`, `"inputKind":"SECRET"`, 1), 422},
		{"duplicate kinds", strings.Replace(full, `["IMAGE","VIDEO"]`, `["IMAGE","IMAGE"]`, 1), 422},
		{"null issue", strings.TrimSuffix(legacy, "}") + `,"preflight":{"schemaVersion":"1","issues":[null]}}`, 422},
		{"unknown nested property", strings.Replace(full, `"actual":55519`, `"actual":55519,"url":"https://private.invalid"`, 1), 400},
		{"forged actor", strings.TrimSuffix(full, "}") + `,"actorId":"usr_other"}`, 400},
		{"oversized diagnostic", strings.Replace(full, "h3-motion-transfer-v1", strings.Repeat("a", 17000), 1), 413},
	} {
		t.Run(row.name, func(t *testing.T) { call("Bearer test-access", row.body, row.status) })
	}
	if strings.Count(output.String(), `"msg":"generation lifecycle"`) != 3 {
		t.Fatal("invalid or unauthorized diagnostic reached lifecycle logger", output.String())
	}
	for _, want := range []string{envelope.Data.LogID, `"actor_id":"usr_test"`, `"preflight_source":"client"`, `"capability_ref":"h3-motion-transfer-v1"`, `"capability_version":"2"`, `"actual":55519`, `"maximum":30000`, `"sourceNodeId":"node_source"`} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("lost metadata %q", want)
		}
	}
	for _, forbidden := range []string{"private-prompt", "https://private.invalid", `"actor_id":"usr_other"`} {
		if strings.Contains(output.String(), forbidden) {
			t.Fatalf("unsafe content retained %q", forbidden)
		}
	}
	consistent := `{"projectId":"project_test","nodeId":"node_target","errorCode":"STALE_EXECUTION_INPUT","preflight":{"schemaVersion":"1","capabilityRef":"h3-video-reference-v1","capabilityVersion":"4","issues":[{"field":"inputs.command","reason":"COMMAND_MISMATCH","component":"PARAMETERS","sourceNodeId":"node_target"}]}}`
	call("Bearer test-access", consistent, 202)
	for _, want := range []string{`"component":"PARAMETERS"`, `"field":"inputs.command"`, `"capability_version":"4"`} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("lost consistency diagnosis %s", want)
		}
	}
	snapshot := `"clientSnapshot":{"schemaVersion":"1","phase":"READINESS","control":"RETRY","click":{"visible":true,"disabled":false},"targetType":"NODE","nodeCount":2,"edgeCount":1,"incoming":1,"outgoing":0,"children":0,"target":1,"nodes":[{"index":0,"kind":"rh-image","outputs":1,"sources":0,"presets":0},{"index":1,"kind":"rh-image","portraitResult":true,"draggable":false,"selected":true,"x":32,"y":48,"outputs":1,"sources":0,"presets":1}],"dom":{"host":true,"selected":true,"busyOverlay":true,"cancelVisible":true,"generateVisible":false,"readOnly":false},"projection":{"mountedTarget":true,"commandTarget":true,"mountedMaxConnect":"ALL_NULL","commandMaxConnect":"ABSENT","mountedInputs":1,"commandInputs":1,"addedSources":0,"removedSources":0,"orderChanged":false},"links":[{"source":0,"target":1}]}`
	withSnapshot := strings.TrimSuffix(full, "}") + "," + snapshot + "}"
	call("Bearer test-access", withSnapshot, 202)
	call("Bearer test-access", strings.Replace(withSnapshot, "project_test", "project_private", 1), 404)
	call("Bearer test-access", strings.Replace(withSnapshot, `"kind":"rh-image"`, `"kind":"rh-image","prompt":"PRIVATE_SNAPSHOT"`, 1), 400)
	call("Bearer test-access", strings.Replace(withSnapshot, `"kind":"rh-image"`, `"kind":"https://private.invalid/signed"`, 1), 422)
	call("Bearer test-access", strings.Replace(withSnapshot, `"source":0`, `"source":99`, 1), 422)
	call("Bearer test-access", strings.Replace(withSnapshot, `"host":true`, `"host":true,"html":"PRIVATE_SNAPSHOT"`, 1), 400)
	call("Bearer test-access", strings.Replace(withSnapshot, "ALL_NULL", "PRIVATE_SNAPSHOT", 1), 422)
	call("Bearer test-access", strings.Replace(withSnapshot, `"phase":"READINESS"`, `"phase":"PRIVATE_SNAPSHOT"`, 1), 422)
	// Submit an invalid command to the real HTTP generation route, then attach
	// browser evidence to that server-generated ID through the diagnostic route.
	backend := httptest.NewRecorder()
	attempted := httptest.NewRequest("POST", "/api/v2/canvas-runs", strings.NewReader(`{"projectId":"project_test","targetId":"missing","bogus":true}`))
	attempted.Header.Set("Authorization", "Bearer test-access")
	attempted.Header.Set("Content-Type", "application/json")
	attempted.Header.Set("Idempotency-Key", "snapshot-http-correlation")
	app.Handler().ServeHTTP(backend, attempted)
	var original struct {
		RequestID string `json:"requestId"`
	}
	if backend.Code < 400 || backend.Code >= 500 || json.Unmarshal(backend.Body.Bytes(), &original) != nil || original.RequestID == "" {
		t.Fatal("missing HTTP rejection and request ID", backend.Code, backend.Body.String())
	}
	related := strings.TrimSuffix(strings.Replace(withSnapshot, `"phase":"READINESS"`, `"phase":"SUBMIT"`, 1), "}") + `,"relatedRequestId":"` + original.RequestID + `"}`
	receipt := call("Bearer test-access", related, 202)
	var joined struct {
		Data struct {
			LogID string `json:"logId"`
		} `json:"data"`
	}
	if json.Unmarshal(receipt.Body.Bytes(), &joined) != nil || joined.Data.LogID == "" || joined.Data.LogID == original.RequestID {
		t.Fatal("diagnostic must keep its own trusted ID")
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(output.String(), "\n") {
		var event struct {
			LogID    string                        `json:"log_id"`
			Stage    string                        `json:"stage"`
			Related  string                        `json:"related_request_id"`
			Snapshot *observability.ClientSnapshot `json:"client_snapshot"`
		}
		if json.Unmarshal([]byte(line), &event) != nil || event.Snapshot == nil {
			continue
		}
		if !event.Snapshot.Valid() || !event.Snapshot.Nodes[1].PortraitResult || event.Snapshot.Click == nil || !event.Snapshot.Click.Visible || event.Snapshot.Click.Disabled || event.Snapshot.Dom == nil || event.Snapshot.Dom.BusyOverlay == nil || !*event.Snapshot.Dom.BusyOverlay || event.Snapshot.Projection == nil || event.Snapshot.Projection.CommandMaxConnect != "ABSENT" {
			t.Fatal("invalid persisted browser facts")
		}
		if event.Stage == "CLIENT_SUBMISSION_SNAPSHOT" && (event.LogID != joined.Data.LogID || event.Related != original.RequestID) {
			t.Fatal("supplement linked to wrong receipt")
		}
		seen[event.Stage] = true
	}
	if len(seen) != 2 || !seen["CLIENT_PREFLIGHT"] || !seen["CLIENT_SUBMISSION_SNAPSHOT"] || strings.Contains(output.String(), "PRIVATE_SNAPSHOT") {
		t.Fatal("missing or unsafe client snapshots")
	}
	var tasks int
	if err := db.QueryRow(ctx, "SELECT count(*) FROM execution.tasks").Scan(&tasks); err != nil || tasks != 0 {
		t.Fatal("diagnostic submitted generation work", err, tasks)
	}
	runtime.allowed, identity.sessionID = false, "ses_preflight_denied"
	call("Bearer test-access", full, 403)
}
