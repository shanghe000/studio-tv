package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studio.example.invalid/models-router/internal/adapters/h3"
	"studio.example.invalid/models-router/internal/adapters/studiomedia"
	"studio.example.invalid/models-router/internal/adapters/postgres"
	"studio.example.invalid/models-router/internal/application"
	"studio.example.invalid/models-router/internal/domain"
	"studio.example.invalid/models-router/migrations"
)

type ingressMedia struct{}

func (ingressMedia) ResolveMedia(_ context.Context, _ domain.Actor, a application.Attachment) (studiomedia.Media, error) {
	b, e := auditBytes(a)
	if e != nil {
		return studiomedia.Media{}, e
	}
	f, e := auditFacts(a)
	return studiomedia.Media{Bytes: b, MediaType: f.Mime, Width: f.Width, Height: f.Height, DurationMs: f.Duration}, e
}
func (m ingressMedia) ResolveSourceMotionVideo(ctx context.Context, a domain.Actor, r application.Attachment) (studiomedia.Media, error) {
	return m.ResolveMedia(ctx, a, r)
}

// The supplied DSN is only a database factory on the test machine. The Router
// performs migrations, validation, freezing, polling and dispatch in a fresh DB.
func routerIngressPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	text := os.Getenv("TEST_DATABASE_URL")
	if text == "" {
		t.Fatal("a disposable local TEST_DATABASE_URL is required")
	}
	cfg, err := pgxpool.ParseConfig(text)
	if err != nil {
		t.Fatal("invalid database factory")
	}
	host := cfg.ConnConfig.Host
	if host != "127.0.0.1" && host != "localhost" && host != "::1" && !strings.HasPrefix(host, "/") {
		t.Fatal("database factory must be local")
	}
	factory, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("database factory unavailable")
	}
	suffix := make([]byte, 10)
	if _, err = rand.Read(suffix); err != nil {
		t.Fatal(err)
	}
	name := "studiotv_router_audit_" + hex.EncodeToString(suffix)
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err = factory.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		factory.Close()
		t.Fatal("cannot create disposable database", err)
	}
	t.Cleanup(func() {
		defer factory.Close()
		if _, err := factory.Exec(context.Background(), "DROP DATABASE "+quoted+" WITH (FORCE)"); err != nil {
			t.Error("cannot drop disposable test database", err)
		}
	})
	isolated := cfg.Copy()
	isolated.ConnConfig.Database = name
	db, err := pgxpool.NewWithConfig(ctx, isolated)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = migrations.Apply(ctx, db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestCanvasAuditIngress(t *testing.T) {
	raw, err := os.ReadFile(os.Getenv("STUDIO_CANVAS_ROUTER_REQUESTS"))
	if err != nil {
		t.Fatal(err)
	}
	var captures []json.RawMessage
	if err = json.Unmarshal(raw, &captures); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile("../../../config/production-profile-snapshots/comfy-profiles-20261102-motion-moss.json")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := h3.ParseManifest(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"qwen-image-edit-2511-v1", "h3-first-last-frame-v1", "h3-motion-transfer-v1", "seedance-2-5-official-first-frame-v1", "codex-6-1-text-v1"} {
		t.Run(ref, func(t *testing.T) {
			var body json.RawMessage
			var r application.InvocationRequest
			for _, row := range captures {
				var item application.InvocationRequest
				if err := json.Unmarshal(row, &item); err != nil {
					t.Fatal(err)
				}
				if item.Capability.Ref == ref {
					body = row
					r = item
					break
				}
			}
			if len(body) == 0 {
				t.Fatal("missing STUDIO capture for " + ref)
			}
			var profile h3.ManifestProfile
			for _, pr := range manifest.Profiles {
				if pr.CapabilityRef == ref {
					profile = pr
					break
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			pool := routerIngressPool(t, ctx)
			submitCount := 0
			seen := map[string]bool{}
			native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
				if q.Method != "POST" {
					http.Error(w, "unexpected method", 400)
					return
				}
				switch q.URL.Path {
				case "/v1/media":
					data, _ := io.ReadAll(q.Body)
					seen[auditSHA(data)] = true
					json.NewEncoder(w).Encode(map[string]string{"media_id": fmt.Sprintf("30000000-0000-4000-8000-%012d", len(seen))})
				case "/v1/jobs":
					var c struct {
						ProfileID string `json:"profile_id"`
						RequestID string `json:"request_id"`
						Prompt    string `json:"prompt"`
						Preset    string `json:"output_preset"`
					}
					if err := json.NewDecoder(q.Body).Decode(&c); err != nil || c.ProfileID != profile.ProfileID || c.RequestID == "" {
						t.Error("native job identity changed")
					}
					if raw := r.Parameters["outputPreset"]; raw != nil {
						var want string
						json.Unmarshal(raw, &want)
						if want != c.Preset {
							t.Error("native output preset changed")
						}
					}
					if profile.Motion == nil || profile.Motion.PromptPolicy != "ignored" {
						auditUserText(t, r, c.Prompt)
					}
					for _, a := range r.Attachments {
						if !seen[a.SHA256] {
							t.Error("missing STUDIO asset bytes")
						}
					}
					submitCount++
					json.NewEncoder(w).Encode(map[string]any{"job_id": "10000000-0000-4000-8000-000000000001", "profile_id": c.ProfileID, "request_id": c.RequestID, "status": "RUNNING", "outputs": []any{}})
				default:
					http.Error(w, "unexpected path", 400)
				}
			}))
			defer native.Close()
			store := postgres.New(pool)
			adapter, err := h3.NewWithManifest(h3.Config{Origin: native.URL, Token: strings.Repeat("a", 32)}, postgres.NewH3Store(pool), ingressMedia{}, manifest)
			if err != nil {
				t.Fatal(err)
			}
			defer adapter.Close()
			var dispatch application.Executor = adapter
			expectedState := domain.Running
			if ref == "seedance-2-5-official-first-frame-v1" {
				dispatch = officialIngress(t, ctx, pool, r, &submitCount)
			}
			if ref == "codex-6-1-text-v1" {
				dispatch = codexIngress(t, pool, r, &submitCount)
				expectedState = domain.Succeeded
			}
			service := application.NewWithExecution(store, store, dispatch)
			ingress := httptest.NewServer(New(service, &Authenticator{Credentials: []Credential{testCredential}, Nonces: store}, store))
			defer ingress.Close()
			origin, _ := url.Parse(ingress.URL)
			send := func(method, path string, data []byte, key string) (int, domain.Invocation) {
				q := signed(method, path, "studio-canvas-audit", data)
				if key != "" {
					q.Header.Set("Idempotency-Key", key)
				}
				resign(q, data)
				q.URL.Scheme = origin.Scheme
				q.URL.Host = origin.Host
				q.Host = origin.Host
				q.RequestURI = ""
				q.Body = io.NopCloser(bytes.NewReader(data))
				res, err := ingress.Client().Do(q)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				var inv domain.Invocation
				b, _ := io.ReadAll(res.Body)
				if res.StatusCode/100 != 2 {
					t.Fatalf("HTTP %s rejected STUDIO capture: %d %s", method, res.StatusCode, b)
				}
				if err = json.Unmarshal(b, &inv); err != nil {
					t.Fatal(err)
				}
				return res.StatusCode, inv
			}
			code, inv := send("POST", "/v1/invocations", body, r.OperationRef)
			if code != 202 || inv.State != domain.Queued || inv.TestMode {
				t.Fatal("no immutable queued receipt")
			}
			if did, err := service.ProcessNext(ctx); err != nil || !did || submitCount != 1 {
				t.Fatalf("worker dispatch: processed=%v native-posts=%d err=%v", did, submitCount, err)
			}
			code, record := send("GET", "/v1/invocations/"+inv.Ref, nil, "")
			if code != 200 || record.Ref != inv.Ref || record.State != expectedState {
				t.Fatal("native acknowledgement not reflected in Router receipt")
			}
		})
	}
}
