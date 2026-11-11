package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type canvasAcceptance struct {
	graph    json.RawMessage
	guard    string
	versions map[string]int64
}

func prepareCanvasBinding(ctx context.Context, tx pgx.Tx, t *domain.Task) (*canvasAcceptance, error) {
	if t.ExpectedRevision == nil {
		return nil, nil
	}
	if (t.Kind != "CANVAS" && t.Kind != "MEDIA") || t.ProjectID == nil || t.TargetType != "NODE" || len(t.Plans) != 1 || t.Plans[0].NodeID != t.TargetID {
		return nil, domain.ErrInvalid
	}
	var graph json.RawMessage
	var revision, orderChanged int64
	err := tx.QueryRow(ctx, `SELECT graph,revision,last_node_order_changed_revision FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND internal_kind IS NULL FOR UPDATE`, *t.ProjectID, t.OwnerID).Scan(&graph, &revision, &orderChanged)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if *t.ExpectedRevision < 1 || revision < *t.ExpectedRevision || orderChanged > *t.ExpectedRevision {
		return nil, domain.ErrConflict
	}
	guard, ids, err := domain.CanvasGuard(graph, t.TargetID)
	if err != nil {
		return nil, err
	}
	requested, _, err := domain.CanvasGuard(t.Snapshot, t.TargetID)
	if err != nil || requested != guard {
		return nil, domain.ErrConflict
	}
	versions, lastChanged, err := readNodeVersionEvidence(ctx, tx, *t.ProjectID, t.OwnerID, ids)
	if err != nil {
		return nil, err
	}
	// A higher project revision may belong to another node or measured progress.
	// The private change boundary also rejects change-and-undo, same-ID node
	// recreation, changed incoming edges and reuse of an accepted target receipt.
	if len(versions) != len(ids) || lastChanged > *t.ExpectedRevision {
		return nil, domain.ErrConflict
	}
	if t.Kind == "MEDIA" {
		var saved domain.Graph
		if json.Unmarshal(graph, &saved) != nil {
			return nil, domain.ErrInvalid
		}
		for _, raw := range saved.Nodes {
			var node domain.Node
			if json.Unmarshal(raw, &node) != nil {
				return nil, domain.ErrInvalid
			}
			if node.ID == t.TargetID {
				if node.Type != "rh-video" && node.Type != "rh-audio" {
					return nil, domain.ErrInvalid
				}
				t.Plans[0].NodeSnapshot = raw
			}
		}
	}
	t.CanvasManaged = true
	t.Plans[0].CanvasBinding = &domain.CanvasBinding{ApplicationState: "PENDING"}
	return &canvasAcceptance{graph, guard, versions}, nil
}

func readNodeVersions(ctx context.Context, tx pgx.Tx, project, owner string, ids []string) (map[string]int64, error) {
	versions, _, err := readNodeVersionEvidence(ctx, tx, project, owner, ids)
	return versions, err
}

func readNodeVersionEvidence(ctx context.Context, tx pgx.Tx, project, owner string, ids []string) (map[string]int64, int64, error) {
	versions := map[string]int64{}
	var lastChanged int64
	rows, err := tx.Query(ctx, `SELECT node_id,version,last_changed_project_revision FROM canvas.node_versions WHERE project_id=$1 AND owner_id=$2 AND present AND node_id=ANY($3::text[])`, project, owner, ids)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var v, changed int64
		if err = rows.Scan(&id, &v, &changed); err != nil {
			return nil, 0, err
		}
		versions[id] = v
		if changed > lastChanged {
			lastChanged = changed
		}
	}
	return versions, lastChanged, rows.Err()
}

func attachCanvasBinding(ctx context.Context, tx pgx.Tx, t domain.Task, a *canvasAcceptance) error {
	if a == nil {
		return nil
	}
	p := t.Plans[0]
	versions, _ := json.Marshal(a.versions)
	_, err := tx.Exec(ctx, `INSERT INTO canvas.node_execution_bindings(project_id,owner_id,node_id,task_id,execution_id,node_version,input_versions,input_guard,state,application_state)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING') ON CONFLICT(project_id,node_id) DO UPDATE SET
 owner_id=EXCLUDED.owner_id,task_id=EXCLUDED.task_id,execution_id=EXCLUDED.execution_id,node_version=EXCLUDED.node_version,
 input_versions=EXCLUDED.input_versions,input_guard=EXCLUDED.input_guard,state=EXCLUDED.state,application_state='PENDING',reason=NULL,updated_at=now()`,
		*t.ProjectID, t.OwnerID, p.NodeID, t.ID, p.ExecutionID, a.versions[p.NodeID], versions, a.guard, p.State)
	if err != nil {
		return err
	}
	graph, err := patchCanvasNode(a.graph, p.NodeID, map[string]any{"taskId": t.ID, "status": "processing", "errorMsg": "", "testMode": t.TestMode, "progress": nil, "progressDetail": nil})
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('rhtv.canvas_executor',$1,true)`, t.ID); err != nil {
		return err
	}
	var acceptedRevision int64
	if err = tx.QueryRow(ctx, `UPDATE public.projects SET graph=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING revision`, *t.ProjectID, t.OwnerID, graph).Scan(&acceptedRevision); err != nil {
		return err
	}
	// Claiming a target consumes this saved receipt, even though task/status are
	// presentation fields and must not invalidate this task's own input versions.
	_, err = tx.Exec(ctx, `UPDATE canvas.node_versions SET last_changed_project_revision=GREATEST(last_changed_project_revision,$3) WHERE project_id=$1 AND node_id=$2`, *t.ProjectID, p.NodeID, acceptedRevision)
	return err
}

func patchCanvasNode(raw json.RawMessage, id string, patch map[string]any) (json.RawMessage, error) {
	var graph map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&graph) != nil {
		return nil, domain.ErrInvalid
	}
	nodes, ok := graph["nodes"].([]any)
	if !ok {
		return nil, domain.ErrInvalid
	}
	found := false
	for _, v := range nodes {
		n, ok := v.(map[string]any)
		if !ok {
			return nil, domain.ErrInvalid
		}
		if n["id"] != id {
			continue
		}
		data, ok := n["data"].(map[string]any)
		if !ok {
			data = map[string]any{}
			n["data"] = data
		}
		for k, v := range patch {
			data[k] = v
		}
		found = true
	}
	if !found {
		return nil, domain.ErrNotFound
	}
	return json.Marshal(graph)
}

func nodeTaskMatches(raw json.RawMessage, node, task string) bool {
	var g struct {
		Nodes []struct {
			ID   string
			Data map[string]json.RawMessage
		}
	}
	if json.Unmarshal(raw, &g) != nil {
		return false
	}
	for _, n := range g.Nodes {
		if n.ID == node {
			var id string
			_ = json.Unmarshal(n.Data["taskId"], &id)
			return id == task
		}
	}
	return false
}

// Called inside Save/Cancel's task transaction. A task and its result can never
// commit without the same graph, binding and project-event decision.
func applyCanvasBinding(ctx context.Context, tx pgx.Tx, t *domain.Task) error {
	if !t.CanvasManaged {
		return nil
	}
	if t.ProjectID == nil || len(t.Plans) != 1 {
		return domain.ErrInvalid
	}
	p := &t.Plans[0]
	if domain.Terminal(t.State) && !domain.Terminal(p.State) {
		p.State = t.State
	}
	var graph json.RawMessage
	var deleted *time.Time
	err := tx.QueryRow(ctx, `SELECT graph,deleted_at FROM public.projects WHERE id=$1 AND owner_id=$2 AND internal_kind IS NULL FOR UPDATE`, *t.ProjectID, t.OwnerID).Scan(&graph, &deleted)
	if err != nil {
		return err
	}
	var task, execution, state, app, guard string
	var version int64
	var rawVersions json.RawMessage
	var reason *string
	err = tx.QueryRow(ctx, `SELECT task_id,execution_id,node_version,input_versions,input_guard,state,application_state,reason FROM canvas.node_execution_bindings WHERE project_id=$1 AND owner_id=$2 AND node_id=$3 FOR UPDATE`, *t.ProjectID, t.OwnerID, p.NodeID).Scan(&task, &execution, &version, &rawVersions, &guard, &state, &app, &reason)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (task != t.ID || execution != p.ExecutionID) {
		p.CanvasBinding = &domain.CanvasBinding{ApplicationState: "DETACHED", Reason: "SUPERSEDED"}
		return nil
	}
	if err != nil {
		return err
	}
	if app != "PENDING" {
		p.CanvasBinding = &domain.CanvasBinding{ApplicationState: app}
		if reason != nil {
			p.CanvasBinding.Reason = *reason
		}
		if state != p.State {
			if _, err = tx.Exec(ctx, `UPDATE canvas.node_execution_bindings SET state=$4,updated_at=now() WHERE project_id=$1 AND node_id=$2 AND task_id=$3`, *t.ProjectID, p.NodeID, t.ID, p.State); err != nil {
				return err
			}
			if deleted == nil {
				_, err = tx.Exec(ctx, `UPDATE public.projects SET revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2`, *t.ProjectID, t.OwnerID)
			}
		}
		return err
	}
	why := ""
	if deleted != nil {
		why = "PARENT_DELETED"
	} else {
		current, ids, e := domain.CanvasGuard(graph, p.NodeID)
		if e != nil {
			why = "NODE_DELETED"
		} else if current != guard {
			why = "NODE_CHANGED"
		} else {
			var expected map[string]int64
			if json.Unmarshal(rawVersions, &expected) != nil {
				return domain.ErrInvalid
			}
			actual, e := readNodeVersions(ctx, tx, *t.ProjectID, t.OwnerID, ids)
			if e != nil {
				return e
			}
			if len(actual) != len(expected) {
				why = "NODE_CHANGED"
			}
			for id, v := range expected {
				if actual[id] != v {
					why = "NODE_CHANGED"
				}
			}
		}
	}
	// Historical deletion and asset/source-project deletion do not necessarily
	// edit the canvas. Revalidate them before publishing a generated result.
	if why == "" && (p.State == "SUCCEEDED" || imageBatchPlan(*p) && domain.Terminal(p.State) && len(p.Outputs) > 0) {
		if p.HistoryDeletedAt != nil || len(p.Outputs) == 0 {
			why = "OUTPUT_UNAVAILABLE"
		}
		for _, o := range p.Outputs {
			if o.DeletedAt != nil {
				why = "OUTPUT_UNAVAILABLE"
			}
		}
		if e := validateHistoryInputs(ctx, tx, *t); e != nil {
			if errors.Is(e, domain.ErrNotFound) || errors.Is(e, domain.ErrConflict) {
				why = "INPUT_UNAVAILABLE"
			} else {
				return e
			}
		}
		for _, ref := range p.InputReferences {
			if ref.AssetID != "" {
				if e := validateInputAsset(ctx, tx, t.OwnerID, ref.AssetID, ref.AssetVersion); e != nil {
					if errors.Is(e, domain.ErrNotFound) || errors.Is(e, domain.ErrConflict) {
						why = "INPUT_UNAVAILABLE"
					} else {
						return e
					}
				}
			}
		}
	}
	if why != "" {
		p.CanvasBinding = &domain.CanvasBinding{ApplicationState: "DETACHED", Reason: why}
		if deleted == nil && nodeTaskMatches(graph, p.NodeID, t.ID) {
			graph, err = patchCanvasNode(graph, p.NodeID, map[string]any{"status": "idle", "taskId": "", "progress": nil, "progressDetail": nil})
			if err != nil {
				return err
			}
		}
	} else {
		p.CanvasBinding = &domain.CanvasBinding{ApplicationState: "PENDING"}
		if state == p.State && canvasProgressMatches(graph, *p) {
			return nil
		}
		patch := map[string]any{"taskId": t.ID, "status": "processing", "errorMsg": "", "testMode": t.TestMode || p.TestMode}
		for key, value := range canvasProgressPatch(*p) {
			patch[key] = value
		}
		if domain.Terminal(p.State) {
			p.CanvasBinding.ApplicationState = "APPLIED"
		}
		switch p.State {
		case "FAILED":
			patch["status"] = "failed"
			if p.ErrorCode != nil {
				patch["errorMsg"] = *p.ErrorCode
				if message, known := gateway.OfficialVideoErrorMessage(*p.ErrorCode); known {
					patch["errorMsg"] = message
				}
				if message, known := domain.MediaErrorMessage(*p.ErrorCode, p.ErrorMessage); known {
					patch["errorMsg"] = message
				}
			}
		case "CANCELED":
			patch["status"] = "idle"
		case "SUCCEEDED":
			outputs, e := nativeCanvasOutputs(p.Outputs, t.TestMode || p.TestMode)
			if e != nil {
				return e
			}
			patch["status"] = "finished"
			patch["output"] = outputs
			patch["historyStorage"] = map[string]any{"source": "remote", "schemaVersion": 1, "historyId": p.ExecutionID, "revision": strconv.FormatInt(t.Revision, 10), "resultCount": len(outputs)}
			if len(outputs) > 0 {
				first := outputs[0]
				if text, ok := first["text"]; ok {
					patch["text"] = text
					patch["content"] = text
				}
				if data, ok := first["data"]; ok {
					patch["structuredOutput"] = data
				}
				if u, ok := first["url"]; ok {
					var n domain.Node
					_ = json.Unmarshal(p.NodeSnapshot, &n)
					if n.Type == "rh-video" {
						patch["videoUrl"] = u
					}
					if n.Type == "rh-audio" {
						patch["audioUrl"] = u
					}
				}
			}
		}
		next, e := patchCanvasNode(graph, p.NodeID, patch)
		if e != nil {
			return e
		}
		next, projectionReason, e := projectImageBatch(next, t.ID, *p, t.TestMode || p.TestMode)
		if e != nil {
			return e
		}
		if len(next) > 2<<20 {
			projectionReason = "RESULT_TOO_LARGE"
		}
		if projectionReason != "" {
			p.CanvasBinding = &domain.CanvasBinding{ApplicationState: "DETACHED", Reason: projectionReason}
			graph, err = patchCanvasNode(graph, p.NodeID, map[string]any{"status": "idle", "taskId": "", "progress": nil, "progressDetail": nil})
			if err != nil {
				return err
			}
		} else {
			graph = next
		}
	}
	if deleted == nil {
		if _, err = tx.Exec(ctx, `SELECT set_config('rhtv.canvas_executor',$1,true)`, t.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE public.projects SET graph=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2`, *t.ProjectID, t.OwnerID, graph); err != nil {
			return err
		}
		if p.CanvasBinding.ApplicationState != "DETACHED" {
			if err = tx.QueryRow(ctx, `SELECT version FROM canvas.node_versions WHERE project_id=$1 AND node_id=$2`, *t.ProjectID, p.NodeID).Scan(&version); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
	}
	_, err = tx.Exec(ctx, `UPDATE canvas.node_execution_bindings SET state=$4,application_state=$5,reason=NULLIF($6,''),node_version=$7,updated_at=now() WHERE project_id=$1 AND node_id=$2 AND task_id=$3`, *t.ProjectID, p.NodeID, t.ID, p.State, p.CanvasBinding.ApplicationState, p.CanvasBinding.Reason, version)
	return err
}

func canvasProgressPatch(plan domain.Plan) map[string]any {
	var percent any
	if plan.Progress != nil {
		percent = *plan.Progress * 100
	}
	detail := plan.ProgressDetail
	if plan.State == "SUCCEEDED" {
		percent = 100.0
		detail = &domain.ProgressDetail{Phase: "completed", Scope: "TASK"}
	}
	return map[string]any{"progress": percent, "progressDetail": detail}
}

func planProgressChanged(before, after domain.Plan) bool {
	return !reflect.DeepEqual(before.Progress, after.Progress) || !reflect.DeepEqual(before.ProgressDetail, after.ProgressDetail)
}

func canvasProgressMatches(raw json.RawMessage, plan domain.Plan) bool {
	var graph struct {
		Nodes []struct {
			ID   string
			Data map[string]json.RawMessage
		}
	}
	if json.Unmarshal(raw, &graph) != nil {
		return false
	}
	for _, node := range graph.Nodes {
		if node.ID != plan.NodeID {
			continue
		}
		for key, expected := range canvasProgressPatch(plan) {
			var value, want any
			body, err := json.Marshal(expected)
			if err != nil || json.Unmarshal(body, &want) != nil {
				return false
			}
			if field := node.Data[key]; len(field) > 0 && json.Unmarshal(field, &value) != nil {
				return false
			}
			if !reflect.DeepEqual(value, want) {
				return false
			}
		}
		return true
	}
	return false
}

func nativeCanvasOutputs(outputs []domain.Output, test bool) ([]map[string]any, error) {
	result := []map[string]any{}
	for _, o := range outputs {
		v := map[string]any{"outputId": o.ID, "testMode": test || o.TestMode}
		switch o.Type {
		case "TEXT":
			if o.Text == nil {
				return nil, domain.ErrInvalid
			}
			text := *o.Text
			if test || o.TestMode {
				text = "[TEST MODE] " + text
			}
			v["outputType"] = "text"
			v["text"] = text
		case "STRUCTURED":
			if !json.Valid(o.Data) {
				return nil, domain.ErrInvalid
			}
			v["outputType"] = "structured"
			v["schemaVersion"] = o.SchemaVersion
			v["data"] = o.Data
		case "ASSET", "ARTIFACT": // Local MEDIA jobs import owned assets under the legacy ARTIFACT label.
			if o.AssetID == nil {
				return nil, domain.ErrInvalid
			}
			v["assetId"] = *o.AssetID
			v["mediaId"] = *o.AssetID
			v["url"] = "rhtv-asset:" + *o.AssetID
			v["originalUrl"] = v["url"]
			v["thumbnailUrl"] = v["url"]
			v["mimeType"] = o.MimeType
			v["outputType"] = o.MimeType
			if o.Width != nil {
				v["width"] = *o.Width
			}
			if o.Height != nil {
				v["height"] = *o.Height
			}
			if o.DurationMs != nil {
				v["durationMs"] = *o.DurationMs
			}
		default:
			return nil, domain.ErrInvalid
		}
		result = append(result, v)
	}
	return result, nil
}
