package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	canvasHTTP "studiotv.local/service/api/internal/modules/canvasagent/adapters/http"
	canvasPG "studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	"studiotv.local/service/api/internal/testdb"
)

func TestPostgresCanvasContextOwnershipDeletionAndInternalKinds(t *testing.T) {
	pool := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('context_a','context_a@example.test','A'),('context_b','context_b@example.test','B')`); err != nil {
		t.Fatal(err)
	}
	graph := json.RawMessage(`{"nodes":[{"id":"rhtv_meta_v1","type":"__rhtv_meta","data":{"version":"1","meta":{"ownerId":"hidden-owner"}}},{"id":"stored_text","type":"rh-text","position":{"x":1,"y":2},"data":{"text":"真正已保存文本","params":{"prompt":"保存的提示词"},"previewUrl":"https://private.invalid?token=hidden-token","taskId":"hidden-task"}}],"edges":[]}`)
	for _, item := range []struct {
		id, owner string
		kind      *string
	}{{"context_project_a", "context_a", nil}, {"context_project_b", "context_b", nil}, {"context_vault", "context_a", contextKind("ASSET_VAULT")}, {"context_studio", "context_a", contextKind("STUDIO_ASSETS")}} {
		if _, err := pool.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,graph,internal_kind,revision)VALUES($1,$2,'Context integration',$3,$4,7)`, item.id, item.owner, graph, item.kind); err != nil {
			t.Fatal(err)
		}
	}
	service, err := application.New(canvasPG.New(pool))
	if err != nil {
		t.Fatal(err)
	}
	value, err := service.Read(ctx, "context_a", "context_project_a")
	if err != nil || value.ProjectID != "context_project_a" || value.GraphRevision != 7 || len(value.Nodes) != 1 || value.Nodes[0].Text != "真正已保存文本" || value.Nodes[0].Prompt != "保存的提示词" || value.ToolExecutionAvailable {
		t.Fatal("authoritative context missing", value, err)
	}
	body, _ := json.Marshal(value)
	for _, private := range []string{"hidden-owner", "hidden-task", "hidden-token", "previewUrl"} {
		if strings.Contains(string(body), private) {
			t.Fatal("context leaked stored private field", private)
		}
	}
	for _, denied := range []struct{ owner, project string }{{"context_b", "context_project_a"}, {"context_a", "context_project_b"}, {"context_a", "context_vault"}, {"context_a", "context_studio"}} {
		if _, err := service.Read(ctx, denied.owner, denied.project); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("cross-owner/internal snapshot admitted", denied, err)
		}
	}
	// Exercise transport owner claims against the real repository: parameters
	// and headers cannot substitute for the verified identity supplied by auth.
	router := chi.NewRouter()
	if err := canvasHTTP.RegisterRoutes(router, service, func(cap string, next httpapi.Handler) http.HandlerFunc {
		if cap != "tv.access" {
			t.Fatal(cap)
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: "context_b"}))
		})
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v2/projects/context_project_a/agent-context", "/api/v2/projects/context_project_a/agent-context?ownerId=context_a"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("X-Owner-Id", "context_a")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		want := 404
		if strings.Contains(path, "?") {
			want = 400
		}
		if w.Code != want {
			t.Fatal("browser authority claim accepted", w.Code, w.Body.String())
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE public.projects SET deleted_at=now(),revision=revision+1 WHERE id='context_project_a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Read(ctx, "context_a", "context_project_a"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted project context admitted", err)
	}
}

func contextKind(value string) *string { return &value }
