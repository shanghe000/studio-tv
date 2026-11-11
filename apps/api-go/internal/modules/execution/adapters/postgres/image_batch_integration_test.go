package postgres_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

const imageBatchGraph = `{"nodes":[{"id":"target","type":"rh-image","position":{"x":100,"y":100},"data":{"prompt":"original","generateNum":2}}],"edges":[]}`

func TestPostgresImageBatchAtomicNodesReplayAndDownstreamInput(t *testing.T) {
	for _, state := range []string{"SUCCEEDED", "FAILED", "CANCELED"} {
		t.Run(state, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			revision := setManagedGraph(t, f, imageBatchGraph)
			task := managedTask(t, f, imageBatchGraph, revision)
			p := &task.Plans[0]
			p.CapabilityRef = "codex-image-generate-v1"
			p.CapabilityVersion = "2"
			p.NodeSnapshot = json.RawMessage(`{"id":"target","type":"rh-image","data":{}}`)
			old, newer := "input-old-image", "input-new-image"
			p.Outputs = []domain.Output{{ID: "batch-first", Type: "ASSET", AssetID: &old, MimeType: "image/png", TestMode: true}, {ID: "batch-second", Type: "ASSET", AssetID: &newer, MimeType: "image/png", TestMode: true}}
			p.State = state
			task.State = state
			if state != "SUCCEEDED" {
				code := "CODEX_IMAGE_BATCH_INCOMPLETE"
				p.ErrorCode = &code
				task.ErrorCode = &code
			}
			const lease = "05764324-02f4-4125-9501-4b441fce3f18"
			if ok, err := f.store.Save(f.ctx, task, lease); err != nil || !ok {
				t.Fatal(ok, err)
			}
			got, err := f.store.Get(f.ctx, task.OwnerID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Plans[0].CanvasBinding.ApplicationState != "APPLIED" || got.State != state || len(got.Plans[0].Outputs) != 2 {
				t.Fatal("batch not atomically persisted", got.Plans[0].CanvasBinding, err)
			}
			raw, rev := currentManagedGraph(t, f)
			var g struct {
				Nodes []map[string]any `json:"nodes"`
				Edges []any            `json:"edges"`
			}
			if err = json.Unmarshal([]byte(raw), &g); err != nil {
				t.Fatal(err)
			}
			want := 2
			if state != "SUCCEEDED" {
				want = 3
			}
			if len(g.Nodes) != want {
				t.Fatalf("state %s expected %d nodes got %d", state, want, len(g.Nodes))
			}
			last := g.Nodes[len(g.Nodes)-1]
			data := last["data"].(map[string]any)
			if data["imageUrl"] != "rhtv-asset:input-new-image" || len(data["output"].([]any)) != 1 || data["historyStorage"].(map[string]any)["historyId"] != nil {
				t.Fatal("child image/history wrong", data)
			}
			// A repeated terminal save must not append another set of image nodes.
			_, _ = f.store.Save(f.ctx, got, lease)
			replayed, replayedRev := currentManagedGraph(t, f)
			if replayed != raw || replayedRev != rev {
				t.Fatal("terminal replay duplicated or rewrote graph")
			}
			// Each independent asset node can feed a later generation and binds
			// only its own canonical asset, never the source node's entire batch.
			g.Nodes = append(g.Nodes, map[string]any{"id": "describe", "type": "rh-text", "data": map[string]any{"capabilityRef": "history-input-fixture", "prompt": "describe"}})
			g.Edges = []any{map[string]any{"source": last["id"], "target": "describe"}}
			graph, _ := json.Marshal(g)
			next, err := f.service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "describe", Graph: graph})
			if err != nil {
				t.Fatal("child cannot be used downstream", err)
			}
			if len(next.Plans[0].InputReferences) != 1 || next.Plans[0].InputReferences[0].AssetID != newer {
				t.Fatal("wrong image bound", next.Plans[0].InputReferences)
			}
			if state == "SUCCEEDED" {
				selected, err := f.store.ResolveHistoryInput(f.ctx, "input-owner", execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "target", OutputID: "batch-first"})
				if err != nil || selected.Output.AssetID == nil || *selected.Output.AssetID != old {
					t.Fatal("original node history lost", err)
				}
			}
		})
	}
}

func TestPostgresImageBatchChangedNodeDoesNotAppendResults(t *testing.T) {
	f := newHistoryInputFixture(t)
	rev := setManagedGraph(t, f, imageBatchGraph)
	task := managedTask(t, f, imageBatchGraph, rev)
	current, _ := currentManagedGraph(t, f)
	setManagedGraph(t, f, strings.Replace(current, "original", "changed", 1))
	p := &task.Plans[0]
	p.CapabilityRef = "codex-image-generate-v1"
	p.CapabilityVersion = "2"
	p.State = "SUCCEEDED"
	task.State = "SUCCEEDED"
	a, b := "input-old-image", "input-new-image"
	p.Outputs = []domain.Output{{ID: "first", Type: "ASSET", AssetID: &a, MimeType: "image/png"}, {ID: "second", Type: "ASSET", AssetID: &b, MimeType: "image/png"}}
	if ok, err := f.store.Save(f.ctx, task, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	got, err := f.store.Get(f.ctx, task.OwnerID, task.ID)
	if err != nil || got.Plans[0].CanvasBinding.ApplicationState != "DETACHED" {
		t.Fatal("changed node overwritten", err)
	}
	raw, _ := currentManagedGraph(t, f)
	var g struct{ Nodes []json.RawMessage }
	_ = json.Unmarshal([]byte(raw), &g)
	if len(g.Nodes) != 1 || !strings.Contains(raw, "changed") {
		t.Fatal("stale results were inserted")
	}
}

func TestPostgresComfyBatchAtomicReplayAndSelectedChildInput(t *testing.T) {
	for _, ref := range []string{"z-image-turbo-generate-v1", "flux2-klein4b-generate-v1"} {
		for _, count := range []int{1, 2, 4, 8} {
			t.Run(fmt.Sprintf("%s/%d", ref, count), func(t *testing.T) {
				f := newHistoryInputFixture(t)
				graph := strings.Replace(imageBatchGraph, `"generateNum":2`, fmt.Sprintf(`"generateNum":%d`, count), 1)
				revision := setManagedGraph(t, f, graph)
				task := managedTask(t, f, graph, revision)
				p := &task.Plans[0]
				p.CapabilityRef, p.CapabilityVersion, p.State = ref, "1", "SUCCEEDED"
				task.State = "SUCCEEDED"
				p.NodeSnapshot = json.RawMessage(`{"id":"target","type":"rh-image","data":{}}`)
				for i := 0; i < count; i++ {
					asset := fmt.Sprintf("comfy-batch-asset-%d", i)
					if _, err := f.pool.Exec(f.ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES($1,'input-owner','input-project','generated.png','IMAGE','image/png',4,repeat('c',64),'READY')`, asset); err != nil {
						t.Fatal(err)
					}
					p.Outputs = append(p.Outputs, domain.Output{ID: fmt.Sprintf("comfy-output-%d", i), Type: "ASSET", AssetID: &asset, MimeType: "image/png", TestMode: true})
				}
				const lease = "05764324-02f4-4125-9501-4b441fce3f18"
				if ok, err := f.store.Save(f.ctx, task, lease); err != nil || !ok {
					t.Fatal(ok, err)
				}
				got, err := f.store.Get(f.ctx, task.OwnerID, task.ID)
				if err != nil || got.Plans[0].CanvasBinding.ApplicationState != "APPLIED" || len(got.Plans[0].Outputs) != count {
					t.Fatal("batch did not atomically persist", err)
				}
				raw, rev := currentManagedGraph(t, f)
				var g struct {
					Nodes []map[string]any `json:"nodes"`
					Edges []any            `json:"edges"`
				}
				if err = json.Unmarshal([]byte(raw), &g); err != nil || len(g.Nodes) != count {
					t.Fatal("batch did not create one independent node per image", err, len(g.Nodes))
				}
				for _, node := range g.Nodes {
					if len(node["data"].(map[string]any)["output"].([]any)) != 1 {
						t.Fatal("a node exposed more than its selected image")
					}
				}
				_, _ = f.store.Save(f.ctx, got, lease)
				if replayed, replayRev := currentManagedGraph(t, f); replayed != raw || replayRev != rev {
					t.Fatal("replayed terminal receipt duplicated result nodes")
				}
				selected := g.Nodes[len(g.Nodes)-1]
				g.Nodes = append(g.Nodes, map[string]any{"id": "describe", "type": "rh-text", "data": map[string]any{"capabilityRef": "history-input-fixture", "prompt": "describe this selected image"}})
				g.Edges = []any{map[string]any{"source": selected["id"], "target": "describe"}}
				nextGraph, _ := json.Marshal(g)
				next, err := f.service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "describe", Graph: nextGraph})
				if err != nil || len(next.Plans[0].InputReferences) != 1 || next.Plans[0].InputReferences[0].AssetID != fmt.Sprintf("comfy-batch-asset-%d", count-1) {
					t.Fatal("selected child did not bind exactly its own asset", err)
				}
			})
		}
	}
}
