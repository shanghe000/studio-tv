package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/domain"
	app "studiotv.local/service/api/internal/modules/longform/application"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type Store struct{ Pool *pgxpool.Pool }

func New(p *pgxpool.Pool) *Store { return &Store{p} }

const columns = `id::text,actor_id,owner_id,canvas_id,node_id,coalesce(remote_id::text,''),coalesce(snapshot,'null'::jsonb),create_body,node_version,node_incarnation`

func scan(r pgx.Row) (b app.Binding, e error) {
	e = r.Scan(&b.ID, &b.ActorID, &b.StorageOwnerID, &b.CanvasID, &b.NodeID, &b.RemoteID, &b.Snapshot, &b.CreateBody, &b.NodeVersion, &b.NodeIncarnation)
	if errors.Is(e, pgx.ErrNoRows) {
		e = httpapi.Fail(404, "LONGFORM_NOT_FOUND", "长片不存在。")
	}
	return
}
func bad() error {
	return httpapi.Fail(400, "LONGFORM_INVALID", "长片参数或画布绑定无效。")
}
func conflict() error {
	return httpapi.Fail(409, "LONGFORM_CONFLICT", "长片内容已变化，请重新载入后操作。")
}
func (s *Store) access(ctx context.Context, tx pgx.Tx, c app.Caller, canvas, node string, write bool) (string, json.RawMessage, error) {
	role := "VIEWER"
	if write {
		role = "EDITOR"
	}
	scope, e := collaboration.RequireProject(ctx, tx, c.Identity.UserID, canvas, role, write)
	if e != nil {
		return "", nil, e
	}
	if write {
		if _, e = collaboration.CheckProjectEditSession(ctx, tx, canvas, c.Identity, c.ClientID, true); e != nil {
			return "", nil, e
		}
	}
	var raw json.RawMessage
	if e = tx.QueryRow(ctx, `SELECT graph FROM public.projects WHERE id=$1`, canvas).Scan(&raw); e != nil {
		return "", nil, e
	}
	if write && node != "" {
		var active bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM execution.tasks t WHERE t.project_id=$1 AND t.state IN ('QUEUED','RUNNING') AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'task'->'plans') p WHERE p->>'nodeId'=$2))`, canvas, node).Scan(&active); e != nil {
			return "", nil, e
		}
		if active {
			return "", nil, httpapi.Fail(409, "LONGFORM_NODE_BUSY", "此视频节点已有生成任务，请等待完成后继续。")
		}
	}
	if node != "" {
		var g struct{ Nodes []struct{ ID, Type string } }
		if json.Unmarshal(raw, &g) != nil {
			return "", nil, bad()
		}
		found := false
		for _, n := range g.Nodes {
			if n.ID == node && n.Type == "rh-video" {
				found = true
			}
		}
		if !found {
			return "", nil, httpapi.Fail(404, "LONGFORM_NODE_NOT_FOUND", "绑定的视频节点不存在。")
		}
	}
	return scope.StorageOwnerID, raw, nil
}
func (s *Store) Get(ctx context.Context, actor, id string, write bool) (app.Binding, error) {
	if _, e := uuid.Parse(id); e != nil {
		return app.Binding{}, httpapi.Fail(404, "LONGFORM_NOT_FOUND", "长片不存在。")
	}
	b, e := scan(s.Pool.QueryRow(ctx, `SELECT `+columns+` FROM longform.projects WHERE id=$1 AND actor_id=$2`, id, actor))
	if e != nil {
		return b, e
	}
	role := "VIEWER"
	if write {
		role = "EDITOR"
	}
	_, e = collaboration.RequireProject(ctx, s.Pool, actor, b.CanvasID, role, false)
	return b, e
}
func (s *Store) List(ctx context.Context, actor, canvas, node string) ([]app.Binding, error) {
	if _, e := collaboration.RequireProject(ctx, s.Pool, actor, canvas, "VIEWER", false); e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, `SELECT `+columns+` FROM longform.projects WHERE actor_id=$1 AND canvas_id=$2 AND ($3='' OR node_id=$3) ORDER BY created_at`, actor, canvas, node)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	bs := []app.Binding{}
	for rows.Next() {
		b, e := scan(rows)
		if e != nil {
			return nil, e
		}
		bs = append(bs, b)
	}
	return bs, rows.Err()
}
func (s *Store) PrepareCreate(ctx context.Context, c app.Caller, in app.Create, hash string) (app.Binding, app.Request, error) {
	var b app.Binding
	var r app.Request
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return b, r, e
	}
	defer tx.Rollback(ctx)
	owner, graph, e := s.access(ctx, tx, c, in.CanvasID, in.NodeID, true)
	if e != nil {
		return b, r, e
	}
	// Same actor and request can safely replay after a disconnected response.
	b, e = scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM longform.projects WHERE id=$1`, in.RequestID))
	if e == nil {
		if b.ActorID != c.Identity.UserID || b.CanvasID != in.CanvasID || b.NodeID != in.NodeID {
			return b, r, conflict()
		}
		r, e = readRequest(ctx, tx, b.ID, in.RequestID, hash)
		return b, r, e
	}
	var api *httpapi.Error
	if !errors.As(e, &api) || api.Status != 404 {
		return b, r, e
	}
	var existing string
	e = tx.QueryRow(ctx, `SELECT id::text FROM longform.projects WHERE canvas_id=$1 AND node_id=$2`, in.CanvasID, in.NodeID).Scan(&existing)
	if e == nil {
		return b, r, conflict()
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return b, r, e
	}
	b = app.Binding{ID: in.RequestID, ActorID: c.Identity.UserID, StorageOwnerID: owner, CanvasID: in.CanvasID, NodeID: in.NodeID}
	if e = tx.QueryRow(ctx, `SELECT version,incarnation FROM canvas.node_versions WHERE project_id=$1 AND node_id=$2 AND present`, b.CanvasID, b.NodeID).Scan(&b.NodeVersion, &b.NodeIncarnation); e != nil {
		return b, r, e
	}
	// Insert binding first so its scoped grants have an immutable parent.
	original, _ := json.Marshal(in)
	_, e = tx.Exec(ctx, `INSERT INTO longform.projects(id,actor_id,owner_id,canvas_id,node_id,create_body,node_version,node_incarnation)VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, b.ID, b.ActorID, owner, b.CanvasID, b.NodeID, original, b.NodeVersion, b.NodeIncarnation)
	if e != nil {
		return b, r, e
	}
	refs, e := prepareReferences(ctx, tx, b, in.References, in.RequestID, graph)
	if e != nil {
		return b, r, e
	}
	var body map[string]json.RawMessage
	_ = json.Unmarshal(original, &body)
	delete(body, "canvasId")
	delete(body, "nodeId")
	body["references"], _ = json.Marshal(refs)
	b.CreateBody, _ = json.Marshal(body)
	_, e = tx.Exec(ctx, `UPDATE longform.projects SET create_body=$2 WHERE id=$1`, b.ID, b.CreateBody)
	if e != nil {
		return b, r, e
	}
	r = app.Request{ID: in.RequestID, Hash: hash, ProjectID: b.ID, Body: b.CreateBody}
	_, e = tx.Exec(ctx, `INSERT INTO longform.requests(project_id,request_id,request_hash,body)VALUES($1,$2,$3,$4)`, b.ID, r.ID, hash, r.Body)
	if e != nil {
		return b, r, e
	}
	_, e = tx.Exec(ctx, `UPDATE canvas.node_execution_bindings SET application_state='DETACHED',reason='LONGFORM_ATTACHED' WHERE project_id=$1 AND node_id=$2 AND state IN ('SUCCEEDED','FAILED','CANCELED')`, b.CanvasID, b.NodeID)
	if e != nil {
		return b, r, e
	}
	return b, r, tx.Commit(ctx)
}
func readRequest(ctx context.Context, tx pgx.Tx, project, id, hash string) (r app.Request, e error) {
	r.ProjectID, r.ID = project, id
	var code string
	var status int
	e = tx.QueryRow(ctx, `SELECT request_hash,body,coalesce(response,'null'::jsonb),coalesce(rejected_code,''),coalesce(rejected_status,0) FROM longform.requests WHERE project_id=$1 AND request_id=$2`, project, id).Scan(&r.Hash, &r.Body, &r.Response, &code, &status)
	if e != nil {
		return r, e
	}
	if r.Hash != hash {
		return r, conflict()
	}
	if code != "" {
		return r, &gateway.Fault{Code: code, HTTPStatus: status}
	}
	if string(r.Response) == "null" {
		r.Response = nil
	}
	return
}
func (s *Store) PrepareAction(ctx context.Context, c app.Caller, id string, raw json.RawMessage, hash string) (app.Binding, app.Request, error) {
	b, e := s.Get(ctx, c.Identity.UserID, id, true)
	var r app.Request
	if e != nil {
		return b, r, e
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return b, r, e
	}
	defer tx.Rollback(ctx)
	_, graph, e := s.access(ctx, tx, c, b.CanvasID, b.NodeID, true)
	if e != nil {
		return b, r, e
	}
	var incarnation, version int64
	if e = tx.QueryRow(ctx, `SELECT incarnation,version FROM canvas.node_versions WHERE project_id=$1 AND node_id=$2 AND present`, b.CanvasID, b.NodeID).Scan(&incarnation, &version); e != nil {
		return b, r, httpapi.Fail(409, "LONGFORM_NODE_CHANGED", "原视频节点已删除或重建，请使用新节点创建长片。")
	}
	if incarnation != b.NodeIncarnation {
		return b, r, httpapi.Fail(409, "LONGFORM_NODE_CHANGED", "原视频节点已删除或重建，请使用新节点创建长片。")
	}
	_, e = tx.Exec(ctx, `UPDATE longform.projects SET node_version=$2 WHERE id=$1`, b.ID, version)
	if e != nil {
		return b, r, e
	}
	b.NodeVersion = version
	var body map[string]json.RawMessage
	if json.Unmarshal(raw, &body) != nil {
		return b, r, bad()
	}
	var canvas string
	if v := body["canvasId"]; v != nil {
		if json.Unmarshal(v, &canvas) != nil || canvas != b.CanvasID {
			return b, r, bad()
		}
	}
	delete(body, "canvasId")
	var reqID string
	_ = json.Unmarshal(body["requestId"], &reqID)
	r, e = readRequest(ctx, tx, b.ID, reqID, hash)
	if e == nil {
		return b, r, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return b, r, e
	}
	if b.RemoteID == "" {
		return b, r, httpapi.Retry(409, "LONGFORM_PENDING", "长片仍在创建，请稍后继续。")
	}
	// Freeze authorization and reference content before handing a request off.
	if v := body["patch"]; v != nil {
		var patch map[string]json.RawMessage
		if json.Unmarshal(v, &patch) != nil {
			return b, r, bad()
		}
		if patch == nil {
			return b, r, bad()
		}
		for key := range patch {
			switch key {
			case "title", "settings", "commonPrompt", "segments", "references":
			default:
				return b, r, bad()
			}
		}

		if v := patch["references"]; v != nil {
			var refs []app.Reference
			if json.Unmarshal(v, &refs) != nil {
				return b, r, bad()
			}
			prepared, e := prepareReferences(ctx, tx, b, refs, reqID, graph)
			if e != nil {
				return b, r, e
			}
			patch["references"], _ = json.Marshal(prepared)
		}
		body["patch"], _ = json.Marshal(patch)
	}
	if v := body["references"]; v != nil {
		var refs []app.Reference
		if json.Unmarshal(v, &refs) != nil {
			return b, r, bad()
		}
		prepared, e := prepareReferences(ctx, tx, b, refs, reqID, graph)
		if e != nil {
			return b, r, e
		}
		body["references"], _ = json.Marshal(prepared)
	}
	// Recheck all previously frozen source grants before any further execution.
	var effective map[string]json.RawMessage
	_ = json.Unmarshal(b.CreateBody, &effective)
	currentRefs := effective["references"]
	if body["references"] != nil {
		currentRefs = body["references"]
	}
	if patchRaw := body["patch"]; patchRaw != nil {
		var patch map[string]json.RawMessage
		_ = json.Unmarshal(patchRaw, &patch)
		if patch["references"] != nil {
			currentRefs = patch["references"]
		}
	}
	var frozen []struct {
		Attachment gateway.Attachment `json:"attachment"`
	}
	_ = json.Unmarshal(currentRefs, &frozen)
	sourceIDs := []string{}
	for _, ref := range frozen {
		sourceIDs = append(sourceIDs, ref.Attachment.SourceRef)
	}
	if e = collaboration.AuthorizeProjectAssets(ctx, tx, b.ActorID, b.CanvasID, sourceIDs); e != nil {
		return b, r, e
	}
	_, e = tx.Exec(ctx, `UPDATE longform.read_grants SET expires_at=now()+interval '24 hours' WHERE project_id=$1`, b.ID)
	if e != nil {
		return b, r, e
	}
	// STUDIO's editor patch envelope is not part of the native cloud contract.
	// Persist the exact flattened, authorized cloud request for safe replay.
	if patchRaw := body["patch"]; patchRaw != nil {
		var patch map[string]json.RawMessage
		_ = json.Unmarshal(patchRaw, &patch)
		delete(body, "patch")
		for key, value := range patch {
			body[key] = value
		}
	}
	r = app.Request{ID: reqID, ProjectID: b.ID, Hash: hash}
	r.Body, _ = json.Marshal(body)
	_, e = tx.Exec(ctx, `INSERT INTO longform.requests(project_id,request_id,request_hash,body)VALUES($1,$2,$3,$4)`, b.ID, reqID, hash, r.Body)
	if e != nil {
		return b, r, e
	}
	return b, r, tx.Commit(ctx)
}
func prepareReferences(ctx context.Context, tx pgx.Tx, b app.Binding, refs []app.Reference, request string, graph json.RawMessage) ([]map[string]any, error) {
	if e := app.ValidateReferences(refs); e != nil {
		return nil, e
	}
	allowed := directAssets(graph, b.NodeID)
	ids := []string{}
	for _, r := range refs {
		if !allowed[r.AssetID] {
			return nil, httpapi.Fail(422, "LONGFORM_REFERENCE_UNBOUND", "参考素材必须来自当前视频节点的直接连线或明确附件。")
		}
		ids = append(ids, r.AssetID)
	}
	if e := collaboration.AuthorizeProjectAssets(ctx, tx, b.ActorID, b.CanvasID, ids); e != nil {
		return nil, e
	}
	out := []map[string]any{}
	for i, r := range refs {
		var kind, mime, checksum string
		var size int64
		e := tx.QueryRow(ctx, `SELECT kind,mime_type,checksum_sha256,byte_size FROM public.assets WHERE id=$1 AND state='READY' AND deleted_at IS NULL FOR SHARE`, r.AssetID).Scan(&kind, &mime, &checksum, &size)
		if e != nil {
			return nil, httpapi.Fail(404, "ASSET_NOT_FOUND", "参考素材不可用。")
		}
		if kind != r.Kind || size < 1 || kind == "IMAGE" && size > 10<<20 || kind == "VIDEO" && size > 64<<20 || kind == "AUDIO" && size > 16<<20 || kind != "IMAGE" && kind != "VIDEO" && kind != "AUDIO" {
			return nil, httpapi.Fail(422, "LONGFORM_REFERENCE_INVALID", "参考素材类型或大小不支持。")
		}
		grant := "lfg_" + uuid.NewSHA1(uuid.NameSpaceOID, []byte(b.ID+"/"+request+"/"+fmt.Sprint(i)+"/"+r.AssetID)).String()
		_, e = tx.Exec(ctx, `INSERT INTO longform.read_grants(id,project_id,actor_id,asset_id,source_version,checksum_sha256,expires_at)VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours') ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at`, grant, b.ID, b.ActorID, r.AssetID, "sha256:"+checksum, checksum)
		if e != nil {
			return nil, e
		}
		row := map[string]any{"kind": r.Kind, "attachment": gateway.Attachment{Ref: fmt.Sprintf("lfref_%d", i+1), SourceRef: r.AssetID, Kind: r.Kind, SourceVersion: "sha256:" + checksum, SHA256: checksum, ReadGrantRef: grant}}
		if r.Role != "" {
			row["role"] = r.Role
		}
		if r.VideoIndex != nil {
			row["videoIndex"] = *r.VideoIndex
		}
		out = append(out, row)
	}
	return out, nil
}

// Asset discovery never traverses through generated media into its provenance.
func directAssets(raw json.RawMessage, target string) map[string]bool {
	var g struct {
		Nodes []struct {
			ID   string
			Data map[string]json.RawMessage
		}
		Edges []struct{ Source, Target string }
	}
	result := map[string]bool{}
	if json.Unmarshal(raw, &g) != nil {
		return result
	}
	sources := map[string]bool{}
	for _, e := range g.Edges {
		if e.Target == target {
			sources[e.Source] = true
		}
	}
	var visit func(any)
	visit = func(v any) {
		switch x := v.(type) {
		case string:
			if strings.HasPrefix(x, "rhtv-asset:") {
				result[strings.TrimPrefix(x, "rhtv-asset:")] = true
			} else if strings.HasPrefix(x, "ast_") {
				result[x] = true
			}
		case []any:
			for _, a := range x {
				visit(a)
			}
		case map[string]any:
			for _, key := range []string{"url", "assetId", "id"} {
				if a, ok := x[key]; ok {
					visit(a)
				}
			}
		}
	}
	for _, n := range g.Nodes {
		if n.ID == target {
			var v any
			_ = json.Unmarshal(n.Data["mentionAssets"], &v)
			visit(v)
			continue
		}
		if !sources[n.ID] {
			continue
		}
		for _, key := range []string{"output", "sourceObjects", "assetId", "assetIds", "imageUrl", "videoUrl", "audioUrl"} {
			var v any
			_ = json.Unmarshal(n.Data[key], &v)
			visit(v)
		}
	}
	return result
}
func (s *Store) PendingRequests(ctx context.Context, b app.Binding) ([]app.Request, error) {
	rows, e := s.Pool.Query(ctx, `SELECT request_id::text,request_hash,body FROM longform.requests WHERE project_id=$1 AND response IS NULL AND rejected_code IS NULL ORDER BY created_at,request_id`, b.ID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []app.Request{}
	for rows.Next() {
		r := app.Request{ProjectID: b.ID}
		if e = rows.Scan(&r.ID, &r.Hash, &r.Body); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Store) Pending(ctx context.Context) ([]app.Binding, error) {
	rows, e := s.Pool.Query(ctx, `SELECT `+columns+` FROM longform.projects p WHERE EXISTS(SELECT 1 FROM longform.requests r WHERE r.project_id=p.id AND r.response IS NULL AND r.rejected_code IS NULL) OR (snapshot->>'activeJobId' IS NOT NULL AND snapshot->>'activeJobId'<>'') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(snapshot->'jobs','[]'::jsonb)) j WHERE j->>'status' IN ('QUEUED','RUNNING','SUBMITTING','COMPOSING','UNKNOWN')) ORDER BY updated_at LIMIT 50`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	bs := []app.Binding{}
	for rows.Next() {
		b, e := scan(rows)
		if e != nil {
			return nil, e
		}
		bs = append(bs, b)
	}
	return bs, rows.Err()
}
func (s *Store) Save(ctx context.Context, b app.Binding, raw json.RawMessage, archived []app.Archived, req *app.Request) (app.Binding, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return b, e
	}
	defer tx.Rollback(ctx)
	if _, e = collaboration.RequireProject(ctx, tx, b.ActorID, b.CanvasID, "EDITOR", true); e != nil {
		return b, e
	}
	// Older concurrent GETs cannot roll the stored cloud revision backwards.
	var previous json.RawMessage
	e = tx.QueryRow(ctx, `SELECT coalesce(snapshot,'{}'::jsonb) FROM longform.projects WHERE id=$1 AND actor_id=$2 FOR UPDATE`, b.ID, b.ActorID).Scan(&previous)
	if e != nil {
		return b, e
	}
	var old, cur map[string]any
	_ = json.Unmarshal(previous, &old)
	_ = json.Unmarshal(raw, &cur)
	if number(cur["revision"]) < number(old["revision"]) {
		raw = previous
		cur = old
	}
	_, e = tx.Exec(ctx, `UPDATE longform.projects SET remote_id=$2,snapshot=$3,updated_at=now() WHERE id=$1`, b.ID, b.RemoteID, raw)
	if e != nil {
		return b, e
	}
	if req != nil {
		var request map[string]json.RawMessage
		if json.Unmarshal(req.Body, &request) == nil {
			var typ string
			_ = json.Unmarshal(request["type"], &typ)
			if typ == "updateDraft" {
				if refs := request["references"]; refs != nil {
					_, e = tx.Exec(ctx, `UPDATE longform.projects SET create_body=jsonb_set(create_body,'{references}',$2::jsonb) WHERE id=$1`, b.ID, refs)
					if e != nil {
						return b, e
					}
				}
			}
		}

		_, e = tx.Exec(ctx, `UPDATE longform.requests SET response=$3 WHERE project_id=$1 AND request_id=$2 AND request_hash=$4`, b.ID, req.ID, raw, req.Hash)
		if e != nil {
			return b, e
		}
	}
	for _, a := range archived {
		_, e = tx.Exec(ctx, `INSERT INTO longform.artifacts(project_id,artifact_id,asset_id,composition)VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, b.ID, a.ArtifactID, a.Asset.ID, a.Composition)
		if e != nil {
			return b, e
		}
		if e = saveHistory(ctx, tx, b, a, raw); e != nil {
			return b, e
		}
	}
	if e = writeCanvas(ctx, tx, b, cur); e != nil {
		return b, e
	}
	b.Snapshot = raw
	if e = tx.QueryRow(ctx, `SELECT create_body,node_version,node_incarnation FROM longform.projects WHERE id=$1`, b.ID).Scan(&b.CreateBody, &b.NodeVersion, &b.NodeIncarnation); e != nil {
		return b, e
	}
	return b, tx.Commit(ctx)
}
func number(v any) float64 { n, _ := v.(float64); return n }
func saveHistory(ctx context.Context, tx pgx.Tx, b app.Binding, a app.Archived, raw json.RawMessage) error {
	// Completed imports participate in the existing generation history reader;
	// they are never runnable queue entries and never invoke a model again.
	id := "tsk_lf_" + strings.ReplaceAll(a.ArtifactID, "-", "")
	exe := "exe_lf_" + strings.ReplaceAll(a.ArtifactID, "-", "")
	output := execution.Output{ID: "out_lf_" + strings.ReplaceAll(a.ArtifactID, "-", ""), Type: "ASSET", AssetID: &a.Asset.ID, MimeType: a.Asset.MimeType, Width: a.Asset.Width, Height: a.Asset.Height, DurationMs: a.Asset.DurationMs}
	now := time.Now().UTC()
	task := execution.Task{ID: id, ProjectID: &b.CanvasID, Kind: "CANVAS", TargetType: "NODE", TargetID: b.NodeID, Name: "H3 分段长片", State: "SUCCEEDED", Revision: 1, Plans: []execution.Plan{{NodeID: b.NodeID, ExecutionID: exe, State: "SUCCEEDED", CapabilityRef: "h3-sgun-longform-v1", CapabilityVersion: "1", Parameters: raw, Outputs: []execution.Output{output}}}, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(`{"nodes":[],"edges":[]}`)}
	payload, _ := json.Marshal(map[string]any{"task": task, "private": []any{map[string]any{}}, "initiatedBy": b.ActorID})
	sum := sha256.Sum256(payload)
	tag, e := tx.Exec(ctx, `INSERT INTO execution.tasks(id,owner_id,project_id,kind,state,request_hash,idempotency_key,payload,initiated_by)VALUES($1,$2,$3,'CANVAS','SUCCEEDED',$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`, id, b.StorageOwnerID, b.CanvasID, hex.EncodeToString(sum[:]), a.ArtifactID, payload, b.ActorID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	if _, e = tx.Exec(ctx, `INSERT INTO execution.task_assets(task_id,owner_id,asset_id,direction)VALUES($1,$2,$3,'OUTPUT')`, id, b.StorageOwnerID, a.Asset.ID); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO execution.history_revisions(owner_id,project_id,node_id)VALUES($1,$2,$3) ON CONFLICT(owner_id,project_id,node_id)DO UPDATE SET revision=nextval('execution.history_sequence')`, b.StorageOwnerID, b.CanvasID, b.NodeID)
	return e
}
func writeCanvas(ctx context.Context, tx pgx.Tx, b app.Binding, state map[string]any) error {
	var matching bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM longform.projects l JOIN canvas.node_versions v ON v.project_id=l.canvas_id AND v.node_id=l.node_id WHERE l.id=$1 AND v.present AND v.version=l.node_version AND v.incarnation=l.node_incarnation AND NOT EXISTS(SELECT 1 FROM execution.tasks t WHERE t.project_id=l.canvas_id AND t.state IN ('QUEUED','RUNNING') AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'task'->'plans') p WHERE p->>'nodeId'=l.node_id)))`, b.ID).Scan(&matching); e != nil {
		return e
	}
	if !matching {
		return nil
	}

	var raw json.RawMessage
	if e := tx.QueryRow(ctx, `SELECT graph FROM public.projects WHERE id=$1`, b.CanvasID).Scan(&raw); e != nil {
		return e
	}
	var graph map[string]any
	if json.Unmarshal(raw, &graph) != nil {
		return bad()
	}
	nodes, _ := graph["nodes"].([]any)
	changed := false
	for _, v := range nodes {
		n, _ := v.(map[string]any)
		if n["id"] != b.NodeID || n["type"] != "rh-video" {
			continue
		}
		data, _ := n["data"].(map[string]any)
		if data == nil {
			data = map[string]any{}
			n["data"] = data
		}
		bound, _ := data["studioLongformProjectId"].(string)
		if bound != "" && bound != b.ID {
			continue
		}
		data["studioLongformProjectId"] = b.ID
		data["studioLongformRevision"] = state["revision"]
		data["studioLongformActiveJobId"] = state["activeJobId"]
		comps, _ := state["compositions"].([]any)
		if len(comps) > 0 {
			last, _ := comps[len(comps)-1].(map[string]any)
			if asset, ok := last["assetId"].(string); ok && asset != "" {
				url := "rhtv-asset:" + asset
				artifact, _ := last["artifactId"].(string)
				outputID := "out_lf_" + strings.ReplaceAll(artifact, "-", "")
				data["output"] = []any{map[string]any{"url": url, "assetId": asset, "type": "ASSET", "outputType": "video/mp4", "mimeType": "video/mp4", "historyOutputId": outputID, "outputId": outputID}}
				data["historyStorage"] = map[string]any{"source": "remote", "schemaVersion": 1, "historyId": "exe_lf_" + strings.ReplaceAll(artifact, "-", ""), "revision": "1", "resultCount": 1}
				delete(data, "selectedHistoryOutputId")
				delete(data, "selectedOutputHistoryId")
				delete(data, "selectedOutputHistoryIndex")

				data["videoUrl"] = url
				data["status"] = "finished"
			}
		}
		changed = true
	}
	if !changed {
		return nil
	}
	out, _ := json.Marshal(graph)
	if string(out) == string(raw) {
		return nil
	}
	_, e := tx.Exec(ctx, `UPDATE public.projects SET graph=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND graph IS DISTINCT FROM $2::jsonb`, b.CanvasID, out)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `UPDATE longform.projects l SET node_version=v.version FROM canvas.node_versions v WHERE l.id=$1 AND v.project_id=l.canvas_id AND v.node_id=l.node_id AND v.present AND v.incarnation=l.node_incarnation`, b.ID)
	return e
}

var _ app.Repository = (*Store)(nil)

func (s *Store) Reject(ctx context.Context, b app.Binding, r app.Request, code string, status int) error {
	if b.RemoteID == "" {
		_, e := s.Pool.Exec(ctx, `DELETE FROM longform.projects WHERE id=$1 AND actor_id=$2 AND remote_id IS NULL`, b.ID, b.ActorID)
		return e
	}
	_, e := s.Pool.Exec(ctx, `UPDATE longform.requests SET rejected_code=$3,rejected_status=$4 WHERE project_id=$1 AND request_id=$2 AND response IS NULL`, b.ID, r.ID, code, status)
	return e
}
