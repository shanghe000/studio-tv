package postgres_test

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	"testing"
)

func TestPostgresCapabilityCommandExactTupleAndOfflineReplay(t *testing.T) {
	db, ctx := isolatedCommandDatabase(t)
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('owner-a','selection@example.test','A'); INSERT INTO public.projects(id,owner_id,name,graph)VALUES('project_a','owner-a','A','{"nodes":[{"id":"text","type":"rh-text","position":{"x":0,"y":0},"data":{"params":{"prompt":"keep"}}}],"edges":[]}')`); err != nil {
		t.Fatal(err)
	}
	service, err := application.NewCommandService(postgres.NewCommandUnitOfWork(db), core.ValidateProductGraph)
	if err != nil {
		t.Fatal(err)
	}
	lookups := 0
	service.WithCapabilityResolver(func(_ context.Context, _ string, c *domain.CommandCapability) error {
		lookups++
		c.Kind = "LLM"
		c.ParameterSchemaVersion = "2"
		return nil
	})
	raw := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.selectCapability","nodeId":"text","capabilityRef":"text-v1","capabilityVersion":"2","parameters":{"reasoningEffort":"high"}}]}`)
	key := uuid.NewString()
	got, err := service.Submit(ctx, "owner-a", "project_a", 1, key, raw)
	if err != nil {
		t.Fatal(err)
	}
	service.WithCapabilityResolver(nil)
	again, err := service.Submit(ctx, "owner-a", "project_a", 1, key, raw)
	if err != nil || again.CommandID != got.CommandID || lookups != 1 {
		t.Fatal("replay contacted unavailable model", err)
	}
	var data []byte
	if err = db.QueryRow(ctx, `SELECT graph->'nodes'->0->'data' FROM public.projects WHERE id='project_a'`).Scan(&data); err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	_ = json.Unmarshal(data, &v)
	if v["capabilityVersion"] != "2" || v["parameterSchemaVersion"] != "2" || v["params"].(map[string]any)["prompt"] != "keep" {
		t.Fatal("exact model tuple missing", string(data))
	}
}
