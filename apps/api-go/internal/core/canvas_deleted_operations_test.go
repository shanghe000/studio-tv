package core

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestPostgresAccountDeleteWinsOverLateMoveAndConnectionWithoutDiscardingOtherChanges(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	b := accountReady(t, f, f.otherDevice)
	rev := func() int {
		var v int
		if e := f.db.QueryRow(f.ctx, "SELECT revision FROM projects WHERE id=$1", nodeLeaseProject).Scan(&v); e != nil {
			t.Fatal(e)
		}
		return v
	}
	batch := func(p handoffBrowser, seen int, ops ...canvasOperation) map[string]any {
		return map[string]any{"schemaVersion": "1", "batchId": uuid.NewString(), "clientId": p.page, "observedRevision": seen, "operations": ops}
	}
	send := func(p handoffBrowser, bod map[string]any, want int) (data map[string]any) {
		t.Helper()
		v := f.call(t, p, "POST", "canvas-operations", bod, want)
		var r struct{ Data map[string]any }
		json.Unmarshal([]byte(v.raw), &r)
		return r.Data
	}
	meta := func(edge string) canvasOperation {
		return canvasOperation{Type: "node.patch", NodeID: "rhtv_meta_v1", Set: []canvasOperationValue{{Path: []string{"data", "edges", edge, "conditioningRole"}, Value: "FIRST_FRAME"}}}
	}
	// Edge lands first. A following node deletion must clean its incident edge
	// and the native supplementary metadata, even if this tab never saw either.
	v0 := rev()
	send(b, batch(b, v0, meta("old"), canvasOperation{Type: "edge.create", Edge: operationEdge("old", "n1", "n2")}), 200)
	seen := rev()
	send(a, batch(a, v0, canvasOperation{Type: "node.delete", NodeID: "n1"}), 200)
	late := batch(b, seen, canvasOperation{Type: "node.patch", NodeID: "n1", Set: []canvasOperationValue{{Path: []string{"position", "x"}, Value: 99}}}, meta("late"), canvasOperation{Type: "edge.create", Edge: operationEdge("late", "n1", "n2")}, operationPatch("n2", "keep independent edit"))
	data := send(b, late, 200)
	if data["supersededOperations"] != float64(3) {
		t.Fatal("expected only obsolete effects superseded", data)
	}
	graph := data["graph"].(map[string]any)
	if len(graph["edges"].([]any)) != 0 {
		t.Fatal("revived edge")
	}
	for _, n := range graph["nodes"].([]any) {
		r := n.(map[string]any)
		d := r["data"].(map[string]any)
		if r["id"] == "n1" || r["id"] == "n2" && d["text"] != "keep independent edit" {
			t.Fatal(r)
		}
		if r["id"] == "rhtv_meta_v1" && len(d["edges"].(map[string]any)) != 0 {
			t.Fatal("ghost edge metadata", d)
		}
	}
	after := rev()
	dup := send(b, late, 200)
	if rev() != after || dup["supersededOperations"] != float64(3) {
		t.Fatal("duplicate changed canonical or lost receipt")
	}
	// Fresh undo/reconnection can reuse IDs. Old deltas must not alter this new incarnation.
	send(a, batch(a, after, canvasOperation{Type: "node.create", Node: operationNode("n1")}, meta("old"), canvasOperation{Type: "edge.create", Edge: operationEdge("old", "n1", "n2")}), 200)
	next := rev()
	res := send(b, batch(b, seen, operationPatch("n1", "stale"), canvasOperation{Type: "edge.delete", EdgeID: "old"}, canvasOperation{Type: "node.delete", NodeID: "n1"}), 200)
	if rev() != next || res["supersededOperations"] != float64(3) {
		t.Fatal("late patch/delete touched a recreated object", res)
	}
	// Invented IDs are still rejected. A newly observed valid batch remains usable.
	send(b, batch(b, seen, operationPatch("never-existed", "invalid")), 409)
	send(b, batch(b, rev(), operationPatch("n2", "next works")), 200)
}
