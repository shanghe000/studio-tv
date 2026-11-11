//go:build canvas_boundary_audit

package bootstrap

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/modelgateway/adapters/router"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/product"
	"studiotv.local/service/api/internal/testdb"
)

// Drive this opt-in listener using scripts/test-canvas-boundary.py. It uses the
// real product, operation store, authorization middleware, SQL worker, grant
// checks and signed HTTP transport. Upstream identity and outputs are fixtures.
// Never accepts an external gateway URL or a production database configuration.
func TestCanvasAuditHTTPBoundary(t *testing.T) {
	dir := os.Getenv("STUDIO_CANVAS_BOUNDARY_DIR")
	if dir == "" {
		t.Fatal("start this listener with scripts/test-canvas-boundary.py or scripts/test-canvas-media-boundary.py")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stage := testdb.New(t)
	db := stage.Open(t)
	var catalog []map[string]any
	raw, err := os.ReadFile("../../../../tests/web/fixtures/canvas-catalog-audit-20261104.json")
	if err != nil || json.Unmarshal(raw, &catalog) != nil {
		t.Fatal("cannot read pinned catalog", err)
	}
	byRef := map[string]map[string]any{}
	for _, row := range catalog {
		if row["model"] != nil && row["testMode"] == false {
			row["available"] = true
			delete(row, "reason")
		}
		byRef[row["capabilityRef"].(string)] = row
	}
	var manifest map[string]struct {
		Kind, Mime, Sha string
		Width, Height   int
		Duration        float64
		Size            int
	}
	raw, err = os.ReadFile(filepath.Join(dir, "assets.json"))
	if err != nil || json.Unmarshal(raw, &manifest) != nil {
		t.Fatal("cannot read synthetic media manifest", err)
	}
	key := []byte(strings.Repeat("x", 32))
	captures := []json.RawMessage{}
	receipts := map[string]gateway.Invocation{}
	var lock sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		digest := sha256.Sum256(body)
		canonical := strings.Join([]string{"models-router.actor.v1", r.Method, r.URL.RequestURI(), "studio-tv", "usr_test", r.Header.Get("X-Router-Actor-Timestamp"), r.Header.Get("X-Router-Actor-Nonce"), hex.EncodeToString(digest[:]), r.Header.Get("Idempotency-Key")}, "\n")
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(canonical))
		if r.Header.Get("X-Router-Subject-Ref") != "usr_test" || r.Header.Get("X-Router-Actor-Signature") != "v1="+base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) {
			http.Error(w, "invalid actor proof", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Models-Router-Version", "1")
		lock.Lock()
		defer lock.Unlock()
		switch {
		case r.URL.Path == "/v1/capabilities":
			rows := []map[string]any{}
			for _, row := range catalog {
				if kind := r.URL.Query().Get("kind"); kind == "" || kind == row["kind"] {
					rows = append(rows, row)
				}
			}
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			if limit < 1 {
				limit = 100
			}
			start, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
			end := min(start+limit, len(rows))
			var cursor any
			if end < len(rows) {
				cursor = strconv.Itoa(end)
			}
			json.NewEncoder(w).Encode(map[string]any{"protocolVersion": "1", "items": rows[start:end], "nextCursor": cursor})
		case r.URL.Path == "/extensions/capability-versions/v1/capability":
			row := byRef[r.URL.Query().Get("ref")]
			if row == nil || row["version"] != r.URL.Query().Get("version") {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(row)
		case r.Method == "POST" && r.URL.Path == "/v1/invocations":
			var req gateway.InvocationRequest
			if err := json.Unmarshal(body, &req); err != nil {
				http.Error(w, "invalid request", 400)
				return
			}
			row := byRef[req.Capability.Ref]
			if row == nil {
				http.NotFound(w, r)
				return
			}
			captures = append(captures, json.RawMessage(body))
			out, _ := json.Marshal(captures)
			tmp := filepath.Join(dir, "invocations.tmp")
			if err := os.WriteFile(tmp, out, 0600); err != nil {
				t.Error(err)
			} else if err = os.Rename(tmp, filepath.Join(dir, "invocations.json")); err != nil {
				t.Error(err)
			}
			now := time.Now().UTC()
			id := "inv_" + uuid.NewString()
			inv := gateway.Invocation{Ref: id, OperationRef: req.OperationRef, State: "SUCCEEDED", CreatedAt: now, UpdatedAt: now, OutputParts: []gateway.OutputPart{}, Artifacts: []gateway.Artifact{}}
			kind := row["outputKinds"].([]any)[0].(string)
			if kind == "IMAGE" || kind == "VIDEO" {
				m := manifest["a-"+strings.ToLower(kind)]
				art := "artifact_" + m.Sha
				expires := now.Add(time.Hour)
				inv.Artifacts = []gateway.Artifact{{Ref: art, OutputRef: "sample", Kind: &kind, SizeBytes: int64(m.Size), SHA256: m.Sha, MediaType: m.Mime, ExpiresAt: &expires}}
				inv.OutputParts = []gateway.OutputPart{{OutputRef: "sample", Type: "ARTIFACT", ArtifactRef: &art}}
			} else {
				txt := "Synthetic test output"
				inv.OutputParts = []gateway.OutputPart{{OutputRef: "sample", Type: "TEXT", Text: &txt}}
			}
			receipts[id] = inv
			w.WriteHeader(202)
			json.NewEncoder(w).Encode(inv)
		case strings.HasPrefix(r.URL.Path, "/v1/invocations/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/invocations/")
			if strings.HasSuffix(id, "/events") {
				json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "protocolVersion": "1", "terminal": true, "nextCursor": nil})
				return
			}
			if inv, ok := receipts[id]; ok {
				json.NewEncoder(w).Encode(inv)
			} else {
				http.NotFound(w, r)
			}
		case strings.HasPrefix(r.URL.Path, "/v1/artifacts/artifact_") && strings.HasSuffix(r.URL.Path, "/content"):
			sha := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/artifacts/artifact_"), "/content")
			for _, m := range manifest {
				if m.Sha == sha {
					b, err := os.ReadFile(filepath.Join(dir, "media", sha))
					if err != nil {
						t.Error(err)
						return
					}
					w.Header().Set("Content-Type", m.Mime)
					w.Write(b)
					return
				}
			}
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	client, err := router.New(router.Config{BaseURL: upstream.URL, ClientApp: "studio-tv", SigningKey: key, ServiceToken: strings.Repeat("t", 32)})
	if err != nil {
		t.Fatal(err)
	}
	closed := 0
	deps := testDependencies(&identityStub{}, &closed)
	deps.open = func(context.Context, string) (*pgxpool.Pool, error) { return db, nil }
	deps.ping = func(c context.Context, p *pgxpool.Pool) error { return p.Ping(c) }
	deps.migrate = database.Migrate
	deps.authorize = func(_ config.Config, v authorization.SessionVerifier) (*authorization.Service, error) {
		return authorization.New(&runtimeStub{allowed: true}, "test-client", v), nil
	}
	cfg := testConfig(t)
	cfg.DatabaseURL = stage.URL()
	cfg.FFprobePath = os.Getenv("STUDIO_TEST_FFPROBE")
	if cfg.FFprobePath == "" {
		cfg.FFprobePath = "ffprobe"
	}
	cfg.ModelRealExecutionEnabled = true
	cfg.ChromiumSandboxMode = "sandbox"
	rt, err := product.NewRuntime(cfg, client)
	if err != nil {
		t.Fatal(err)
	}
	app, err := initializeRuntime(ctx, cfg, deps, []RuntimeRegistrar{func(public, business chi.Router, p *pgxpool.Pool, r *core.Resources) error {
		e := rt.RegisterRuntimeRoutes(public, business, p, r)
		if e != nil {
			t.Log("runtime assembly:", e)
		}
		return e
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	_, err = db.Exec(ctx, "INSERT INTO users(id,email,display_name)VALUES('usr_test','canvas-audit@example.test','Audit'); INSERT INTO projects(id,owner_id,name)VALUES('p','usr_test','Canvas audit');")
	if err != nil {
		t.Fatal(err)
	}
	for id, m := range manifest {
		contents, e := os.ReadFile(filepath.Join(dir, "media", m.Sha))
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(cfg.StorageRoot, id), contents, 0600); e != nil {
			t.Fatal(e)
		}
		var duration any
		if m.Duration > 0 {
			duration = m.Duration
		}
		_, err = db.Exec(ctx, "INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,duration_seconds)VALUES($1,'usr_test','p',$1,$2,$3,$4,$5,'READY',NULLIF($6,0),NULLIF($7,0),$8)", id, m.Kind, m.Mime, m.Size, m.Sha, m.Width, m.Height, duration)
		if err != nil {
			t.Fatal(err)
		}
	}
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); rt.Run(ctx) }()
	defer func() { cancel(); <-workerDone }()
	srv := httptest.NewServer(app.Handler())
	defer srv.Close()
	if err = os.WriteFile(filepath.Join(dir, "origin"), []byte(srv.URL), 0600); err != nil {
		t.Fatal(err)
	}
	fmt.Println("isolated STUDIO canvas endpoint ready")
	for {
		if _, err := os.Stat(filepath.Join(dir, "finished")); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
	}
	lock.Lock()
	n := len(captures)
	lock.Unlock()
	if os.Getenv("STUDIO_CANVAS_BOUNDARY_MEDIA_ONLY") == "1" {
		var successes int
		if err := db.QueryRow(ctx, "SELECT count(*) FROM execution.tasks WHERE kind='MEDIA' AND state='SUCCEEDED'").Scan(&successes); err != nil || successes != 10 || n != 0 {
			t.Fatalf("expected ten completed media jobs and no generation invocations; got %d, %d, err=%v", successes, n, err)
		}
		return
	}
	if n == 0 {
		t.Fatal("finished without reaching the signed generation boundary")
	}
}
