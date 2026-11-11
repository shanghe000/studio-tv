package postgres

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

func batchFixture(count int, state string) (json.RawMessage, domain.Plan) {
	p := domain.Plan{NodeID: "target", ExecutionID: "execution", CapabilityRef: "codex-image-generate-v1", CapabilityVersion: "2", State: state}
	for i := 0; i < count; i++ {
		a := fmt.Sprintf("asset_%d", i)
		p.Outputs = append(p.Outputs, domain.Output{ID: fmt.Sprintf("output_%d", i), Type: "ASSET", AssetID: &a, MimeType: "image/png"})
	}
	return json.RawMessage(`{"nodes":[{"id":"target","type":"rh-image","parentNode":"group","position":{"x":100,"y":50},"data":{"title":"图形","status":"finished","taskId":"task","params":{"prompt":"unchanged"},"historyStorage":{"historyId":"execution","resultCount":4},"selectedOutputHistoryId":"old","selectedOutputHistoryIndex":3}},{"id":"neighbor","type":"rh-image","parentNode":"group","position":{"x":484,"y":50},"data":{"label":"do not touch","seed":9007199254740993}}],"edges":[{"source":"target","target":"neighbor"}],"viewport":{"x":10,"zoom":0.8}}`), p
}

func decodeBatch(t *testing.T, raw json.RawMessage) []map[string]any {
	t.Helper()
	var g struct{ Nodes []map[string]any }
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g.Nodes
}

func TestImageBatchEachImageHasIndependentNode(t *testing.T) {
	for _, version := range []string{"2", "3"} {
		for _, count := range []int{1, 2, 4} {
			t.Run(version+"/"+fmt.Sprint(count), func(t *testing.T) {
				raw, p := batchFixture(count, "SUCCEEDED")
				p.CapabilityVersion = version
				next, why, err := projectImageBatch(raw, "task", p, false)
				if err != nil || why != "" {
					t.Fatal(why, err)
				}
				nodes := decodeBatch(t, next)
				if len(nodes) != count+1 {
					t.Fatalf("got %d nodes for %d images", len(nodes), count)
				}
				first := nodes[0]["data"].(map[string]any)
				if first["selectedHistoryOutputId"] != "output_0" || len(first["output"].([]any)) != 1 || first["imageUrl"] != "rhtv-asset:asset_0" {
					t.Fatal(first)
				}
				if first["selectedOutputHistoryId"] != nil || first["selectedOutputHistoryIndex"] != float64(0) {
					t.Fatal("stale history selector", first)
				}
				for i := 1; i < count; i++ {
					n := nodes[i+1]
					d := n["data"].(map[string]any)
					if n["id"] != imageBatchNodeID("task", "execution", fmt.Sprintf("output_%d", i)) || n["parentNode"] != "group" {
						t.Fatal(n)
					}
					if len(d["output"].([]any)) != 1 || d["imageUrl"] != fmt.Sprintf("rhtv-asset:asset_%d", i) || d["testMode"] != false {
						t.Fatal(d)
					}
					for _, key := range []string{"taskId", "selectedHistoryOutputId", "selectedOutputHistoryId", "selectedOutputHistoryIndex"} {
						if _, ok := d[key]; ok {
							t.Fatal("child inherited execution/history authority", key)
						}
					}
					storage := d["historyStorage"].(map[string]any)
					if storage["historyId"] != nil || storage["source"] != nil || storage["imageBatchOrigin"] == nil {
						t.Fatal("child provenance confused with history authority", storage)
					}
					if len(d["params"].(map[string]any)) != 0 {
						t.Fatal("child retained source generation inputs")
					}
					pos := n["position"].(map[string]any)
					if pos["x"] == float64(484) && pos["y"] == float64(50) {
						t.Fatal("overlaps neighbor")
					}
				}
				if !strings.Contains(string(next), `9007199254740993`) || !strings.Contains(string(next), `"source":"target"`) {
					t.Fatal("unrelated graph data changed")
				}
				repeat, rwhy, rerr := projectImageBatch(raw, "task", p, false)
				if rerr != nil || rwhy != "" || string(repeat) != string(next) {
					t.Fatal("projection is not deterministic")
				}
			})
		}
	}
}

func TestImageBatchPartialKeepsFailureAndPublishesOnlyRealImages(t *testing.T) {
	for _, state := range []string{"FAILED", "CANCELED"} {
		t.Run(state, func(t *testing.T) {
			raw, p := batchFixture(2, state)
			raw, _ = patchCanvasNode(raw, "target", map[string]any{"status": "failed", "errorMsg": "BATCH_INCOMPLETE"})
			next, why, err := projectImageBatch(raw, "task", p, true)
			if err != nil || why != "" {
				t.Fatal(why, err)
			}
			nodes := decodeBatch(t, next)
			if len(nodes) != 4 || nodes[0]["data"].(map[string]any)["status"] != "failed" {
				t.Fatal("partial batch pretended success", nodes)
			}
			for _, n := range nodes[2:] {
				d := n["data"].(map[string]any)
				if d["testMode"] != true || d["status"] != "finished" || len(d["output"].([]any)) != 1 {
					t.Fatal(d)
				}
			}
		})
	}
}

func TestImageBatchCollisionLimitsAndLegacyAreAtomic(t *testing.T) {
	raw, p := batchFixture(2, "SUCCEEDED")
	p.CapabilityVersion = "1"
	next, why, err := projectImageBatch(raw, "task", p, false)
	if err != nil || why != "" || string(next) != string(raw) {
		t.Fatal("v1 receipt reinterpreted")
	}
	p.CapabilityVersion = "2"
	var g map[string]any
	_ = json.Unmarshal(raw, &g)
	nodes := g["nodes"].([]any)
	for len(nodes) < 500 {
		nodes = append(nodes, map[string]any{"id": fmt.Sprintf("extra-%d", len(nodes)), "type": "rh-text", "data": map[string]any{}})
	}
	g["nodes"] = nodes
	large, _ := json.Marshal(g)
	next, why, err = projectImageBatch(large, "task", p, false)
	if err != nil || why != "RESULT_NODE_LIMIT" || next != nil {
		t.Fatal("node limit allowed partial graph", why, err)
	}
	projected, _, _ := projectImageBatch(raw, "task", p, false)
	next, why, err = projectImageBatch(projected, "task", p, false)
	if err != nil || why != "RESULT_NODE_CONFLICT" || next != nil {
		t.Fatal("overwrote existing child", why, err)
	}
	p.Outputs[1].ID = p.Outputs[0].ID
	next, why, err = projectImageBatch(raw, "task", p, false)
	if err != nil || why != "OUTPUT_UNAVAILABLE" || next != nil {
		t.Fatal("duplicate output accepted", why, err)
	}
}

func TestComfyImageBatchSuccessOnlyAndBoundedIndependentNodes(t *testing.T) {
	for _, ref := range []string{"z-image-turbo-generate-v1", "flux2-klein4b-generate-v1"} {
		for _, count := range []int{1, 2, 4, 8} {
			raw, p := batchFixture(count, "SUCCEEDED")
			p.CapabilityRef, p.CapabilityVersion = ref, "1"
			next, why, err := projectImageBatch(raw, "task", p, false)
			if err != nil || why != "" {
				t.Fatal(ref, count, why, err)
			}
			nodes := decodeBatch(t, next)
			if len(nodes) != count+1 || len(nodes[0]["data"].(map[string]any)["output"].([]any)) != 1 {
				t.Fatal("batch did not have one image per independent node", ref, count)
			}
			for i := 1; i < count; i++ {
				d := nodes[i+1]["data"].(map[string]any)
				if len(d["output"].([]any)) != 1 || d["imageUrl"] != fmt.Sprintf("rhtv-asset:asset_%d", i) || d["historyStorage"].(map[string]any)["historyId"] != nil {
					t.Fatal("child image/provenance invalid", d)
				}
			}
		}
		for _, state := range []string{"RUNNING", "FAILED", "CANCELED"} {
			raw, p := batchFixture(2, state)
			p.CapabilityRef, p.CapabilityVersion = ref, "1"
			next, why, err := projectImageBatch(raw, "task", p, false)
			if err != nil || why != "" || string(next) != string(raw) || imageBatchPlan(p) {
				t.Fatal("Comfy partial output behavior expanded", ref, state, why, err)
			}
		}
		raw, p := batchFixture(9, "SUCCEEDED")
		p.CapabilityRef, p.CapabilityVersion = ref, "1"
		next, why, err := projectImageBatch(raw, "task", p, false)
		if err != nil || why != "OUTPUT_UNAVAILABLE" || next != nil {
			t.Fatal("batch exceeded its reviewed maximum", ref, why, err)
		}
		p.Outputs = p.Outputs[:2]
		p.CapabilityVersion = "2"
		next, why, err = projectImageBatch(raw, "task", p, false)
		if err != nil || why != "" || string(next) != string(raw) {
			t.Fatal("unreviewed future version gained batch semantics", ref)
		}
	}
}
