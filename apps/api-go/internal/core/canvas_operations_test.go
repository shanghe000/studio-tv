package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
)

func operationPatch(node, text string) canvasOperation {
	return canvasOperation{Type: "node.patch", NodeID: node, Set: []canvasOperationValue{{Path: []string{"data", "text"}, Value: text}}}
}
func operationNode(id string) map[string]any {
	return map[string]any{"id": id, "type": "rh-image", "position": map[string]any{"x": json.Number("0"), "y": json.Number("0")}, "data": map[string]any{}}
}
func operationEdge(id, source, target string) map[string]any {
	return map[string]any{"id": id, "source": source, "target": target, "sourceHandle": "output", "targetHandle": "input"}
}

func TestCanvasOperationsApplyOnlyExplicitIntentToCurrentServerGraph(t *testing.T) {
	graph := graphFrom(t, nodeLeaseGraph)
	first := graph["nodes"].([]any)[0].(map[string]any)
	first["data"].(map[string]any)["serverReceipt"] = map[string]any{"sequence": json.Number("7")}
	ops := []canvasOperation{operationPatch("n1", "New user input"), {Type: "node.create", Node: operationNode("new")}, {Type: "edge.create", Edge: operationEdge("edge", "n1", "new")}}
	if err := applyCanvasOperationBatch(graph, ops); err != nil {
		t.Fatal(err)
	}
	if err := validateCanvasOperationTopology(graph); err != nil {
		t.Fatal(err)
	}
	if first["data"].(map[string]any)["text"] != "New user input" || first["data"].(map[string]any)["serverReceipt"] == nil {
		t.Fatal("leaf operation replaced unobserved server fields", first)
	}
	if len(graph["nodes"].([]any)) != 3 || len(graph["edges"].([]any)) != 1 {
		t.Fatal("connected node not created together")
	}
	if err := applyCanvasOperationBatch(graph, []canvasOperation{{Type: "nodes.order", NodeIDs: []string{"new", "n1"}}}); err != nil {
		t.Fatal(err)
	}
	rows := graph["nodes"].([]any)
	if rows[0].(map[string]any)["id"] != "new" || rows[2].(map[string]any)["id"] != "n2" {
		t.Fatal("order discarded unlisted server node")
	}
	if err := applyCanvasOperationBatch(graph, []canvasOperation{{Type: "node.delete", NodeID: "new"}}); err != nil || len(graph["edges"].([]any)) != 0 {
		t.Fatal("delete left dangling incident edge", err)
	}
}

func TestCanvasOperationsRejectInvalidIntentAndFinalTopology(t *testing.T) {
	for _, ops := range [][]canvasOperation{
		{{Type: "unknown"}}, {{Type: "node.patch", NodeID: "missing", Set: []canvasOperationValue{{Path: []string{"data", "text"}, Value: "input"}}}},
		{{Type: "node.patch", NodeID: "n1", Set: []canvasOperationValue{{Path: []string{"id"}, Value: "new"}}}},
		{{Type: "node.patch", NodeID: "n1", Set: []canvasOperationValue{{Path: []string{"data", "__proto__", "secret"}, Value: true}}}},
		{{Type: "graph.patch", Set: []canvasOperationValue{{Path: []string{"nodes"}, Value: []any{}}}}},
		{{Type: "node.create", Node: map[string]any{"id": "n1"}}}, {{Type: "node.delete", NodeID: "n1", EdgeID: "irrelevant"}},
	} {
		if applyCanvasOperationBatch(graphFrom(t, nodeLeaseGraph), ops) == nil {
			t.Fatal("invalid operation accepted", ops)
		}
	}
	for _, edges := range [][]any{
		{operationEdge("self", "n1", "n1")},
		{operationEdge("a", "n1", "n2"), operationEdge("b", "n1", "n2")},
		{operationEdge("a", "n1", "n2"), operationEdge("b", "n2", "n1")},
	} {
		graph := graphFrom(t, nodeLeaseGraph)
		graph["edges"] = edges
		if validateCanvasOperationTopology(graph) == nil {
			t.Fatal("invalid topology accepted")
		}
	}
}

func TestCanvasOperationsBusinessNodeLimitExcludesOnlyValidatedMetadata(t *testing.T) {
	for _, count := range []int{500, 501} {
		graph := graphFrom(t, nodeLeaseGraph)
		nodes := []any{}
		for index := 0; index < count; index++ {
			nodes = append(nodes, operationNode(fmt.Sprintf("node_%03d", index)))
		}
		meta := map[string]any{"id": "rhtv_meta_v1", "type": "__rhtv_meta", "position": map[string]any{"x": 0, "y": 0}, "data": map[string]any{"version": "1"}}
		graph["nodes"] = append(nodes, meta)
		if _, err := validateGraph(graph); err != nil {
			t.Fatal("valid metadata fixture rejected", err)
		}
		err := validateCanvasOperationTopology(graph)
		if count == 500 && err != nil || count == 501 && err == nil {
			t.Fatal("business-node boundary differs from native canvas", count, err)
		}
		if count == 500 {
			meta["data"].(map[string]any)["version"] = "wrong"
			if validateCanvasOperationTopology(graph) == nil {
				t.Fatal("unvalidated reserved row bypassed business limit")
			}
		}
	}
}

func (f *nodeLeaseWriteFixture) operations(t *testing.T, id httpapi.Identity, page, batch string, ops []canvasOperation, want int) *httptest.ResponseRecorder {
	t.Helper()
	return f.operationProbe(t, id, canvasOperationsRequest{SchemaVersion: "1", ClientID: page, BatchID: batch, Operations: ops}, want)
}
func (f *nodeLeaseWriteFixture) operationProbe(t *testing.T, id httpapi.Identity, body canvasOperationsRequest, want int) *httptest.ResponseRecorder {
	t.Helper()
	batch, page := body.BatchID, body.ClientID
	request := httptest.NewRequest(http.MethodPost, "/api/v2/projects/"+nodeLeaseProject+"/canvas-operations", bytes.NewReader(encode(body)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+id.UserID)
	request.Header.Set(collaboration.CanvasSessionHeader, page)
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, request)
	if w.Code != want {
		t.Fatalf("operations %s status%d want%d: %s", batch, w.Code, want, w.Body.String())
	}
	var envelope struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(w.Body.Bytes(), &envelope) != nil || envelope.RequestID == "" || envelope.RequestID != w.Header().Get("X-Request-ID") {
		t.Fatal("operation response lost its current trusted request ID", w.Body.String())
	}
	return w
}

func TestPostgresCanvasRecoveryChecksPriorReceiptBeforeReplayingAtRevision(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	f.writer(t, f.owner, "page_owner", http.MethodPost, 200)
	rev := int64(1)
	op := canvasOperationsRequest{SchemaVersion: "1", ClientID: "page_owner", BatchID: "offline_recovery", Operations: []canvasOperation{operationPatch("n1", "Offline")}, BaseRevision: &rev}
	op.ReceiptOnly = true
	f.operationProbe(t, f.owner, op, 409)
	op.ReceiptOnly = false
	f.operationProbe(t, f.owner, op, 200)
	f.operations(t, f.owner, "page_owner", "later_title", []canvasOperation{operationPatch("n1", "Updated")}, 200)
	op.ReceiptOnly = true
	f.operationProbe(t, f.owner, op, 200)
	op.BatchID = "old_page_new_batch"
	op.ReceiptOnly = false
	f.operationProbe(t, f.owner, op, 412)
	state := f.state(t)
	if state.Revision != 3 || !strings.Contains(state.Graph, "Updated") || strings.Contains(state.Graph, "Offline") {
		t.Fatal("stale page changed the canonical graph", state)
	}
}

func TestPostgresCanvasOperationsCanonicalGraphReceiptsAndReloadConfirmation(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	f.writer(t, f.owner, "page_owner", http.MethodPost, 200)
	// Both pages formed intent from the same old graph. Their disjoint edits
	// serialize against the latest canonical graph without a revision argument.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		f.operations(t, f.owner, "page_owner", "op_owner", []canvasOperation{operationPatch("n1", "Owner text")}, 200)
	}()
	go func() {
		defer wg.Done()
		f.operations(t, f.owner, "page_owner", "op_editor", []canvasOperation{operationPatch("n2", "Editor text")}, 200)
	}()
	wg.Wait()
	state := f.state(t)
	if state.Revision != 3 || state.Sequence != 2 || state.Events != 2 || state.TaskCount != 0 || !strings.Contains(state.Graph, "Owner text") || !strings.Contains(state.Graph, "Editor text") {
		t.Fatal("canonical edits lost or task unexpectedly created", state)
	}
	original := f.operations(t, f.owner, "page_owner", "op_owner", []canvasOperation{operationPatch("n1", "Owner text")}, 200)
	// Deletion after acknowledgement cannot be undone by confirming the first
	// batch after reload, even though the refreshed page has a new presence ID.
	f.operations(t, f.owner, "page_owner", "op_delete", []canvasOperation{{Type: "node.delete", NodeID: "n1"}}, 200)
	deleted := f.state(t)
	replay := f.operations(t, f.owner, "page_after_reload", "op_owner", []canvasOperation{operationPatch("n1", "Owner text")}, 200)
	var a, b struct {
		Data struct {
			ProjectID        string          `json:"projectId"`
			BatchID          string          `json:"batchId"`
			ClientID         string          `json:"clientId"`
			AcceptedRevision int64           `json:"acceptedRevision"`
			Revision         int64           `json:"revision"`
			AcceptedAt       string          `json:"acceptedAt"`
			Graph            json.RawMessage `json:"graph"`
		}
	}
	if json.Unmarshal(original.Body.Bytes(), &a) != nil || json.Unmarshal(replay.Body.Bytes(), &b) != nil || a.Data.AcceptedRevision < 1 || b.Data.AcceptedRevision != a.Data.AcceptedRevision || b.Data.Revision != deleted.Revision || b.Data.AcceptedAt != a.Data.AcceptedAt || b.Data.ClientID != "page_owner" || b.Data.BatchID != "op_owner" || b.Data.ProjectID != nodeLeaseProject {
		t.Fatal("reload did not confirm the original effect against current canonical graph", original.Body.String(), replay.Body.String())
	}
	if strings.Contains(string(b.Data.Graph), `"id":"n1"`) {
		t.Fatal("confirmation returned an old graph containing deleted node")
	}
	var graphReceipts, oversizedReceipts int
	if err := f.db.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE receipt ? 'graph'),count(*) FILTER(WHERE octet_length(receipt::text)>1024) FROM canvas.operation_receipts WHERE project_id=$1`, nodeLeaseProject).Scan(&graphReceipts, &oversizedReceipts); err != nil || graphReceipts != 0 || oversizedReceipts != 0 {
		t.Fatal("operation receipts retained graph/history copies", graphReceipts, oversizedReceipts, err)
	}
	if f.state(t) != deleted {
		t.Fatal("replayed old operation changed current graph")
	}
	f.operations(t, f.owner, "page_after_reload", "op_owner", []canvasOperation{operationPatch("n1", "Changed request")}, 409)
	f.operations(t, f.owner, "page_after_reload", "op_missing", []canvasOperation{operationPatch("n1", "Must not resurrect")}, 409)
	if f.state(t) != deleted {
		t.Fatal("rejected operation modified graph")
	}
}

func TestPostgresCanvasOperationsAtomicCreationLeaseAndAssetGuards(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	f.writer(t, f.owner, "page_owner", http.MethodPost, 200)
	before := f.state(t)
	// Foreign page cannot change the occupied endpoint through a new edge.
	f.operations(t, f.editor, "page_editor", "op_occupied", []canvasOperation{{Type: "node.create", Node: operationNode("new")}, {Type: "edge.create", Edge: operationEdge("edge", "n1", "new")}}, 409)
	if f.state(t) != before {
		t.Fatal("lease rejection partially created a node")
	}
	f.operations(t, f.owner, "page_owner", "op_bad_edge", []canvasOperation{{Type: "node.create", Node: operationNode("new")}, {Type: "edge.create", Edge: operationEdge("edge", "missing", "new")}}, 422)
	if f.state(t) != before {
		t.Fatal("invalid edge partially created a node")
	}
	f.operations(t, f.owner, "page_owner", "op_connected", []canvasOperation{{Type: "node.create", Node: operationNode("new")}, {Type: "edge.create", Edge: operationEdge("edge", "n1", "new")}}, 200)
	connected := f.state(t)
	if connected.Revision != 2 || connected.Events != 1 || !strings.Contains(connected.Graph, `"target": "new"`) {
		t.Fatal("node+edge were not committed once", connected)
	}
	if _, err := f.db.Exec(f.ctx, `INSERT INTO public.projects(id,owner_id,name)VALUES('prj_private','usr_b','Private');INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state)VALUES('asset_private','usr_b','prj_private','private.png','IMAGE','image/png',4,'sha','READY')`); err != nil {
		t.Fatal(err)
	}
	node := operationNode("private")
	node["data"] = map[string]any{"sourceObjects": []any{"rhtv-asset:asset_private"}}
	f.operations(t, f.owner, "page_owner", "op_asset", []canvasOperation{{Type: "node.create", Node: node}}, 422)
	if f.state(t) != connected {
		t.Fatal("private asset rejection changed canonical graph")
	}
	if _, err := f.db.Exec(f.ctx, `UPDATE collaboration.project_members SET role='VIEWER' WHERE project_id=$1 AND user_id='usr_b'`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	f.operations(t, f.editor, "page_editor", "op_viewer", []canvasOperation{operationPatch("n2", "Denied")}, 403)
	if f.state(t) != connected {
		t.Fatal("viewer mutated graph")
	}
}

func (f *nodeLeaseWriteFixture) writer(t *testing.T, id httpapi.Identity, page, method string, want int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/api/v2/projects/"+nodeLeaseProject+"/edit-session", bytes.NewReader(encode(map[string]any{"clientId": page})))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+id.UserID)
	request.Header.Set(collaboration.CanvasSessionHeader, page)
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, request)
	if w.Code != want {
		t.Fatalf("writer %s status%d want%d: %s", page, w.Code, want, w.Body.String())
	}
	return w
}

func TestPostgresCanvasExclusiveWriterFencesOtherPagesAndLegacyWrites(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	before := f.state(t)
	f.operations(t, f.owner, "page_owner", "op_before_writer", []canvasOperation{operationPatch("n1", "Unconfirmed")}, 409)
	f.writer(t, f.owner, "page_owner", http.MethodPost, 200)
	f.writer(t, f.owner, "page_owner", http.MethodPost, 200)
	f.writer(t, f.editor, "page_editor", http.MethodPost, 409)
	f.writer(t, f.owner, "page_reload", http.MethodPost, 409)
	f.operations(t, f.editor, "page_editor", "op_other_writer", []canvasOperation{operationPatch("n2", "Must not save")}, 409)
	f.put(t, f.editor, "page_editor", f.edit(t, "n2", "Legacy must not save"), 409)
	f.writer(t, f.editor, "page_editor", http.MethodDelete, 200)
	if f.state(t) != before {
		t.Fatal("writer lifecycle or fenced page changed graph")
	}
	f.operations(t, f.owner, "page_owner", "op_owned", []canvasOperation{operationPatch("n1", "Writer saved")}, 200)
	if _, err := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	f.writer(t, f.editor, "page_editor", http.MethodPost, 200)
	f.writer(t, f.owner, "page_owner", http.MethodPost, 409)
	f.operations(t, f.owner, "page_owner", "op_old_writer", []canvasOperation{operationPatch("n1", "Old page must not save")}, 409)
	f.writer(t, f.owner, "page_owner", http.MethodDelete, 200)
	f.operations(t, f.editor, "page_editor", "op_new_writer", []canvasOperation{operationPatch("n2", "Next writer saved")}, 200)
	f.writer(t, f.editor, "page_editor", http.MethodDelete, 200)
	f.writer(t, f.owner, "page_reload", http.MethodPost, 200)
	if state := f.state(t); !strings.Contains(state.Graph, "Writer saved") || !strings.Contains(state.Graph, "Next writer saved") || state.TaskCount != 0 {
		t.Fatal("writer fencing lost accepted edits", state)
	}
}

func TestCanvasOperationEndpointRequiresLiveProductCapability(t *testing.T) {
	if capabilityFor(http.MethodPost, "/api/v2/projects/{projectId}/canvas-operations") != "tv.access" {
		t.Fatal("operation route lacks product capability gate")
	}
}

func nativeEdgeMetadataPatch(edgeID string) canvasOperation {
	return canvasOperation{Type: "node.patch", NodeID: "rhtv_meta_v1", Set: []canvasOperationValue{{Path: []string{"data", "edges", edgeID}, Value: map[string]any{"__studioNativeEdgeId": "xy-edge__source/output__target/input", "animated": false}}}}
}

func TestCanvasOperationsMaterializeOnlyMissingSyntheticMetadata(t *testing.T) {
	graph := graphFrom(t, nodeLeaseGraph)
	operations := []canvasOperation{nativeEdgeMetadataPatch("studio_edge_fixture"), {Type: "edge.create", Edge: operationEdge("studio_edge_fixture", "n1", "n2")}}
	if e := applyCanvasOperationBatch(graph, operations); e != nil {
		t.Fatal("first native connection cannot materialize metadata", e)
	}
	if _, e := validateGraph(graph); e != nil {
		t.Fatal(e)
	}
	if e := validateCanvasOperationTopology(graph); e != nil {
		t.Fatal(e)
	}
	nodes := graph["nodes"].([]any)
	if len(nodes) != 3 || len(graph["edges"].([]any)) != 1 {
		t.Fatal("business nodes or connection lost")
	}
	meta := nodes[2].(map[string]any)
	if meta["id"] != "rhtv_meta_v1" || meta["type"] != "__rhtv_meta" || meta["data"].(map[string]any)["version"] != "1" {
		t.Fatal("reserved shell identity drifted", meta)
	}
	if e := applyCanvasOperationBatch(graphFrom(t, nodeLeaseGraph), []canvasOperation{operationPatch("missing-user-node", "never resurrect")}); e == nil {
		t.Fatal("ordinary missing node silently created")
	}
	for _, invalid := range []canvasOperation{
		{Type: "node.patch", NodeID: "rhtv_meta_v1", Set: []canvasOperationValue{{Path: []string{"type"}, Value: "rh-text"}}},
		{Type: "node.patch", NodeID: "rhtv_meta_v1", Set: []canvasOperationValue{{Path: []string{"data", "version"}, Value: "2"}}},
		{Type: "node.patch", NodeID: "rhtv_meta_v1", Set: []canvasOperationValue{{Path: []string{"data", "apiKey"}, Value: "not-a-real-key"}}},
	} {
		draft := graphFrom(t, nodeLeaseGraph)
		e := applyCanvasOperationBatch(draft, []canvasOperation{invalid})
		if e == nil {
			_, e = validateGraph(draft)
		}
		if e == nil {
			t.Fatal("synthetic metadata bypassed graph security", invalid)
		}
	}
}

func TestPostgresCanvasOperationsNativeMetaPatchReplaysExactBatch(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	f.writer(t, f.owner, "page_owner", http.MethodPost, 200)
	before := f.state(t)
	// Canonical graph has only two ordinary nodes, exactly like a fresh native
	// template before its first metadata-bearing edge is acknowledged.
	operations := []canvasOperation{nativeEdgeMetadataPatch("studio_edge_fixture"), {Type: "edge.create", Edge: operationEdge("studio_edge_fixture", "n1", "n2")}}
	first := f.operations(t, f.owner, "page_owner", "original_pending_meta_batch", operations, 200)
	after := f.state(t)
	if after.Revision != before.Revision+1 || after.Sequence != before.Sequence+1 || !strings.Contains(after.Graph, "studio_edge_fixture") || !strings.Contains(after.Graph, "rhtv_meta_v1") {
		t.Fatal("canonical connection was not stored", after)
	}
	var envelope struct {
		Data struct {
			Graph            map[string]any `json:"graph"`
			AcceptedRevision int64          `json:"acceptedRevision"`
		}
	}
	if json.Unmarshal(first.Body.Bytes(), &envelope) != nil || envelope.Data.AcceptedRevision != after.Revision {
		t.Fatal("receipt does not confirm real stored effect")
	}
	replay := f.operations(t, f.owner, "page_after_reload", "original_pending_meta_batch", operations, 200)
	if replay.Code != 200 || f.state(t) != after {
		t.Fatal("same unknown batch re-applied or lost connection")
	}
	// Reusing an accepted ID for different edits remains a conflict.
	f.operations(t, f.owner, "page_owner", "original_pending_meta_batch", []canvasOperation{operationPatch("n1", "different request")}, 409)
	f.operations(t, f.owner, "page_owner", "missing_business_node", []canvasOperation{operationPatch("missing-user-node", "must not be created")}, 409)
	f.operations(t, f.owner, "page_owner", "invalid_metadata_version", []canvasOperation{{Type: "node.patch", NodeID: "rhtv_meta_v1", Set: []canvasOperationValue{{Path: []string{"data", "version"}, Value: "2"}}}}, 422)
	if f.state(t) != after {
		t.Fatal("rejected compatibility misuse modified graph")
	}
}
