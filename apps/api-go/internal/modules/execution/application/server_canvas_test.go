package application

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"testing"
)

type serverCanvasFixture struct {
	*promptTestStore
	raw       json.RawMessage
	rev       int64
	hash, key string
	readCount int
}

func (f *serverCanvasFixture) CanvasSnapshot(context.Context, string, string) (json.RawMessage, int64, error) {
	f.readCount++
	return f.raw, f.rev, nil
}
func (f *serverCanvasFixture) CanvasReceipt(_ context.Context, owner, key, hash string) (domain.Task, bool, error) {
	if f.key == "" || f.key != key {
		return domain.Task{}, false, nil
	}
	if f.hash != hash {
		return domain.Task{}, false, domain.ErrConflict
	}
	return f.task, true, nil
}
func (f *serverCanvasFixture) Create(_ context.Context, t domain.Task, key, hash string, _ []Grant) (domain.Task, error) {
	f.key, f.hash, f.task = key, hash, t
	f.creates++
	f.rev++
	return t, nil
}
func TestServerCanvasFreezesPersistedInputsAndReplaysBeforeChangedSnapshot(t *testing.T) {
	s, store, _ := promptTestService(t, "LLM")
	f := &serverCanvasFixture{promptTestStore: store, rev: 5, raw: json.RawMessage(`{"nodes":[{"id":"target","type":"rh-text","data":{"params":{"prompt":"server input"}}}],"edges":[]}`)}
	s.store = f
	cmd := ServerCanvasCommand{}
	cmd.Target.Type = "NODE"
	cmd.Target.ID = "target"
	key := uuid.NewString()
	got, err := s.ServerCanvas(context.Background(), "owner", "project", key, 5, cmd)
	if err != nil || got.ExpectedRevision == nil || *got.ExpectedRevision != 5 {
		t.Fatal(got, err)
	}
	f.raw = json.RawMessage(`{"nodes":[],"edges":[]}`)
	replay, err := s.ServerCanvas(context.Background(), "owner", "project", key, 5, cmd)
	if err != nil || replay.ID != got.ID || f.creates != 1 || f.readCount != 1 {
		t.Fatal("replay read changed graph or recreated", err)
	}
	if _, err = s.ServerCanvas(context.Background(), "owner", "project", key, 6, cmd); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("reused key changed CAS", err)
	}
	if _, err = s.ServerCanvas(context.Background(), "owner", "project", uuid.NewString(), 4, cmd); err == nil {
		t.Fatal("stale revision accepted")
	}
}
func TestServerCanvasClosureKeepsOrderedInputsAndExcludesUnrelatedLargeGraph(t *testing.T) {
	nodes := []any{map[string]any{"id": "source", "type": "rh-text", "data": map[string]any{"text": "source"}}, map[string]any{"id": "target", "type": "rh-image", "data": map[string]any{"params": map[string]any{"prompt": "target"}}}}
	for i := 0; i < 2000; i++ {
		nodes = append(nodes, map[string]any{"id": fmt.Sprint("unrelated", i), "type": "rh-text", "data": map[string]any{}})
	}
	raw, _ := json.Marshal(map[string]any{"nodes": nodes, "edges": []any{map[string]any{"id": "e", "source": "source", "target": "target", "sourceHandle": nil, "targetHandle": nil}}})
	frozen, err := serverInputClosure(raw, "target")
	if err != nil {
		t.Fatal(err)
	}
	a, _, err := domain.CanvasGuard(raw, "target")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := domain.CanvasGuard(frozen, "target")
	if err != nil || a != b {
		t.Fatal("closure changed trusted guard", err)
	}
	if _, _, _, err = domain.ParseGraph(domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "target", Graph: frozen}); err != nil {
		t.Fatal(err)
	}
	if _, err = serverInputClosure(raw, "missing"); err == nil {
		t.Fatal("missing target")
	}
}
func TestAgentPromptIsVersionedWithoutChangingLegacyChat(t *testing.T) {
	old, _ := assistantTemplate("CANVAS")
	before := old.spec()
	agent := AgentCanvasPromptSpec()
	after := old.spec()
	if before.TemplateSHA256 != after.TemplateSHA256 || agent.TemplateVersion == before.TemplateVersion || agent.TemplateSHA256 == before.TemplateSHA256 || agent.Instructions[0] != before.Instructions[0] {
		t.Fatal("agent template changed old feature or lost product instruction")
	}
}
