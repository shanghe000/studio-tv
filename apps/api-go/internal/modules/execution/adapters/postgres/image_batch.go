package postgres

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

// Reviewed Comfy image batches are all-or-nothing. Only the existing Codex
// v2/v3 contracts permit partial results; historical receipts stay unchanged.
func comfyImageBatch(p domain.Plan) bool {
	return p.CapabilityVersion == "1" && (p.CapabilityRef == "z-image-turbo-generate-v1" || p.CapabilityRef == "flux2-klein4b-generate-v1")
}

func imageBatchPlan(p domain.Plan) bool {
	return (p.CapabilityVersion == "2" || p.CapabilityVersion == "3") && (p.CapabilityRef == "codex-image-generate-v1" || p.CapabilityRef == "codex-image-edit-v1") || comfyImageBatch(p) && p.State == "SUCCEEDED"
}

func imageBatchNodeID(task, execution, output string) string {
	b, _ := json.Marshal([]string{task, execution, output})
	h := sha256.Sum256(b)
	return "img_" + hex.EncodeToString(h[:16])
}

// projectImageBatch runs after the ordinary target patch, inside the same
// transaction. Failure returns no replacement graph: the caller detaches the
// binding, leaving the durable result available without a partial graph edit.
func projectImageBatch(raw json.RawMessage, task string, p domain.Plan, test bool) (json.RawMessage, string, error) {
	if !imageBatchPlan(p) || !domain.Terminal(p.State) || len(p.Outputs) == 0 {
		return raw, "", nil
	}
	limit := 4
	if comfyImageBatch(p) {
		limit = 8
	}
	if len(p.Outputs) > limit || p.HistoryDeletedAt != nil {
		return nil, "OUTPUT_UNAVAILABLE", nil
	}
	seen := map[string]bool{}
	for _, o := range p.Outputs {
		if o.ID == "" || seen[o.ID] || o.Type != "ASSET" || o.AssetID == nil || *o.AssetID == "" || !strings.HasPrefix(o.MimeType, "image/") || o.DeletedAt != nil {
			return nil, "OUTPUT_UNAVAILABLE", nil
		}
		seen[o.ID] = true
	}
	outputs, err := nativeCanvasOutputs(p.Outputs, test)
	if err != nil {
		return nil, "", err
	}
	for i := range outputs {
		outputs[i]["historyOutputId"] = p.Outputs[i].ID
	}
	var graph map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&graph) != nil {
		return nil, "", domain.ErrInvalid
	}
	nodes, ok := graph["nodes"].([]any)
	if !ok {
		return nil, "", domain.ErrInvalid
	}
	var target map[string]any
	ids := map[string]bool{}
	for _, value := range nodes {
		n, ok := value.(map[string]any)
		if !ok {
			return nil, "", domain.ErrInvalid
		}
		id, _ := n["id"].(string)
		if id == "" || ids[id] {
			return nil, "", domain.ErrInvalid
		}
		ids[id] = true
		if id == p.NodeID {
			target = n
		}
	}
	if target == nil {
		return nil, "", domain.ErrNotFound
	}
	if target["type"] != "rh-image" {
		return raw, "", nil
	}
	data, ok := target["data"].(map[string]any)
	if !ok {
		return nil, "", domain.ErrInvalid
	}
	start := 0
	if p.State == "SUCCEEDED" {
		// History keeps the complete batch, but this node displays and supplies
		// exactly its first image to downstream generation.
		data["output"] = []any{outputs[0]}
		data["selectedHistoryOutputId"] = p.Outputs[0].ID
		delete(data, "selectedOutputHistoryId")
		data["selectedOutputHistoryIndex"] = 0
		data["imageUrl"] = outputs[0]["url"]
		data["sourceObjects"] = []any{outputs[0]["url"]}
		data["assetIds"] = []any{*p.Outputs[0].AssetID}
		delete(data, "assetId")
		data["batchOrigin"] = imageBatchOrigin(task, p, 0)
		// Native graph normalization preserves historyStorage, but drops
		// arbitrary data keys. Keep descriptive batch provenance there too.
		storage, ok := data["historyStorage"].(map[string]any)
		if !ok {
			storage = map[string]any{}
			data["historyStorage"] = storage
		}
		storage["imageBatchOrigin"] = imageBatchOrigin(task, p, 0)
		start = 1
	}
	if len(nodes)+len(outputs)-start > 500 {
		return nil, "RESULT_NODE_LIMIT", nil
	}
	title, _ := data["title"].(string)
	if title == "" {
		title = "图片"
	}
	for i := start; i < len(outputs); i++ {
		id := imageBatchNodeID(task, p.ExecutionID, p.Outputs[i].ID)
		// Applied bindings short-circuit before this function. A collision in a
		// pending binding must never overwrite a user's existing node.
		if ids[id] {
			return nil, "RESULT_NODE_CONFLICT", nil
		}
		x, y := imageBatchPosition(target, nodes)
		child := map[string]any{
			"id": id, "type": "rh-image", "position": map[string]any{"x": x, "y": y},
			"data": map[string]any{
				"title": fmt.Sprintf("%s · %d", title, i+1), "status": "finished", "isUpload": true,
				"output": []any{outputs[i]}, "sourceObjects": []any{outputs[i]["url"]},
				"imageUrl": outputs[i]["url"], "assetIds": []any{*p.Outputs[i].AssetID},
				"generateNum": 1, "params": map[string]any{}, "testMode": test || p.Outputs[i].TestMode,
				"batchOrigin": imageBatchOrigin(task, p, i),
				// No historyId/source: this is provenance, not authority to
				// select a result belonging to a different canvas node.
				"historyStorage": map[string]any{"imageBatchOrigin": imageBatchOrigin(task, p, i)},
			},
		}
		// Keep group-relative positions without inheriting stale selection,
		// history identity, references, prompts or execution state.
		for _, key := range []string{"parentNode", "parentId"} {
			if parent, ok := target[key].(string); ok && parent != "" {
				child[key] = parent
			}
		}
		nodes = append(nodes, child)
		ids[id] = true
	}
	graph["nodes"] = nodes
	next, err := json.Marshal(graph)
	if err == nil && len(next) > 2<<20 {
		return nil, "RESULT_TOO_LARGE", nil
	}
	return next, "", err
}

func imageBatchOrigin(task string, p domain.Plan, index int) map[string]any {
	return map[string]any{"taskId": task, "executionId": p.ExecutionID, "sourceNodeId": p.NodeID, "outputId": p.Outputs[index].ID, "index": index, "count": len(p.Outputs)}
}

func canvasNumber(v any, fallback float64) float64 {
	var n float64
	switch v := v.(type) {
	case json.Number:
		n, _ = v.Float64()
	case float64:
		n = v
	default:
		return fallback
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || math.Abs(n) > 1e7 {
		return fallback
	}
	return n
}

func imageBatchRect(n map[string]any) (float64, float64, float64, float64) {
	position, _ := n["position"].(map[string]any)
	w, h := canvasNumber(n["width"], 320), canvasNumber(n["height"], 360)
	if w <= 0 {
		w = 320
	}
	if h <= 0 {
		h = 360
	}
	return canvasNumber(position["x"], 0), canvasNumber(position["y"], 0), w, h
}

func imageBatchPosition(target map[string]any, nodes []any) (float64, float64) {
	x, y, w, _ := imageBatchRect(target)
	// Search a bounded grid to the right of the source. There are at most
	// 500 existing nodes; the fallback is beyond their rightmost edge.
	maxRight := x + w
	for _, value := range nodes {
		n := value.(map[string]any)
		if n["parentNode"] != target["parentNode"] || n["parentId"] != target["parentId"] {
			continue
		}
		nx, _, nw, _ := imageBatchRect(n)
		maxRight = math.Max(maxRight, nx+nw)
	}
	for slot := 0; slot < 1000; slot++ {
		px, py := x+w+64+float64(slot/2)*384, y+float64(slot%2)*424
		free := true
		for _, value := range nodes {
			n := value.(map[string]any)
			if n["parentNode"] != target["parentNode"] || n["parentId"] != target["parentId"] {
				continue
			}
			nx, ny, nw, nh := imageBatchRect(n)
			if px < nx+nw+32 && px+352 > nx && py < ny+nh+32 && py+392 > ny {
				free = false
				break
			}
		}
		if free {
			return px, py
		}
	}
	return maxRight + 64, y
}
