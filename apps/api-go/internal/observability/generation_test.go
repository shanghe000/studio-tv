package observability

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"studiotv.local/service/api/internal/httpapi"
	"strings"
	"testing"
	"time"
)

func TestGenerationFilesCorrelationAlertsAndRedaction(t *testing.T) {
	var received []string
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		b, _ := json.Marshal(body)
		received = append(received, string(b))
		w.Write([]byte(`{"code":0}`))
	}))
	defer endpoint.Close()
	dir := t.TempDir()
	o, buf := testObserver(t, Config{LogDirectory: dir, WebhookURL: endpoint.URL})
	ctx := WithLogID(context.Background(), "00000000-0000-4000-8000-000000000001")
	lookups := 0
	o.SetActorNameResolver(func(ctx context.Context, id string) (string, error) {
		lookups++
		if id != "usr_actor" {
			t.Fatalf("unexpected initiator %q", id)
		}
		return "杨杰", nil
	})
	g := Generation{ActorID: "usr_actor", TaskID: "tsk_case", ProjectID: "prj_case", NodeID: "node_case", CapabilityRef: "codex-image-edit-v1", SceneCode: "canvas-image-quick-create-camera-motion-control-orbit", Stage: "ACCEPTED", State: "QUEUED", CreatedAt: time.Now()}
	o.Generation(ctx, g)
	if lookups != 0 {
		t.Fatal("ordinary lifecycle added a directory lookup")
	}
	g.Stage = "TASK_UPDATED"
	g.State = "FAILED"
	g.ErrorCode = "PROVIDER_FAILED"
	g.Notify = true
	o.Generation(WithLogID(context.Background(), TaskLogID(g.TaskID)), g)
	o.Generation(ctx, g)
	o.Logger().Error("generation secret test", "prompt", "secret-sentinel", "webhook_url", "secret-sentinel", "log_id", TaskLogID(g.TaskID))
	if e := o.Close(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(received) != 1 || !strings.Contains(received[0], TaskLogID(g.TaskID)) || !strings.Contains(received[0], g.SceneCode) {
		t.Fatal("missing correlated/deduplicated failure", len(received))
	}
	for _, want := range []string{"操作人：", "杨杰", "用户ID：", "usr_actor"} {
		if !strings.Contains(received[0], want) {
			t.Fatalf("notification missing %q", want)
		}
	}
	if o.Stats().Suppressed != 1 {
		t.Fatal(o.Stats())
	}
	for _, name := range []string{"api.log", "generation.log"} {
		path := filepath.Join(dir, name)
		if _, e := os.Readlink(path); e != nil {
			t.Fatal("daily link missing", e)
		}
		body, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		if !strings.Contains(string(body), TaskLogID(g.TaskID)) || strings.Contains(string(body), "secret-sentinel") {
			t.Fatal("lost correlation or secret leaked")
		}
		if !strings.Contains(string(body), `"actor_id":"usr_actor"`) || !strings.Contains(string(body), `"actor_name":"杨杰"`) {
			t.Fatal("actor missing from file log", name)
		}
	}
	if !strings.Contains(buf.String(), `"request_id":"00000000-0000-4000-8000-000000000001"`) {
		t.Fatal("HTTP-to-task link missing")
	}
}

func TestGenerationActorNameLookupFailureAndCanceledRequest(t *testing.T) {
	for _, mode := range []string{"canceled-request", "missing-user", "timeout", "unknown-actor"} {
		t.Run(mode, func(t *testing.T) {
			var received string
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body any
				_ = json.NewDecoder(r.Body).Decode(&body)
				raw, _ := json.Marshal(body)
				received = string(raw)
				w.Write([]byte(`{"code":0}`))
			}))
			defer endpoint.Close()
			o, buf := testObserver(t, Config{WebhookURL: endpoint.URL})
			o.SetActorNameResolver(func(ctx context.Context, id string) (string, error) {
				if mode == "unknown-actor" {
					t.Fatal("looked up an empty actor")
				}
				if ctx.Err() != nil {
					t.Fatal("inherited canceled request")
				}
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 250*time.Millisecond {
					t.Fatal("unbounded name lookup")
				}
				if mode == "timeout" {
					<-ctx.Done()
					return "", ctx.Err()
				}
				if mode == "missing-user" {
					return "", errors.New("private-db-error-sentinel")
				}
				return "  杨\n杰\u202e\x00  ", nil
			})
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			actor := "usr_actor"
			if mode == "unknown-actor" {
				actor = ""
			}
			o.Generation(ctx, Generation{ActorID: actor, TaskID: "tsk_failure", Stage: "TASK_UPDATED", State: "FAILED", ErrorCode: "COMFY_IMAGE_SIZE", Notify: true})
			if err := o.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			want := "姓名暂不可用"
			if mode == "canceled-request" {
				want = "杨 杰"
			} else if mode == "unknown-actor" {
				want = "未知操作人"
			}
			if !strings.Contains(received, want) || !strings.Contains(received, "COMFY_IMAGE_SIZE") || actor != "" && !strings.Contains(received, actor) {
				t.Fatal("lost actor fallback or original failure", received)
			}
			if strings.Contains(buf.String()+received, "private-db-error-sentinel") {
				t.Fatal("lookup error leaked")
			}
		})
	}
	if got := safeActorName(strings.Repeat("杨", 100)); len([]rune(got)) != 80 {
		t.Fatal("unbounded display name")
	}
}
func TestGenerationValidationRejectionNotifiesButOrdinary4xxDoesNot(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"code":0}`)) }))
	defer endpoint.Close()
	o, _ := testObserver(t, Config{WebhookURL: endpoint.URL, ErrorCode: httpapi.ErrorCode})
	r := chi.NewRouter()
	r.Use(httpapi.RequestContext, o.Middleware)
	h := httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
		return httpapi.Fail(422, "MODEL_UNAVAILABLE", "unavailable")
	})
	r.Post("/api/v2/canvas-runs", h)
	r.Post("/api/v2/projects", h)
	for _, p := range []string{"/api/v2/canvas-runs", "/api/v2/projects"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", p, nil))
	}
	o.Close(context.Background())
	if o.Stats().Sent != 1 {
		t.Fatal(o.Stats())
	}
}
func TestGenerationRouteCoverage(t *testing.T) {
	for _, p := range []string{"/api/v2/canvas-runs", "/api/v2/app-runs", "/api/v2/media-jobs", "/api/v2/projects/{projectId}/canvas-executions", "/api/v2/conversations/{cid}/runs", "/api/v2/assistant/conversations/{cid}/runs", "/api/v2/conversations/{id}/agent-runs", "/api/v2/studio/projects/{projectId}/render"} {
		if !generationRoute("POST", p) || generationRoute("GET", p) {
			t.Fatal(p)
		}
	}
}
