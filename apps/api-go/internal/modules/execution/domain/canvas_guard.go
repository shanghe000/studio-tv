package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// CanvasGuard covers the actual input closure and target output-edit guard.
// Graph order matters for upstream text/media ordering; layout never does.
// It accepts both native graphs and the persisted v1 extension encoding.
func CanvasGuard(raw json.RawMessage, target string) (string, []string, error) {
	var graph struct {
		Nodes []map[string]any `json:"nodes"`
		Edges []map[string]any `json:"edges"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&graph) != nil || graph.Nodes == nil || graph.Edges == nil {
		return "", nil, ErrInvalid
	}
	nodes := map[string]map[string]any{}
	extras := map[string]any{}
	for _, n := range graph.Nodes {
		id, _ := n["id"].(string)
		if id == "rhtv_meta_v1" {
			data, _ := n["data"].(map[string]any)
			if e, ok := data["edges"].(map[string]any); ok {
				extras = e
			}
			continue
		}
		if id == "" || nodes[id] != nil {
			return "", nil, ErrInvalid
		}
		nodes[id] = n
	}
	if nodes[target] == nil {
		return "", nil, ErrInvalid
	}
	selected := map[string]bool{target: true}
	for i := 0; i < len(nodes); i++ {
		for _, e := range graph.Edges {
			s, _ := e["source"].(string)
			t, _ := e["target"].(string)
			if selected[t] {
				if nodes[s] == nil {
					return "", nil, ErrInvalid
				}
				selected[s] = true
			}
		}
	}
	meaning := []any{}
	ids := []string{}
	for _, n := range graph.Nodes {
		id, _ := n["id"].(string)
		if !selected[id] {
			continue
		}
		ids = append(ids, id)
		data := map[string]any{}
		if original, ok := n["data"].(map[string]any); ok {
			for k, v := range original {
				data[k] = v
			}
		}
		for _, k := range []string{"__rhtv", "title", "label", "modelName", "modelNameEn", "status", "taskId", "errorMsg", "testMode", "customBadgeText", "progress", "progressDetail", "width", "height", "opResize", "estimateTaskId", "generationStartedAt", "estimatedSeconds", "localVideoEditTaskId"} {
			delete(data, k)
		}
		meaning = append(meaning, map[string]any{"id": id, "type": n["type"], "data": data})
	}
	edges := []any{}
	for _, e := range graph.Edges {
		s, _ := e["source"].(string)
		t, _ := e["target"].(string)
		if !selected[t] {
			continue
		}
		get := func(k string) string { v, _ := e[k].(string); return v }
		role := get("conditioningRole")
		if role == "" {
			id, _ := e["id"].(string)
			x, _ := extras[id].(map[string]any)
			role, _ = x["conditioningRole"].(string)
		}
		edges = append(edges, map[string]string{"source": s, "target": t, "sourceHandle": get("sourceHandle"), "targetHandle": get("targetHandle"), "conditioningRole": role})
	}
	body, err := json.Marshal(map[string]any{"nodes": meaning, "edges": edges})
	if err != nil {
		return "", nil, ErrInvalid
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]), ids, nil
}
