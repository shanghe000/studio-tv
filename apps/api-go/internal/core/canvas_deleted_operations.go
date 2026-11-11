package core

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// Only a server-recorded deletion AFTER the origin's immutable observation can
// absorb an obsolete operation. An invented missing ID still fails validation.
type canvasDeletions struct {
	nodes, edges    map[string]bool
	priorNodes      map[string]bool
	suppressedEdges map[string]bool
	skipped         int
	validateRow     func(string, map[string]any) error
}

func loadCanvasDeletions(ctx context.Context, tx pgx.Tx, pid string, rev int64, ops []canvasOperation, graph map[string]any) (*canvasDeletions, error) {
	d := &canvasDeletions{nodes: map[string]bool{}, edges: map[string]bool{}, priorNodes: map[string]bool{}, suppressedEdges: map[string]bool{}}
	for _, n := range graph["nodes"].([]any) {
		id, _ := n.(map[string]any)["id"].(string)
		d.priorNodes[id] = true
	}
	ns, es := map[string]bool{}, map[string]bool{}
	for _, op := range ops {
		if op.NodeID != "" {
			ns[op.NodeID] = true
		}
		if op.EdgeID != "" {
			es[op.EdgeID] = true
		}
		if id, ok := op.Node["id"].(string); ok {
			ns[id] = true
			d.priorNodes[id] = true
		}
		for _, k := range []string{"source", "target"} {
			if id, ok := op.Edge[k].(string); ok {
				ns[id] = true
			}
		}
		if id, ok := op.Edge["id"].(string); ok {
			es[id] = true
		}
		for _, id := range op.NodeIDs {
			ns[id] = true
		}
		for _, id := range op.EdgeIDs {
			es[id] = true
		}
		if op.NodeID == "rhtv_meta_v1" {
			mark := func(p []string) {
				if len(p) >= 3 && p[0] == "data" && p[1] == "edges" {
					es[p[2]] = true
				}
			}
			for _, v := range op.Set {
				mark(v.Path)
			}
			for _, p := range op.Unset {
				mark(p)
			}
		}
	}
	keys := func(values map[string]bool) []string {
		r := make([]string, 0, len(values))
		for k := range values {
			r = append(r, k)
		}
		return r
	}
	rows, err := tx.Query(ctx, `SELECT true,node_id FROM canvas.node_versions WHERE project_id=$1 AND node_id=ANY($3::text[]) AND last_deleted_revision>$2
 UNION ALL SELECT false,edge_id FROM canvas.removed_edges WHERE project_id=$1 AND edge_id=ANY($4::text[]) AND last_deleted_revision>$2`, pid, rev, keys(ns), keys(es))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var node bool
		var id string
		if err = rows.Scan(&node, &id); err != nil {
			return nil, err
		}
		if node {
			d.nodes[id] = true
		} else {
			d.edges[id] = true
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Metadata patches often precede the edge.create operation in the native diff.
	for _, op := range ops {
		if op.Type == "edge.create" {
			from, _ := op.Edge["source"].(string)
			to, _ := op.Edge["target"].(string)
			id, _ := op.Edge["id"].(string)
			if d.nodes[from] || d.nodes[to] || d.edges[id] {
				d.suppressedEdges[id] = true
			}
		}
	}
	return d, nil
}
func (d *canvasDeletions) filter(op canvasOperation) (canvasOperation, bool, error) {
	switch op.Type {
	case "node.patch":
		if d.nodes[op.NodeID] {
			if e := applyCanvasOperationPatch(map[string]any{}, op.Set, op.Unset, false); e != nil {
				return op, false, e
			}
			return op, true, nil
		}
		if op.NodeID == "rhtv_meta_v1" {
			skip := func(p []string) bool {
				return len(p) >= 3 && p[0] == "data" && p[1] == "edges" && (d.edges[p[2]] || d.suppressedEdges[p[2]])
			}
			sets := []canvasOperationValue{}
			unsets := [][]string{}
			for _, v := range op.Set {
				if !skip(v.Path) {
					sets = append(sets, v)
				}
			}
			for _, p := range op.Unset {
				if !skip(p) {
					unsets = append(unsets, p)
				}
			}
			if len(sets) != len(op.Set) || len(unsets) != len(op.Unset) {
				if e := applyCanvasOperationPatch(map[string]any{}, op.Set, op.Unset, false); e != nil {
					return op, false, e
				}
				op.Set = sets
				op.Unset = unsets
				return op, len(sets)+len(unsets) == 0, nil
			}
		}
	case "node.create", "edge.create":
		kind, row := "nodes", op.Node
		if op.Type == "edge.create" {
			kind, row = "edges", op.Edge
		}
		id, _ := row["id"].(string)
		if (kind == "nodes" && d.nodes[id]) || (kind == "edges" && d.suppressedEdges[id]) {
			if e := d.validateRow(kind, row); e != nil {
				return op, false, e
			}
			if kind == "edges" {
				for _, k := range []string{"source", "target"} {
					v, _ := row[k].(string)
					if !d.nodes[v] && !d.priorNodes[v] {
						return op, false, operationError("GRAPH_INVALID", "连线的端点不存在。")
					}
				}
			}
			return op, true, nil
		}
	case "node.delete":
		return op, d.nodes[op.NodeID], nil
	case "edge.delete":
		return op, d.edges[op.EdgeID], nil
	case "nodes.order", "edges.order":
		ids, removed := op.NodeIDs, d.nodes
		if op.Type == "edges.order" {
			ids, removed = op.EdgeIDs, d.edges
		}
		next := []string{}
		seen := map[string]bool{}
		for _, id := range ids {
			if seen[id] {
				return op, false, operationError("INVALID_CANVAS_OPERATIONS", "排序对象标识重复。")
			}
			seen[id] = true
			if !removed[id] {
				next = append(next, id)
			}
		}
		if op.Type == "edges.order" {
			op.EdgeIDs = next
		} else {
			op.NodeIDs = next
		}
		return op, len(next) == 0, nil
	}
	return op, false, nil
}
