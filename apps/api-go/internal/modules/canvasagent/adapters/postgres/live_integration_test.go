package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/database"
	canvasPG "studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	organizationPG "studiotv.local/service/api/internal/modules/organization/adapters/postgres"
	organization "studiotv.local/service/api/internal/modules/organization/application"
	organizationDomain "studiotv.local/service/api/internal/modules/organization/domain"
	"studiotv.local/service/api/internal/testdb"
)

func liveDatabase(t *testing.T) (*pgxpool.Pool, context.Context, *application.LiveService) {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	for i := 0; i < 2; i++ {
		if err := database.Migrate(ctx, db); err != nil {
			t.Fatal("live event migration/replay failed", err)
		}
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('owner-a','live-a@example.test','A'),('owner-b','live-b@example.test','B')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,graph)VALUES('project_a','owner-a','A',$1),('project_b','owner-b','B',$1)`, json.RawMessage(initialCommandGraph)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,internal_kind)VALUES('vault','owner-a','Private','ASSET_VAULT')`); err != nil {
		t.Fatal(err)
	}
	service, err := application.NewLiveService(canvasPG.New(db))
	if err != nil {
		t.Fatal(err)
	}
	return db, ctx, service
}

func eventData(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		t.Fatal("event payload is not JSON")
	}
	return value
}

func TestPostgresProjectLiveSnapshotReplayAndAtomicLegacyEvents(t *testing.T) {
	db, ctx, service := liveDatabase(t)
	initial, err := service.Snapshot(ctx, "owner-a", "project_a")
	if err != nil || initial.GraphRevision != 1 || initial.EventCursor != "0" || !initial.NodeExecutionAvailable || initial.NodeStates == nil || len(initial.NodeStates) != 0 || initial.UpdatedAt.IsZero() || !strings.Contains(string(initial.Graph), "trusted-task") {
		t.Fatal("snapshot invented authoritative execution or lost persisted graph", initial, err)
	}
	// A graph writer forgetting revision still gets an atomic CAS advance and
	// invalidation. Revision-neutral metadata keeps its established behavior.
	if _, err = db.Exec(ctx, `UPDATE public.projects SET graph=jsonb_set(graph,'{nodes,1,data,text}','"legacy draft"'),updated_at=now() WHERE id='project_a'`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE public.projects SET name='Renamed',pinned=true,updated_at=now() WHERE id='project_a'`); err != nil {
		t.Fatal(err)
	}
	commands, _ := application.NewCommandService(canvasPG.NewCommandUnitOfWork(db), core.ValidateProductGraph)
	move := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":300,"y":400}}]}`)
	receipt, err := commands.Submit(ctx, "owner-a", "project_a", 2, uuid.NewString(), move)
	if err != nil || receipt.EventCursor != "2" || receipt.GraphRevision != 3 {
		t.Fatal("command duplicated/missed legacy event sequence", receipt, err)
	}
	store, _ := organizationPG.New(db)
	org, _ := organization.New(store)
	actor := organizationDomain.Actor{OwnerID: "owner-a"}
	input := organizationDomain.FolderInput{Name: "Folder"}
	mutation, _ := organization.Command(0, uuid.NewString(), input)
	folder, err := org.CreateFolder(ctx, actor, input, mutation)
	if err != nil {
		t.Fatal(err)
	}
	mutation, _ = organization.Command(3, uuid.NewString(), map[string]any{"folderId": folder.ID})
	if _, err = org.Move(ctx, actor, "project_a", &folder.ID, mutation); err != nil {
		t.Fatal("organization revision writer failed", err)
	}
	page, err := service.Events(ctx, "owner-a", "project_a", 0, 2)
	if err != nil || len(page.Events) != 2 || page.NextCursor != "2" || page.EventCursor != "3" || !page.HasMore {
		t.Fatal("bounded replay missed immutable head", page, err)
	}
	first, second := eventData(t, page.Events[0]), eventData(t, page.Events[1])
	if first["type"] != "canvas.invalidated" || first["data"].(map[string]any)["reason"] != "LEGACY_GRAPH_WRITE" || second["type"] != "canvas.changed" || second["data"].(map[string]any)["commandId"] != receipt.CommandID {
		t.Fatal("events do not describe real writer outcomes")
	}
	// Reconstruct services to prove replay survives process-local state loss.
	restarted, _ := application.NewLiveService(canvasPG.New(db))
	page, err = restarted.Events(ctx, "owner-a", "project_a", 2, 100)
	if err != nil || len(page.Events) != 1 || page.HasMore || page.NextCursor != "3" || eventData(t, page.Events[0])["data"].(map[string]any)["reason"] != "REVISION_ONLY" {
		t.Fatal("organization move did not durably advance project cursor", page, err)
	}
	if _, err = service.Events(ctx, "owner-a", "project_a", 4, 100); !errors.Is(err, domain.ErrEventCursorAhead) {
		t.Fatal("ahead cursor was accepted", err)
	}
	page, err = service.Events(ctx, "owner-a", "project_a", 3, 100)
	if err != nil || page.Events == nil || len(page.Events) != 0 || page.HasMore || page.NextCursor != "3" {
		t.Fatal("caught-up page incorrect", page, err)
	}
	for _, project := range []string{"project_b", "vault"} {
		if _, err = service.Snapshot(ctx, "owner-a", project); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("foreign/private graph published", err)
		}
		if _, err = service.Events(ctx, "owner-a", project, 0, 100); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("foreign/private events published", err)
		}
	}
	assertConstraint := func(query string) {
		t.Helper()
		_, err := db.Exec(ctx, query)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatal("event atomicity/cursor constraint missing", err)
		}
	}
	assertConstraint(`UPDATE public.projects SET event_sequence=event_sequence+1 WHERE id='project_a'`)
	assertConstraint(`UPDATE public.projects SET event_sequence=event_sequence+2 WHERE id='project_a'`)
	assertConstraint(`UPDATE public.projects SET revision=revision-1 WHERE id='project_a'`)
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE public.projects SET revision=revision+1 WHERE id='project_a'`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	unchanged, err := service.Snapshot(ctx, "owner-a", "project_a")
	if err != nil || unchanged.GraphRevision != 4 || unchanged.EventCursor != "3" {
		t.Fatal("failed writer persisted cursor or revision", unchanged, err)
	}
	// Bulk folder deletion is an existing project writer too. The evidence is
	// kept, while all public live reads stop returning deleted private content.
	folder, err = org.Folder(ctx, actor, folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	mutation, _ = organization.Command(folder.Revision, uuid.NewString(), nil)
	if _, err = org.DeleteFolder(ctx, actor, folder.ID, mutation); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Snapshot(ctx, "owner-a", "project_a"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted project graph leaked", err)
	}
	if _, err = service.Events(ctx, "owner-a", "project_a", 0, 100); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted project event history leaked", err)
	}
	var last json.RawMessage
	if db.QueryRow(ctx, `SELECT payload FROM canvas.project_events WHERE project_id='project_a' AND sequence=4`).Scan(&last) != nil || eventData(t, last)["data"].(map[string]any)["reason"] != "PROJECT_DELETED" {
		t.Fatal("folder bulk deletion was not atomic with evidence")
	}
}

func TestPostgresProjectLiveReadConcurrentCommittedState(t *testing.T) {
	db, ctx, service := liveDatabase(t)
	const writes = 40
	var writerErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 1; i <= writes; i++ {
			_, writerErr = db.Exec(ctx, `UPDATE public.projects SET graph=jsonb_set(graph,'{iteration}',to_jsonb($1::integer)),revision=revision+1,updated_at=now() WHERE id='project_a'`, i)
			if writerErr != nil {
				return
			}
		}
	}()
	for i := 0; i < writes; i++ {
		snapshot, err := service.Snapshot(ctx, "owner-a", "project_a")
		if err != nil {
			t.Fatal(err)
		}
		var graph struct{ Iteration int64 }
		if json.Unmarshal(snapshot.Graph, &graph) != nil || snapshot.GraphRevision != graph.Iteration+1 || snapshot.EventCursor != strconv.FormatInt(graph.Iteration, 10) {
			t.Fatal("snapshot combined different graph/head commits", snapshot)
		}
		page, err := service.Events(ctx, "owner-a", "project_a", 0, 100)
		if err != nil || page.HasMore || page.EventCursor != strconv.Itoa(len(page.Events)) || page.NextCursor != page.EventCursor {
			t.Fatal("event page observed head without its committed evidence", page, err)
		}
	}
	wg.Wait()
	if writerErr != nil {
		t.Fatal(writerErr)
	}
	final, err := service.Snapshot(ctx, "owner-a", "project_a")
	if err != nil || final.GraphRevision != writes+1 || final.EventCursor != strconv.Itoa(writes) {
		t.Fatal("concurrent writes lost evidence", final, err)
	}
}

func TestPostgresLiveNodeStateRequiresCurrentIncarnationAndMatchingTaskEvidence(t *testing.T) {
	db, ctx, service := liveDatabase(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	seedTask := func(id, owner, project string) {
		t.Helper()
		body := map[string]any{"task": map[string]any{"id": id, "projectId": project, "canvasManaged": true, "plans": []map[string]any{{"nodeId": "text", "executionId": "execution_text", "state": "RUNNING"}}}}
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO execution.tasks(id,owner_id,project_id,kind,state,request_hash,idempotency_key,payload)VALUES($1,$2,$3,'CANVAS','RUNNING',$4,$5,$6)`, id, owner, project, strings.Repeat("a", 64), uuid.NewString(), raw)
	}
	seedTask("current_task", "owner-a", "project_a")
	seedTask("foreign_task", "owner-b", "project_b")
	exec(`INSERT INTO public.projects(id,owner_id,name,graph)VALUES('other_project','owner-a','Other',$1)`, json.RawMessage(initialCommandGraph))
	seedTask("other_project_task", "owner-a", "other_project")
	exec(`INSERT INTO canvas.node_execution_bindings(project_id,owner_id,node_id,task_id,execution_id,node_version,input_versions,input_guard,state,application_state)
	 SELECT project_id,owner_id,node_id,'current_task','execution_text',version,'{}'::jsonb,$1,'RUNNING','PENDING'
	 FROM canvas.node_versions WHERE project_id='project_a' AND node_id='text'`, strings.Repeat("a", 64))
	snapshot, err := service.Snapshot(ctx, "owner-a", "project_a")
	if err != nil || !snapshot.NodeExecutionAvailable || len(snapshot.NodeStates) != 1 || snapshot.NodeStates[0].TaskID != "current_task" || snapshot.NodeStates[0].State != "RUNNING" || snapshot.NodeStates[0].ApplicationState != "PENDING" || !strings.Contains(string(snapshot.Graph), "trusted-task") {
		t.Fatal("live state was inferred from display fields or lost its real binding", snapshot, err)
	}
	assertEmpty := func(label string) {
		t.Helper()
		value, err := service.Snapshot(ctx, "owner-a", "project_a")
		if err != nil || !value.NodeExecutionAvailable || value.NodeStates == nil || len(value.NodeStates) != 0 {
			t.Fatal(label, "published stale or unrelated task evidence", value, err)
		}
	}
	_, foreignErr := db.Exec(ctx, `UPDATE canvas.node_execution_bindings SET task_id='foreign_task' WHERE project_id='project_a'`)
	var foreignConstraint *pgconn.PgError
	if !errors.As(foreignErr, &foreignConstraint) || foreignConstraint.Code != "23503" {
		t.Fatal("foreign task binding was not rejected by owner constraint", foreignErr)
	}
	exec(`UPDATE canvas.node_execution_bindings SET task_id='other_project_task' WHERE project_id='project_a'`)
	assertEmpty("other project task")
	exec(`UPDATE canvas.node_execution_bindings SET task_id='current_task',execution_id='unknown_execution' WHERE project_id='project_a'`)
	assertEmpty("unknown plan")
	exec(`UPDATE canvas.node_execution_bindings SET execution_id='execution_text',state='SUCCEEDED' WHERE project_id='project_a'`)
	assertEmpty("different plan state")
	exec(`UPDATE canvas.node_execution_bindings SET state='RUNNING',node_version=node_version+1 WHERE project_id='project_a'`)
	assertEmpty("different node incarnation")
	exec(`UPDATE canvas.node_execution_bindings SET node_version=node_version-1 WHERE project_id='project_a'`)
	exec(`UPDATE execution.tasks SET payload=jsonb_set(payload,'{task,canvasManaged}','false') WHERE id='current_task'`)
	assertEmpty("unmanaged legacy task")
	exec(`UPDATE execution.tasks SET payload=jsonb_set(payload,'{task,canvasManaged}','true') WHERE id='current_task'`)
	// A real input edit changes the private version while keeping the node ID.
	exec(`UPDATE public.projects SET graph=jsonb_set(graph,'{nodes,1,data,text}','"new input"'),updated_at=now() WHERE id='project_a'`)
	assertEmpty("edited node")
	// Deleting and recreating the ID cannot make its previous run current again.
	exec(`UPDATE public.projects SET graph=jsonb_set(graph,'{nodes}',jsonb_build_array(graph->'nodes'->0)),updated_at=now() WHERE id='project_a'`)
	assertEmpty("deleted node")
	exec(`UPDATE public.projects SET graph=$1,updated_at=now() WHERE id='project_a'`, json.RawMessage(initialCommandGraph))
	assertEmpty("recreated node")
	if _, err := service.Snapshot(ctx, "owner-b", "project_a"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("foreign owner could read binding state", err)
	}
}

func TestPostgresProjectEventByteBudgetAndOversizedCommand(t *testing.T) {
	db, ctx, service := liveDatabase(t)
	// Three legal events exceed one page's byte budget, regardless of limit.
	for sequence := 1; sequence <= 3; sequence++ {
		tx, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		at := time.Now().UTC().Truncate(time.Millisecond)
		event := map[string]any{"schemaVersion": "1", "projectId": "project_a", "sequence": strconv.Itoa(sequence), "occurredAt": at, "source": map[string]any{"kind": "API"}, "type": "canvas.changed", "data": map[string]any{"commandId": fmt.Sprintf("cmd_%d", sequence), "baseRevision": sequence, "graphRevision": sequence + 1, "delta": domain.GraphDelta{NodesUpsert: []map[string]any{{"id": "large", "data": map[string]any{"text": strings.Repeat("x", 700*1024)}}}, NodesRemoved: []string{}, EdgesUpsert: []map[string]any{}, EdgesRemoved: []string{}}}}
		raw, _ := json.Marshal(event)
		if _, err = tx.Exec(ctx, `UPDATE public.projects SET revision=revision+1,event_sequence=event_sequence+1 WHERE id='project_a'`); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO canvas.project_events(project_id,owner_id,sequence,type,payload,occurred_at)VALUES('project_a','owner-a',$1,'canvas.changed',$2,$3)`, sequence, raw, at); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	page, err := service.Events(ctx, "owner-a", "project_a", 0, 100)
	if err != nil || len(page.Events) != 2 || page.NextCursor != "2" || !page.HasMore || page.EventCursor != "3" {
		t.Fatal("replay did not enforce byte budget", len(page.Events), page, err)
	}
	var total int
	for _, raw := range page.Events {
		total += len(raw)
	}
	if total > domain.MaxEventPageBytes {
		t.Fatal("page exceeds transfer bound")
	}
	page, err = service.Events(ctx, "owner-a", "project_a", 2, 100)
	if err != nil || len(page.Events) != 1 || page.HasMore || page.NextCursor != "3" {
		t.Fatal("byte-bounded next page lost an event", err)
	}
	// A small typed move can include large preserved native data in its delta.
	// Persist a compact invalidation without losing its full command receipt.
	var largeGraph map[string]any
	_ = json.Unmarshal([]byte(initialCommandGraph), &largeGraph)
	largeData := largeGraph["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)
	largeData["nativePadding"] = ""
	compact, _ := json.Marshal(largeGraph)
	largeData["nativePadding"] = strings.Repeat("x", application.MaxCommandGraphBytes-len(compact))
	compact, _ = json.Marshal(largeGraph)
	if len(compact) != application.MaxCommandGraphBytes {
		t.Fatal("large graph fixture must fit the established command graph limit")
	}
	if _, err = db.Exec(ctx, `UPDATE public.projects SET graph=$1 WHERE id='project_b'`, json.RawMessage(compact)); err != nil {
		t.Fatal(err)
	}
	commands, _ := application.NewCommandService(canvasPG.NewCommandUnitOfWork(db), core.ValidateProductGraph)
	move := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":30,"y":40}}]}`)
	receipt, err := commands.Submit(ctx, "owner-b", "project_b", 2, uuid.NewString(), move)
	if err != nil || len(receipt.Delta.NodesUpsert) != 1 || receipt.EventCursor != "2" {
		t.Fatal("large preserved data lost command receipt", receipt.CommandID, err)
	}
	page, err = service.Events(ctx, "owner-b", "project_b", 1, 100)
	if err != nil || len(page.Events) != 1 {
		t.Fatal("oversized command event was not replayable", err)
	}
	large := eventData(t, page.Events[0])
	if large["type"] != "canvas.invalidated" || large["data"].(map[string]any)["reason"] != "DELTA_TOO_LARGE" || large["data"].(map[string]any)["commandId"] != receipt.CommandID || len(page.Events[0]) > 4096 {
		t.Fatal("oversized delta was not compacted honestly")
	}
	// Reserved node execution evidence cannot accidentally become public.
	tx, _ := db.Begin(ctx)
	at := time.Now().UTC().Truncate(time.Millisecond)
	bad := fmt.Sprintf(`{"schemaVersion":"1","projectId":"project_b","sequence":"3","occurredAt":%q,"source":{"kind":"API"},"type":"node.execution.changed","data":{"baseRevision":3,"graphRevision":3}}`, at.Format(time.RFC3339Nano))
	if _, err = tx.Exec(ctx, `UPDATE public.projects SET event_sequence=event_sequence+1 WHERE id='project_b'`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO canvas.project_events(project_id,owner_id,sequence,type,payload,occurred_at)VALUES('project_b','owner-b',3,'node.execution.changed',$1,$2)`, json.RawMessage(bad), at); err != nil || tx.Commit(ctx) != nil {
		t.Fatal("reserved evidence fixture failed", err)
	}
	if _, err = service.Events(ctx, "owner-b", "project_b", 2, 100); !errors.Is(err, domain.ErrLiveUnavailable) {
		t.Fatal("unimplemented node execution event published", err)
	}
}
