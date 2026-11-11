package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"studiotv.local/service/api/internal/canvasdelta"
	"reflect"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
)

type canvasOperationValue struct {
	Path  []string `json:"path"`
	Value any      `json:"value"`
}

func (v *canvasOperationValue) UnmarshalJSON(raw []byte) error {
	var value struct {
		Path  []string        `json:"path"`
		Value json.RawMessage `json:"value"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&value); err != nil {
		return err
	}
	if len(value.Value) == 0 {
		return errors.New("canvas set requires a value")
	}
	d = json.NewDecoder(bytes.NewReader(value.Value))
	d.UseNumber()
	if err := d.Decode(&v.Value); err != nil {
		return err
	}
	v.Path = value.Path
	return nil
}

type canvasOperation struct {
	Type    string                 `json:"type"`
	Node    map[string]any         `json:"node,omitempty"`
	Edge    map[string]any         `json:"edge,omitempty"`
	NodeID  string                 `json:"nodeId,omitempty"`
	EdgeID  string                 `json:"edgeId,omitempty"`
	NodeIDs []string               `json:"nodeIds,omitempty"`
	EdgeIDs []string               `json:"edgeIds,omitempty"`
	Set     []canvasOperationValue `json:"set,omitempty"`
	Unset   [][]string             `json:"unset,omitempty"`
}
type canvasOperationsRequest struct {
	ObservedRevision *int64            `json:"observedRevision,omitempty"`
	BaseRevision     *int64            `json:"baseRevision,omitempty"`
	ReceiptOnly      bool              `json:"receiptOnly,omitempty"`
	SchemaVersion    string            `json:"schemaVersion"`
	BatchID          string            `json:"batchId"`
	ClientID         string            `json:"clientId"`
	Operations       []canvasOperation `json:"operations"`
}

// An idempotency receipt records only the accepted effect, never a graph
// version. Confirmations are paired with today's canonical document below.
type canvasOperationReceipt struct {
	SchemaVersion        string `json:"schemaVersion"`
	BatchID              string `json:"batchId"`
	OriginClientID       string `json:"originClientId"`
	AcceptedRevision     int    `json:"acceptedRevision"`
	AcceptedAt           string `json:"acceptedAt"`
	SupersededOperations int    `json:"supersededOperations,omitempty"`
}

func canvasOperationSnapshot(ctx context.Context, tx pgx.Tx, current Project, accepted canvasOperationReceipt) (map[string]any, error) {
	if accepted.SchemaVersion != "1" || !validOperationID(accepted.BatchID) || !validOperationID(accepted.OriginClientID) || accepted.AcceptedRevision < 1 || accepted.AcceptedRevision > current.Revision {
		return nil, errors.New("invalid stored canvas operation metadata")
	}
	if _, err := time.Parse(time.RFC3339Nano, accepted.AcceptedAt); err != nil {
		return nil, errors.New("invalid stored canvas operation time")
	}
	// Keep the canonical JSON from this transaction intact. A delta response
	// need not parse/re-encode an entire graph merely to return its receipt.
	snapshot := map[string]any{"projectId": current.ID, "revision": current.Revision, "updatedAt": iso(current.UpdatedAt), "graph": json.RawMessage(current.Graph)}
	var sequence int64
	if err := tx.QueryRow(ctx, `SELECT event_sequence FROM public.projects WHERE id=$1`, current.ID).Scan(&sequence); err != nil {
		return nil, err
	}
	snapshot["eventCursor"] = strconv.FormatInt(sequence, 10)
	snapshot["batchId"] = accepted.BatchID
	snapshot["clientId"] = accepted.OriginClientID
	snapshot["acceptedRevision"] = accepted.AcceptedRevision
	snapshot["acceptedAt"] = accepted.AcceptedAt
	if accepted.SupersededOperations > 0 {
		snapshot["supersededOperations"] = accepted.SupersededOperations
	}
	return snapshot, nil
}

func operationError(code, message string) error { return httpapi.Fail(422, code, message) }
func validOperationID(id string) bool           { return len(id) > 0 && len(id) <= 64 && requireID(id) == nil }

func (s *Server) applyCanvasOperations(w http.ResponseWriter, r *http.Request) error {
	var request canvasOperationsRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
		return httpapi.Fail(400, "INVALID_CANVAS_OPERATIONS", "画布操作请求格式无效。")
	}
	if request.SchemaVersion != "1" || !validOperationID(request.BatchID) || !validOperationID(request.ClientID) || len(request.Operations) == 0 || len(request.Operations) > 2048 {
		return operationError("INVALID_CANVAS_OPERATIONS", "画布操作标识或数量无效。")
	}
	if len(r.Header.Values(collaboration.CanvasSessionHeader)) != 1 || r.Header.Get(collaboration.CanvasSessionHeader) != request.ClientID {
		return httpapi.Fail(400, "INVALID_CANVAS_SESSION", "画布操作与当前协作会话不一致。")
	}
	raw, _ := json.Marshal(struct {
		SchemaVersion    string            `json:"schemaVersion"`
		Operations       []canvasOperation `json:"operations"`
		ObservedRevision *int64            `json:"observedRevision,omitempty"`
	}{request.SchemaVersion, request.Operations, request.ObservedRevision})
	digest := fmt.Sprintf("%x", sha256.Sum256(raw))
	var committedBefore, committedAfter []byte
	var previousRev, committedRev int
	var finishIndex func()
	defer func() {
		if finishIndex != nil {
			finishIndex()
		}
	}()
	result, err := database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (map[string]any, error) {
		current, err := s.ownedProject(r, tx, chi.URLParam(r, "projectId"), true)
		if err != nil {
			return nil, err
		}
		var savedHash string
		var saved []byte
		err = tx.QueryRow(r.Context(), `SELECT request_hash,receipt FROM canvas.operation_receipts WHERE project_id=$1 AND actor_id=$2 AND batch_id=$3`, current.ID, owner(r), request.BatchID).Scan(&savedHash, &saved)
		if err == nil {
			if savedHash != digest {
				return nil, httpapi.Fail(409, "CANVAS_OPERATION_ID_REUSED", "画布操作标识已用于其他内容。")
			}
			var receipt canvasOperationReceipt
			if json.Unmarshal(saved, &receipt) != nil {
				return nil, errors.New("invalid stored canvas operation receipt")
			}
			return canvasOperationSnapshot(r.Context(), tx, current, receipt)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if _, err = collaboration.CheckProjectEditSession(r.Context(), tx, current.ID, httpapi.IdentityFrom(r), request.ClientID, true); err != nil {
			return nil, err
		}
		// Recovery probes always honor an existing receipt above. Never turn a
		// lost acknowledgement or a stale tab into a second, unguarded write.
		if request.ReceiptOnly {
			return nil, httpapi.Fail(409, "CANVAS_BATCH_NOT_APPLIED", "此操作尚未被服务器确认。")
		}
		if request.BaseRevision != nil && *request.BaseRevision != int64(current.Revision) {
			return nil, httpapi.Fail(412, "CANVAS_RECOVERY_RECHECK", "画布刚更新，正在重新检查待同步操作。")
		}

		var graph map[string]any
		d := json.NewDecoder(bytes.NewReader(current.Graph))
		d.UseNumber()
		if d.Decode(&graph) != nil {
			return nil, errors.New("invalid canonical canvas graph")
		}
		var removed *canvasDeletions
		if seen := request.ObservedRevision; seen != nil {
			if *seen < 1 || *seen > int64(current.Revision) {
				return nil, operationError("INVALID_CANVAS_OPERATIONS", "画布操作观察修订无效。")
			}
			if *seen < int64(current.Revision) {
				removed, err = loadCanvasDeletions(r.Context(), tx, current.ID, *seen, request.Operations, graph)
				if err != nil {
					return nil, err
				}
				removed.validateRow = func(kind string, row map[string]any) error {
					candidate := map[string]any{"schemaVersion": "1", "nodes": []any{}, "edges": []any{}, "viewport": graph["viewport"]}
					candidate[kind] = []any{row}
					if e := s.schemas["ProjectSaveRequest"].Validate(map[string]any{"graph": candidate}); e != nil {
						return operationError("GRAPH_INVALID", "被移除的节点或连线格式无效。")
					}
					return nil
				}
			}
		}
		if err = applyObservedCanvasOperations(graph, request.Operations, removed); err != nil {
			return nil, err
		}
		// Apply the exact stored-graph schema and shared asset/security checks.
		if err = s.schemas["ProjectSaveRequest"].Validate(map[string]any{"graph": graph}); err != nil {
			return nil, operationError("GRAPH_INVALID", "画布操作产生了无效的节点或连线。")
		}
		refs, err := validateGraph(graph)
		if err != nil {
			return nil, err
		}
		if err = validateCanvasOperationTopology(graph); err != nil {
			return nil, err
		}
		next := encode(graph)
		if len(next) > 2*1024*1024 {
			return nil, operationError("GRAPH_TOO_LARGE", "画布数据超过2 MiB，请精简内容。")
		}
		changed, err := collaboration.ChangedNodeIDs(current.Graph, next)
		if err != nil {
			return nil, err
		}
		if err = collaboration.CheckNodeLeases(r.Context(), tx, current.ID, httpapi.IdentityFrom(r), request.ClientID, changed); err != nil {
			return nil, err
		}
		before := decodeOperationGraph(current.Graph)
		if len(refs) > 0 {
			refs = addedCanvasAssetIDs(before, graph)
		}
		if len(refs) > 0 {
			if err = collaboration.AuthorizeProjectAssets(r.Context(), tx, owner(r), current.ID, refs); err != nil {
				return nil, err
			}
		}
		// The existing DB triggers normalize task bindings and emit the durable
		// invalidation event. Task/legacy writers use this same canonical graph.
		if !reflect.DeepEqual(graph, before) {
			previousRev = current.Revision
			committedBefore = current.Graph
			current, err = scanProject(tx.QueryRow(r.Context(), `UPDATE public.projects SET graph=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING `+projectColumns, current.ID, next))
			if err != nil {
				return nil, err
			}
			committedAfter = current.Graph
			committedRev = current.Revision
			finishIndex = s.canvasDeltas.Begin(current.ID, int64(current.Revision))
		}
		accepted := canvasOperationReceipt{SchemaVersion: "1", BatchID: request.BatchID, OriginClientID: request.ClientID, AcceptedRevision: current.Revision, AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		if removed != nil {
			accepted.SupersededOperations = removed.skipped
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO canvas.operation_receipts(project_id,actor_id,client_id,batch_id,request_hash,receipt)VALUES($1,$2,$3,$4,$5,$6)`, current.ID, owner(r), request.ClientID, request.BatchID, digest, encode(accepted))
		if err != nil {
			return nil, err
		}
		return canvasOperationSnapshot(r.Context(), tx, current, accepted)
	})
	if err != nil {
		return err
	}
	// An aborted transaction or a repeated receipt must never populate the cache.
	if committedAfter != nil {
		s.canvasDeltas.Record(chi.URLParam(r, "projectId"), int64(previousRev), int64(committedRev), committedBefore, committedAfter)
		if finishIndex != nil {
			finishIndex()
			finishIndex = nil
		}
	}
	// Transport negotiation is outside the operation digest. Recovery probes
	// always get the complete authoritative graph, including on receipt replay.
	if !request.ReceiptOnly && len(r.Header.Values("X-STUDIO-Canvas-Receipt")) == 1 && r.Header.Get("X-STUDIO-Canvas-Receipt") == "delta-v1" && len(r.Header.Values("X-STUDIO-Canvas-Base")) == 1 {
		rawBase := r.Header.Get("X-STUDIO-Canvas-Base")
		base, e := strconv.ParseInt(rawBase, 10, 64)
		rev := int64(result["revision"].(int))
		if e == nil && base > 0 && base <= 9007199254740991 && strconv.FormatInt(base, 10) == rawBase {
			var d *canvasdelta.Delta
			if base == rev {
				empty := canvasdelta.Empty()
				d = &empty
			} else {
				d, _ = s.canvasDeltas.Read(chi.URLParam(r, "projectId"), base, rev, result["graph"].(json.RawMessage))
			}
			if d != nil {
				delete(result, "graph")
				result["kind"] = "DELTA"
				result["fromRevision"] = base
				result["delta"] = d
			}
		}
	}
	revision := fmt.Sprint(result["revision"])
	w.Header().Set("ETag", `"`+revision+`"`)
	return httpapi.OK(w, r, 200, result)
}

func decodeOperationGraph(raw []byte) map[string]any {
	var graph map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	_ = d.Decode(&graph)
	return graph
}

func applyCanvasOperationBatch(graph map[string]any, operations []canvasOperation) error {
	return applyObservedCanvasOperations(graph, operations, nil)
}
func applyObservedCanvasOperations(graph map[string]any, operations []canvasOperation, removed *canvasDeletions) error {
	// Deleting a node also deletes incident connections, including connections
	// first added by a sibling page. Drop only their orphaned native edge metadata.
	removedEdges := map[string]bool{}
	if removed != nil {
		for id := range removed.suppressedEdges {
			removedEdges[id] = true
		}
	}

	for _, op := range operations {
		// Reject irrelevant fields too; unknown operation combinations must never
		// silently become a different edit from the one the client requested.
		allowed := map[string]bool{"type": true}
		var required string
		switch op.Type {
		case "node.create":
			allowed["node"] = true
			required = "node"
		case "edge.create":
			allowed["edge"] = true
			required = "edge"
		case "node.patch":
			allowed["nodeId"] = true
			allowed["set"] = true
			allowed["unset"] = true
			required = "nodeId"
		case "node.delete":
			allowed["nodeId"] = true
			required = "nodeId"
		case "edge.delete":
			allowed["edgeId"] = true
			required = "edgeId"
		case "nodes.order":
			allowed["nodeIds"] = true
			required = "nodeIds"
		case "edges.order":
			allowed["edgeIds"] = true
			required = "edgeIds"
		case "graph.patch":
			allowed["set"] = true
			allowed["unset"] = true
		default:
			return operationError("CANVAS_OPERATION_UNSUPPORTED", "画布操作类型不受支持。")
		}
		raw, _ := json.Marshal(op)
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		for key := range fields {
			if !allowed[key] {
				return operationError("INVALID_CANVAS_OPERATIONS", "画布操作包含无关字段。")
			}
		}
		if required != "" {
			if _, ok := fields[required]; !ok {
				return operationError("INVALID_CANVAS_OPERATIONS", "画布操作缺少必要字段。")
			}
		}
		if removed != nil {
			filtered, skip, e := removed.filter(op)
			if e != nil {
				return e
			}
			if skip {
				removed.skipped++
				continue
			}
			op = filtered
		}
		switch op.Type {
		case "node.create", "edge.create":
			kind, row := "nodes", op.Node
			if op.Type == "edge.create" {
				kind, row = "edges", op.Edge
			}
			id, _ := row["id"].(string)
			if id == "" {
				return operationError("INVALID_CANVAS_OPERATIONS", "节点或连线标识无效。")
			}
			rows, _ := graph[kind].([]any)
			found := false
			for _, value := range rows {
				existing, ok := value.(map[string]any)
				if ok && existing["id"] == id {
					if !reflect.DeepEqual(existing, row) {
						return httpapi.Fail(409, "CANVAS_OBJECT_EXISTS", "节点或连线已经存在。")
					}
					found = true
					break
				}
			}
			if !found {
				graph[kind] = append(rows, row)
			}
		case "node.patch":
			var target map[string]any
			for _, value := range graph["nodes"].([]any) {
				row := value.(map[string]any)
				if row["id"] == op.NodeID {
					target = row
					break
				}
			}
			if target == nil && op.NodeID == "rhtv_meta_v1" {
				// Older canonical canvases can omit the native adapter's
				// synthetic metadata row. Its observation still emitted a
				// patch when a first connection introduced edge metadata.
				// Materialize only this fixed, invisible v1 shell so the
				// original durable batch can replay without changing its ID
				// or payload. User nodes are never resurrected here. The
				// patch and complete graph/security validators still run.
				target = map[string]any{
					"id": "rhtv_meta_v1", "type": "__rhtv_meta",
					"position": map[string]any{"x": json.Number("0"), "y": json.Number("0")},
					"data":     map[string]any{"version": "1", "meta": map[string]any{}, "edges": map[string]any{}},
				}
				graph["nodes"] = append(graph["nodes"].([]any), target)
			}
			if target == nil {
				return httpapi.Fail(409, "CANVAS_NODE_MISSING", "节点已被删除，本次修改没有覆盖其他内容。")
			}
			if err := applyCanvasOperationPatch(target, op.Set, op.Unset, false); err != nil {
				return err
			}
		case "graph.patch":
			if err := applyCanvasOperationPatch(graph, op.Set, op.Unset, true); err != nil {
				return err
			}
		case "node.delete", "edge.delete":
			kind, id := "nodes", op.NodeID
			if op.Type == "edge.delete" {
				kind, id = "edges", op.EdgeID
			}
			if id == "" {
				return operationError("INVALID_CANVAS_OPERATIONS", "删除对象标识无效。")
			}
			if kind == "edges" {
				removedEdges[id] = true
			}
			rows := []any{}
			for _, value := range graph[kind].([]any) {
				if value.(map[string]any)["id"] != id {
					rows = append(rows, value)
				}
			}
			graph[kind] = rows
			if kind == "nodes" {
				edges := []any{}
				for _, value := range graph["edges"].([]any) {
					edge := value.(map[string]any)
					if edge["source"] != id && edge["target"] != id {
						edges = append(edges, value)
					} else if edgeID, ok := edge["id"].(string); ok {
						removedEdges[edgeID] = true
					}
				}
				graph["edges"] = edges
			}
		case "nodes.order", "edges.order":
			kind, ids := "nodes", op.NodeIDs
			if op.Type == "edges.order" {
				kind, ids = "edges", op.EdgeIDs
			}
			rows := graph[kind].([]any)
			byID := map[string]any{}
			for _, value := range rows {
				byID[value.(map[string]any)["id"].(string)] = value
			}
			ordered := []any{}
			seen := map[string]bool{}
			for _, id := range ids {
				if seen[id] {
					return operationError("INVALID_CANVAS_OPERATIONS", "排序对象标识重复。")
				}
				seen[id] = true
				if row, ok := byID[id]; ok {
					ordered = append(ordered, row)
				}
			}
			for _, value := range rows {
				if !seen[value.(map[string]any)["id"].(string)] {
					ordered = append(ordered, value)
				}
			}
			graph[kind] = ordered
		}
	}
	if len(removedEdges) > 0 {
		for _, e := range graph["edges"].([]any) {
			if id, ok := e.(map[string]any)["id"].(string); ok {
				delete(removedEdges, id)
			}
		}
		for _, n := range graph["nodes"].([]any) {
			node := n.(map[string]any)
			if node["id"] == "rhtv_meta_v1" {
				data, _ := node["data"].(map[string]any)
				meta, _ := data["edges"].(map[string]any)
				for id := range removedEdges {
					delete(meta, id)
				}
				break
			}
		}
	}

	return nil
}

func applyCanvasOperationPatch(target map[string]any, sets []canvasOperationValue, unsets [][]string, root bool) error {
	if len(sets)+len(unsets) == 0 || len(sets)+len(unsets) > 2048 {
		return operationError("INVALID_CANVAS_OPERATIONS", "画布字段修改数量无效。")
	}
	apply := func(path []string, value any, remove bool) error {
		if len(path) == 0 || len(path) > 32 {
			return operationError("INVALID_CANVAS_OPERATIONS", "画布字段路径无效。")
		}
		if root && path[0] != "viewport" || !root && path[0] != "data" && path[0] != "position" && path[0] != "type" {
			return operationError("INVALID_CANVAS_OPERATIONS", "画布对象字段不允许修改。")
		}
		for _, key := range path {
			if key == "" || len(key) > 512 || key == "__proto__" || key == "constructor" || key == "prototype" {
				return operationError("INVALID_CANVAS_OPERATIONS", "画布字段路径无效。")
			}
		}
		current := target
		for _, key := range path[:len(path)-1] {
			next, ok := current[key].(map[string]any)
			if !ok {
				if remove {
					return nil
				}
				if current[key] != nil {
					return httpapi.Fail(409, "CANVAS_FIELD_TYPE_CHANGED", "字段类型已经变化，请等待同步后重试。")
				}
				next = map[string]any{}
				current[key] = next
			}
			current = next
		}
		key := path[len(path)-1]
		if remove {
			delete(current, key)
		} else {
			current[key] = value
		}
		return nil
	}
	for _, set := range sets {
		if err := apply(set.Path, set.Value, false); err != nil {
			return err
		}
	}
	for _, path := range unsets {
		if err := apply(path, nil, true); err != nil {
			return err
		}
	}
	return nil
}

func validateCanvasOperationTopology(graph map[string]any) error {
	nodes := graph["nodes"].([]any)
	edges := graph["edges"].([]any)
	businessNodes := 0
	for _, value := range nodes {
		node := value.(map[string]any)
		data, _ := node["data"].(map[string]any)
		// validateGraph has already checked the sole reserved metadata row.
		// It is not a user-visible node and is absent from the native limit.
		if node["id"] == "rhtv_meta_v1" && node["type"] == "__rhtv_meta" && data["version"] == "1" {
			continue
		}
		businessNodes++
	}
	if businessNodes > 500 || len(edges) > 2000 {
		return operationError("GRAPH_LIMIT_EXCEEDED", "节点或连线数量超过画布上限。")
	}
	degree := map[string]int{}
	children := map[string][]string{}
	pairs := map[[2]string]bool{}
	for _, value := range nodes {
		degree[value.(map[string]any)["id"].(string)] = 0
	}
	for _, value := range edges {
		edge := value.(map[string]any)
		source, target := edge["source"].(string), edge["target"].(string)
		pair := [2]string{source, target}
		if source == target || pairs[pair] {
			return operationError("GRAPH_CONNECTION_INVALID", "连线不能重复或连接节点自身。")
		}
		pairs[pair] = true
		degree[target]++
		children[source] = append(children[source], target)
	}
	ready := []string{}
	for id, n := range degree {
		if n == 0 {
			ready = append(ready, id)
		}
	}
	visited := 0
	for len(ready) > 0 {
		id := ready[len(ready)-1]
		ready = ready[:len(ready)-1]
		visited++
		for _, next := range children[id] {
			degree[next]--
			if degree[next] == 0 {
				ready = append(ready, next)
			}
		}
	}
	if visited != len(degree) {
		return operationError("GRAPH_CONNECTION_CYCLE", "连线形成循环，请调整连接方向。")
	}
	return nil
}
