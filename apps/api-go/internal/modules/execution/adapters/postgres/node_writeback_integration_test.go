package postgres_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

const managedGraph = `{"nodes":[{"id":"source","type":"rh-text","data":{"text":"reference"}},{"id":"target","type":"rh-text","data":{"prompt":"original"}}],"edges":[{"id":"edge","source":"source","target":"target"}]}`

func setManagedGraph(t *testing.T, f historyInputFixture, graph string) int64 {
	t.Helper()
	var revision int64
	if err := f.pool.QueryRow(f.ctx, `UPDATE public.projects SET graph=$1,revision=revision+1 WHERE id='input-project' RETURNING revision`, json.RawMessage(graph)).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}
func managedTask(t *testing.T, f historyInputFixture, graph string, revision int64) domain.Task {
	t.Helper()
	now := time.Now().UTC()
	project := "input-project"
	task := domain.Task{ID: "managed-" + uuid.NewString(), OwnerID: "input-owner", ProjectID: &project, Kind: "CANVAS", TargetType: "NODE", TargetID: "target", State: "QUEUED", Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(graph), ExpectedRevision: &revision, Plans: []domain.Plan{{NodeID: "target", ExecutionID: "execution-" + uuid.NewString(), State: "QUEUED", TestMode: true, NodeSnapshot: json.RawMessage(`{"id":"target","type":"rh-text","data":{"prompt":"original"}}`), Request: json.RawMessage(`{}`)}}}
	got, err := f.store.Create(f.ctx, task, uuid.NewString(), strings.Repeat("e", 64), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !got.CanvasManaged || got.Plans[0].CanvasBinding == nil {
		t.Fatal("missing managed receipt")
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token='05764324-02f4-4125-9501-4b441fce3f18',lease_until=now()+interval '60 seconds' WHERE id=$1`, got.ID); err != nil {
		t.Fatal(err)
	}
	return got
}
func finishManaged(t *testing.T, f historyInputFixture, task domain.Task) domain.Task {
	t.Helper()
	text := "server result"
	task.State = "SUCCEEDED"
	task.Plans[0].State = "SUCCEEDED"
	task.Plans[0].Outputs = []domain.Output{{ID: "output-" + uuid.NewString(), Type: "TEXT", Text: &text, TestMode: true}}
	if ok, err := f.store.Save(f.ctx, task, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil || !ok {
		t.Fatal("save", ok, err)
	}
	got, err := f.store.Get(f.ctx, task.OwnerID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	return got
}
func managedData(t *testing.T, f historyInputFixture) (map[string]any, int64) {
	t.Helper()
	var raw []byte
	var rev int64
	if err := f.pool.QueryRow(f.ctx, `SELECT graph,revision FROM public.projects WHERE id='input-project'`).Scan(&raw, &rev); err != nil {
		t.Fatal(err)
	}
	var graph struct {
		Nodes []struct {
			ID   string
			Data map[string]any
		}
	}
	if err := json.Unmarshal(raw, &graph); err != nil {
		t.Fatal(err)
	}
	for _, node := range graph.Nodes {
		if node.ID == "target" {
			return node.Data, rev
		}
	}
	return nil, rev
}
func currentManagedGraph(t *testing.T, f historyInputFixture) (string, int64) {
	t.Helper()
	var raw []byte
	var rev int64
	if err := f.pool.QueryRow(f.ctx, `SELECT graph,revision FROM public.projects WHERE id='input-project'`).Scan(&raw, &rev); err != nil {
		t.Fatal(err)
	}
	return string(raw), rev
}

func TestPostgresCanvasManagedWritebackWithoutBrowser(t *testing.T) {
	f := newHistoryInputFixture(t)
	revision := setManagedGraph(t, f, managedGraph)
	task := managedTask(t, f, managedGraph, revision)
	data, accepted := managedData(t, f)
	if data["status"] != "processing" || data["taskId"] != task.ID || accepted <= revision {
		t.Fatal("acceptance not projected")
	}
	// Ordinary client writes cannot forge the running task identity or completion.
	graph, _ := currentManagedGraph(t, f)
	graph = strings.ReplaceAll(graph, `"processing"`, `"finished"`)
	graph = strings.ReplaceAll(graph, task.ID, "forged-task")
	setManagedGraph(t, f, graph)
	data, _ = managedData(t, f)
	if data["status"] != "processing" || data["taskId"] != task.ID {
		t.Fatal("client forged managed status")
	}
	task.State = "RUNNING"
	task.Plans[0].State = "RUNNING"
	if ok, e := f.store.Save(f.ctx, task, "05764324-02f4-4125-9501-4b441fce3f18"); e != nil || !ok {
		t.Fatal(e)
	}
	got := finishManaged(t, f, task)
	data, finished := managedData(t, f)
	if got.Plans[0].CanvasBinding.ApplicationState != "APPLIED" || data["status"] != "finished" || data["text"] != "[TEST MODE] server result" || finished <= accepted {
		t.Fatal("background result was not durably applied", got.Plans[0].CanvasBinding, data)
	}
	if data["historyStorage"] == nil || len(data["output"].([]any)) != 1 {
		t.Fatal("missing durable history reference")
	}
	var events int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM canvas.project_events WHERE project_id='input-project'`).Scan(&events); err != nil || events < 3 {
		t.Fatal("missing transactional canvas invalidation", events, err)
	}
}

func TestPostgresMeasuredProgressSurvivesRestartAndUpdatesCanvasWithoutInputChanges(t *testing.T) {
	f := newHistoryInputFixture(t)
	revision := setManagedGraph(t, f, managedGraph)
	task := managedTask(t, f, managedGraph, revision)
	data, _ := managedData(t, f)
	if data["progress"] != nil || data["progressDetail"] != nil {
		t.Fatal("new task inherited an estimate")
	}
	value := .5
	task.State = "RUNNING"
	task.Plans[0].State = "RUNNING"
	task.Plans[0].Progress = &value
	task.Plans[0].ProgressDetail = &domain.ProgressDetail{Phase: "sampling", Scope: "SAMPLING"}
	if ok, err := f.store.Save(f.ctx, task, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	data, observed := managedData(t, f)
	if data["progress"] != float64(50) || data["progressDetail"].(map[string]any)["scope"] != "SAMPLING" {
		t.Fatal("actual sampler progress not projected", data)
	}
	reloaded, err := f.store.Get(f.ctx, task.OwnerID, task.ID)
	if err != nil || reloaded.Plans[0].Progress == nil || *reloaded.Plans[0].Progress != .5 {
		t.Fatal("persisted task lost progress", err)
	}
	if ok, err := f.store.Save(f.ctx, reloaded, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	_, duplicate := managedData(t, f)
	if duplicate != observed {
		t.Fatal("duplicate observation changed canvas revision")
	}
	reloaded.Plans[0].Progress = nil
	reloaded.Plans[0].ProgressDetail = &domain.ProgressDetail{Phase: "decoding", Scope: "SAMPLING"}
	if ok, err := f.store.Save(f.ctx, reloaded, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	data, decoded := managedData(t, f)
	if data["progress"] != nil || data["progressDetail"].(map[string]any)["phase"] != "decoding" || decoded <= observed {
		t.Fatal("phase did not clear sampler percentage", data)
	}
	current, err := f.store.Get(f.ctx, task.OwnerID, task.ID)
	if err != nil || current.Plans[0].CanvasBinding.ApplicationState != "PENDING" {
		t.Fatal("presentation update detached valid input", err, current.Plans[0].CanvasBinding)
	}
	finished := finishManaged(t, f, current)
	data, _ = managedData(t, f)
	if finished.Plans[0].CanvasBinding.ApplicationState != "APPLIED" || data["progress"] != float64(100) {
		t.Fatal("valid task could not finish after progress updates", data)
	}
}
func TestPostgresCanvasManagedStaleInputsAndLifecycle(t *testing.T) {
	for _, scenario := range []string{"move", "resize", "native-timing", "nested-timing", "unrelated", "prompt", "source", "edge", "undo", "delete", "recreate"} {
		t.Run(scenario, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			revision := setManagedGraph(t, f, managedGraph)
			task := managedTask(t, f, managedGraph, revision)
			graph, _ := currentManagedGraph(t, f)
			switch scenario {
			case "move":
				graph = strings.ReplaceAll(graph, `"id": "target"`, `"id": "target", "position":{"x":300,"y":400}`)
			case "resize":
				graph = strings.ReplaceAll(graph, `"prompt": "original"`, `"prompt": "original", "width":640,"height":800,"opResize":true`)
			case "native-timing":
				graph = strings.ReplaceAll(graph, `"prompt": "original"`, `"prompt": "original", "estimateTaskId":"native-task","generationStartedAt":1791297866546,"estimatedSeconds":120`)
			case "nested-timing":
				graph = strings.ReplaceAll(graph, `"prompt": "original"`, `"prompt": "original", "params":{"estimatedSeconds":120}`)
			case "unrelated":
				graph = strings.Replace(graph, `"nodes": [`, `"nodes": [{"id":"unrelated","type":"rh-text","data":{"text":"new"}},`, 1)
			case "prompt":
				graph = strings.ReplaceAll(graph, "original", "changed")
			case "source":
				graph = strings.ReplaceAll(graph, "reference", "changed")
			case "edge":
				graph = strings.ReplaceAll(graph, `"id": "edge"`, `"id": "edge", "conditioningRole":"FIRST_FRAME"`)
			case "undo":
				setManagedGraph(t, f, strings.ReplaceAll(graph, "original", "changed"))
			case "delete":
				graph = `{"nodes":[],"edges":[]}`
			case "recreate":
				setManagedGraph(t, f, `{"nodes":[],"edges":[]}`)
			}
			setManagedGraph(t, f, graph)
			if scenario == "native-timing" {
				data, _ := managedData(t, f)
				if data["taskId"] != task.ID || data["status"] != "processing" {
					t.Fatal("native timing detached or impersonated active task", data)
				}
			}
			got := finishManaged(t, f, task)
			data, _ := managedData(t, f)
			if scenario == "move" || scenario == "resize" || scenario == "native-timing" || scenario == "unrelated" {
				if got.Plans[0].CanvasBinding.ApplicationState != "APPLIED" {
					t.Fatal("presentation/unrelated edit detached", got.Plans[0].CanvasBinding)
				}
			} else {
				if got.Plans[0].CanvasBinding.ApplicationState != "DETACHED" {
					t.Fatal("stale task overwrote changed graph", scenario)
				}
				if data != nil && data["text"] == "[TEST MODE] server result" {
					t.Fatal("stale output entered graph")
				}
				if len(got.Plans[0].Outputs) != 1 {
					t.Fatal("detached history lost")
				}
			}
		})
	}
}
func TestPostgresCanvasManagedRevisionSupersessionAndCancel(t *testing.T) {
	f := newHistoryInputFixture(t)
	revision := setManagedGraph(t, f, managedGraph)
	first := managedTask(t, f, managedGraph, revision)
	copy := first
	copy.ID = "stale-" + uuid.NewString()
	copy.ExpectedRevision = &revision
	if _, e := f.store.Create(f.ctx, copy, uuid.NewString(), strings.Repeat("c", 64), nil); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("stale acceptance", e)
	}
	graph, revision := currentManagedGraph(t, f)
	second := managedTask(t, f, graph, revision)
	first = finishManaged(t, f, first)
	data, _ := managedData(t, f)
	if first.Plans[0].CanvasBinding.Reason != "SUPERSEDED" || data["taskId"] != second.ID || data["status"] != "processing" {
		t.Fatal("older result stole newer binding")
	}
	// An unclaimed managed task can be canceled, atomically clearing its spinner.
	if _, e := f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token=NULL,lease_until=NULL WHERE id=$1`, second.ID); e != nil {
		t.Fatal(e)
	}
	canceled, e := f.store.Cancel(f.ctx, "input-owner", second.ID)
	if e != nil {
		t.Fatal(e)
	}
	data, _ = managedData(t, f)
	if canceled.State != "CANCELED" || canceled.Plans[0].CanvasBinding.ApplicationState != "APPLIED" || data["status"] != "idle" {
		t.Fatal("cancel did not reach canvas")
	}
}

func TestPostgresCanvasManagedFailureAndAssetProjection(t *testing.T) {
	for _, state := range []string{"FAILED", "ASSET", "ASSET_DELETED", "PARENT_DELETED"} {
		t.Run(state, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			revision := setManagedGraph(t, f, managedGraph)
			task := managedTask(t, f, managedGraph, revision)
			task.State = "SUCCEEDED"
			task.Plans[0].State = "SUCCEEDED"
			asset := "input-old-image"
			task.Plans[0].Outputs = []domain.Output{{ID: "asset-output", Type: "ASSET", AssetID: &asset, MimeType: "image/png", TestMode: true}}
			if state == "FAILED" {
				task.State = "FAILED"
				task.Plans[0].State = "FAILED"
				code := "PROVIDER_UNAVAILABLE"
				task.Plans[0].ErrorCode = &code
				task.Plans[0].Outputs = nil
			}
			if state == "ASSET_DELETED" {
				if _, e := f.pool.Exec(f.ctx, `UPDATE public.assets SET deleted_at=now() WHERE id='input-old-image'`); e != nil {
					t.Fatal(e)
				}
			}
			if state == "PARENT_DELETED" {
				if _, e := f.pool.Exec(f.ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='input-project'`); e != nil {
					t.Fatal(e)
				}
			}
			if ok, e := f.store.Save(f.ctx, task, "05764324-02f4-4125-9501-4b441fce3f18"); e != nil || !ok {
				t.Fatal("terminal write", ok, e)
			}
			data, _ := managedData(t, f)
			if state == "ASSET_DELETED" {
				got, e := f.store.Get(f.ctx, "input-owner", task.ID)
				if e != nil || got.State != "SUCCEEDED" || got.Plans[0].CanvasBinding.Reason != "OUTPUT_UNAVAILABLE" || got.Plans[0].Outputs[0].DeletedAt == nil || data["output"] != nil {
					t.Fatal("deleted imported asset blocked final task or entered canvas", e)
				}
			}
			if state == "FAILED" {
				if data["status"] != "failed" || data["errorMsg"] != "PROVIDER_UNAVAILABLE" {
					t.Fatal("failure not projected", data)
				}
			}
			if state == "ASSET" {
				outputs := data["output"].([]any)
				o := outputs[0].(map[string]any)
				if o["url"] != "rhtv-asset:input-old-image" || o["assetId"] != "input-old-image" || o["outputType"] != "image/png" {
					t.Fatal("asset projection not stable", o)
				}
			}
			if state == "PARENT_DELETED" {
				var taskState, binding string
				if e := f.pool.QueryRow(f.ctx, `SELECT state,payload->'task'->'plans'->0->'canvasBinding'->>'applicationState' FROM execution.tasks WHERE id=$1`, task.ID).Scan(&taskState, &binding); e != nil || taskState != "CANCELED" || binding != "DETACHED" {
					t.Fatal("deleted parent result resurrected", taskState, binding, e)
				}
			}
		})
	}
}

func TestPostgresCanvasNodeVersionLargeGraph(t *testing.T) {
	f := newHistoryInputFixture(t)
	nodes := make([]any, 10000)
	edges := make([]any, 0, 19997)
	for i := range nodes {
		id := fmt.Sprintf("n%d", i)
		nodes[i] = map[string]any{"id": id, "type": "rh-text", "data": map[string]any{"text": "x"}}
		for j := 1; j <= 2 && j <= i; j++ {
			edges = append(edges, map[string]string{"source": fmt.Sprintf("n%d", i-j), "target": id})
		}
	}
	graph := map[string]any{"nodes": nodes, "edges": edges}
	raw, _ := json.Marshal(graph)
	if len(raw) > 2<<20 {
		t.Fatal("large fixture exceeded canvas bound", len(raw))
	}
	start := time.Now()
	setManagedGraph(t, f, string(raw))
	first := time.Since(start)
	nodes[5000].(map[string]any)["data"] = map[string]any{"text": "changed"}
	raw, _ = json.Marshal(graph)
	start = time.Now()
	setManagedGraph(t, f, string(raw))
	elapsed := time.Since(start)
	var changed int
	if e := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM canvas.node_versions WHERE project_id='input-project' AND version=2`).Scan(&changed); e != nil || changed != 1 {
		t.Fatal("large graph version diff incorrect", changed, e)
	}
	t.Logf("10000 nodes / %d edges / %d bytes: initial %s, single edit %s", len(edges), len(raw), first, elapsed)
	if first > 10*time.Second || elapsed > 10*time.Second {
		t.Fatal("canvas lifecycle trigger too slow")
	}
}

func TestPostgresCanvasManagedDeletedInputDetachesResult(t *testing.T) {
	for _, kind := range []string{"history", "asset", "source-project"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			asset := "input-old-image"
			source := f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "selected-output", Type: "ASSET", AssetID: &asset}})
			graph := historyGraph(`"selectedHistoryOutputId":"selected-output"`)
			revision := setManagedGraph(t, f, string(graph))
			task, e := f.service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "target", Graph: graph, ExpectedRevision: &revision})
			if e != nil {
				t.Fatal(e)
			}
			if !task.CanvasManaged {
				t.Fatal("public service did not opt into writeback")
			}
			if _, e = f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token='05764324-02f4-4125-9501-4b441fce3f18',lease_until=now()+interval '60 seconds' WHERE id=$1`, task.ID); e != nil {
				t.Fatal(e)
			}
			switch kind {
			case "history":
				if _, e = f.store.DeleteOutput(f.ctx, "input-owner", source.Plans[0].ExecutionID, "selected-output", source.Revision); e != nil {
					t.Fatal(e)
				}
			case "asset":
				if _, e = f.pool.Exec(f.ctx, `UPDATE public.assets SET deleted_at=now() WHERE id='input-old-image'`); e != nil {
					t.Fatal(e)
				}
			case "source-project":
				if _, e = f.pool.Exec(f.ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='input-media-project'`); e != nil {
					t.Fatal(e)
				}
			}
			got := finishManaged(t, f, task)
			data, _ := managedData(t, f)
			if got.Plans[0].CanvasBinding.ApplicationState != "DETACHED" || got.Plans[0].CanvasBinding.Reason != "INPUT_UNAVAILABLE" || data["text"] == "[TEST MODE] server result" {
				t.Fatal("deleted input published result", got.Plans[0].CanvasBinding)
			}
		})
	}
}

func TestPostgresMediaTaskWritesVideoWithoutBrowser(t *testing.T) {
	f := newHistoryInputFixture(t)
	graph := `{"nodes":[{"id":"target","type":"rh-video","data":{"localVideoEdit":true}}],"edges":[]}`
	rev := setManagedGraph(t, f, graph)
	now := time.Now().UTC()
	project := "input-project"
	task := domain.Task{ID: "media-" + uuid.NewString(), OwnerID: "input-owner", ProjectID: &project, Kind: "MEDIA", TargetType: "NODE", TargetID: "target", State: "QUEUED", Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(graph), ExpectedRevision: &rev, Plans: []domain.Plan{{NodeID: "target", ExecutionID: "media-exe-" + uuid.NewString(), State: "QUEUED", TestMode: true, CapabilityRef: "local-ffmpeg", CapabilityVersion: "1", Input: json.RawMessage(`{}`)}}}
	task, err := f.store.Create(f.ctx, task, uuid.NewString(), strings.Repeat("a", 64), nil)
	if err != nil || !task.CanvasManaged {
		t.Fatal("media binding", err)
	}
	_, err = f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token='05764324-02f4-4125-9501-4b441fce3f18',lease_until=now()+interval '60 seconds' WHERE id=$1`, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	current, _ := currentManagedGraph(t, f)
	current = strings.Replace(current, `"localVideoEdit": true`, `"localVideoEdit": true,"localVideoEditTaskId":"`+task.ID+`"`, 1)
	setManagedGraph(t, f, current)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES('media-output','input-owner','input-project','clip.mp4','VIDEO','video/mp4',4,repeat('c',64),'READY')`)
	if err != nil {
		t.Fatal(err)
	}
	asset := "media-output"
	task.State = "SUCCEEDED"
	task.Plans[0].State = "SUCCEEDED"
	task.Plans[0].Outputs = []domain.Output{{ID: "video-output", Type: "ARTIFACT", AssetID: &asset, MimeType: "video/mp4", TestMode: true}}
	if ok, err := f.store.Save(f.ctx, task, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil || !ok {
		t.Fatal("media finish", err)
	}
	data, _ := managedData(t, f)
	if data["videoUrl"] != "rhtv-asset:media-output" || data["status"] != "finished" {
		t.Fatal("media result not applied", data)
	}
}
