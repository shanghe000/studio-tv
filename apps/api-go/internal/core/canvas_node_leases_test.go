package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	canvasPG "studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	canvas "studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/testdb"
)

const nodeLeaseProject = "prj_node_lease"
const nodeLeaseGraph = `{"schemaVersion":"1","nodes":[{"id":"n1","type":"rh-text","position":{"x":0,"y":0},"data":{"title":"First","text":"Existing first input"}},{"id":"n2","type":"rh-text","position":{"x":200,"y":0},"data":{"title":"Second","text":"Existing second input"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`

type nodeLeaseWriteFixture struct {
	db       *pgxpool.Pool
	ctx      context.Context
	router   http.Handler
	presence *collaboration.PresenceService
	owner    httpapi.Identity
	editor   httpapi.Identity
	joined   map[[3]string]bool
}

// This fixture uses the authenticated production core HTTP route and a real,
// randomly named test database. It never contacts a model or a live service.
func newNodeLeaseWriteFixture(t *testing.T) *nodeLeaseWriteFixture {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('usr_a','lease-owner@example.test','Owner'),('usr_b','lease-editor@example.test','Editor')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,graph)VALUES($1,'usr_a','Node lease fixture',$2)`, nodeLeaseProject, json.RawMessage(nodeLeaseGraph)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO collaboration.project_members(project_id,user_id,role,created_by)VALUES($1,'usr_b','EDITOR','usr_a')`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	owner, editor := integrationPrincipal("usr_a"), integrationPrincipal("usr_b")
	owner.AccessExpiresAt, owner.SessionExpiresAt = time.Now().Add(time.Hour), time.Now().Add(time.Hour)
	editor.AccessExpiresAt, editor.SessionExpiresAt = owner.AccessExpiresAt, owner.SessionExpiresAt
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		switch r.Header.Get("Authorization") {
		case "Bearer usr_a":
			return owner, nil
		case "Bearer usr_b":
			return editor, nil
		default:
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture identity unavailable")
		}
	})
	cfg := testConfig(t)
	cfg.FFprobePath, cfg.ChromiumSandboxMode = "ffprobe", "sandbox"
	router, err := NewWithAuthorization(cfg, db, auth, authorization.New(&integrationRuntime{}, "cli_test", &integrationSessions{}))
	if err != nil {
		t.Fatal(err)
	}
	presence, err := collaboration.NewPresenceService(db)
	if err != nil {
		t.Fatal(err)
	}
	return &nodeLeaseWriteFixture{db: db, ctx: ctx, router: router, presence: presence, owner: owner, editor: editor, joined: map[[3]string]bool{}}
}

func (f *nodeLeaseWriteFixture) acquire(t *testing.T, id httpapi.Identity, page string, nodes ...string) {
	t.Helper()
	client := [3]string{id.UserID, id.SessionID, page}
	// Acquiring another node in the same live page does not require another
	// heartbeat. Preserve the production heartbeat rate limit in this fixture.
	if !f.joined[client] {
		if _, err := f.presence.Heartbeat(f.ctx, id, nodeLeaseProject, page, nil, nodes); err != nil {
			t.Fatal(err)
		}
		f.joined[client] = true
	}
	if _, err := f.presence.Acquire(f.ctx, id, nodeLeaseProject, page, nodes); err != nil {
		t.Fatal(err)
	}
}

type nodeLeaseWriteState struct {
	Graph                       string
	Revision, Sequence          int64
	Events, Receipts, TaskCount int
}

func (f *nodeLeaseWriteFixture) state(t *testing.T) nodeLeaseWriteState {
	t.Helper()
	var state nodeLeaseWriteState
	if err := f.db.QueryRow(f.ctx, `SELECT graph::text,revision,event_sequence,
 (SELECT count(*) FROM canvas.project_events WHERE project_id=p.id),
 (SELECT count(*) FROM canvas.command_receipts WHERE project_id=p.id),
 (SELECT count(*) FROM execution.tasks WHERE project_id=p.id)
 FROM public.projects p WHERE id=$1`, nodeLeaseProject).Scan(&state.Graph, &state.Revision, &state.Sequence, &state.Events, &state.Receipts, &state.TaskCount); err != nil {
		t.Fatal(err)
	}
	return state
}

func (f *nodeLeaseWriteFixture) edit(t *testing.T, node, text string) map[string]any {
	t.Helper()
	graph := graphFrom(t, f.state(t).Graph)
	for _, raw := range graph["nodes"].([]any) {
		row := raw.(map[string]any)
		if row["id"] == node {
			row["data"].(map[string]any)["text"] = text
			return graph
		}
	}
	t.Fatal("fixture node missing")
	return nil
}

func (f *nodeLeaseWriteFixture) put(t *testing.T, id httpapi.Identity, page string, graph map[string]any, want int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/projects/"+nodeLeaseProject+"/snapshot", bytes.NewReader(encode(map[string]any{"graph": graph})))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+id.UserID)
	request.Header.Set("If-Match", fmt.Sprintf(`"%d"`, f.state(t).Revision))
	if page != "" {
		request.Header.Set(collaboration.CanvasSessionHeader, page)
	}
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, request)
	if w.Code != want {
		t.Fatalf("snapshot status %d, want %d: %s", w.Code, want, w.Body.String())
	}
	return w
}

func assertNodeLeaseRejected(t *testing.T, err error, node ...string) {
	t.Helper()
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Status != 409 || api.Code != "NODE_EDIT_OCCUPIED" {
		t.Fatalf("expected NODE_EDIT_OCCUPIED 409, got %v", err)
	}
	wantNode := "n1"
	if len(node) > 0 {
		wantNode = node[0]
	}
	if len(api.Details) != 1 || api.Details[0].Field != "nodeId" || api.Details[0].Message != wantNode {
		t.Fatal("lease rejection lost symbolic node scope")
	}
}

func TestPostgresCoreNodeLeaseSnapshotGuardPreservesCASAndAllowsDisjointEditors(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	f.acquire(t, f.owner, "owner-page", "n1")
	for _, row := range []struct {
		name string
		id   httpapi.Identity
		page string
	}{
		{"another editor", f.editor, "editor-page"},
		{"same user another page", f.owner, "owner-other-page"},
		{"legacy owner without page", f.owner, ""},
		{"legacy editor without page", f.editor, ""},
		{"visible holder page is no authority for another user", f.editor, "owner-page"},
	} {
		t.Run(row.name, func(t *testing.T) {
			before := f.state(t)
			w := f.put(t, row.id, row.page, f.edit(t, "n1", "Rejected input"), 409)
			var api httpapi.Error
			if err := json.Unmarshal(w.Body.Bytes(), &api); err != nil {
				t.Fatal(err)
			}
			api.Status = w.Code
			assertNodeLeaseRejected(t, &api)
			if after := f.state(t); after != before {
				t.Fatal("rejected lease write changed graph, CAS, event, receipt or task")
			}
		})
	}
	before := f.state(t)
	if w := f.put(t, f.owner, "owner-page", f.edit(t, "n1", "Holder saved"), 200); w.Header().Get("ETag") != fmt.Sprintf(`"%d"`, before.Revision+1) {
		t.Fatal("holder did not receive its actual incremented CAS")
	}
	f.put(t, f.editor, "editor-page", f.edit(t, "n2", "Editor saved a disjoint node"), 200)
	after := f.state(t)
	if after.Revision != before.Revision+2 || after.Sequence != before.Sequence+2 || after.Events != before.Events+2 || after.TaskCount != 0 || after.Receipts != 0 {
		t.Fatal("disjoint writes did not each commit one graph revision/event")
	}
	if !strings.Contains(after.Graph, "Holder saved") || !strings.Contains(after.Graph, "Editor saved a disjoint node") {
		t.Fatal("disjoint node save replaced another editor's input")
	}
	// Expire only this disposable fixture's lease, without waiting on wall time.
	if _, err := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_node_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1 AND node_id='n1'`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	f.put(t, f.editor, "", f.edit(t, "n1", "Legacy save after expiry"), 200)
	f.acquire(t, f.owner, "owner-page", "n1")
	if _, err := f.presence.Release(f.ctx, f.owner, nodeLeaseProject, "owner-page", []string{"n1"}, false); err != nil {
		t.Fatal(err)
	}
	f.put(t, f.editor, "editor-page", f.edit(t, "n1", "Save after release"), 200)
	if final := f.state(t); final.Revision != after.Revision+2 || final.Events != after.Events+2 || !strings.Contains(final.Graph, "Save after release") {
		t.Fatal("expired/released lease continued blocking a valid save")
	}
}

func TestPostgresCanvasCommandNodeLeaseGuardRejectsBeforeGraphReceiptAndEvent(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	f.acquire(t, f.owner, "owner-page", "n1")
	service, err := canvas.NewCommandService(canvasPG.NewCommandUnitOfWork(f.db), ValidateProductGraph)
	if err != nil {
		t.Fatal(err)
	}
	move := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"n1","position":{"x":30,"y":40}}]}`)
	for _, row := range []struct {
		name string
		id   httpapi.Identity
		page string
	}{{"other editor", f.editor, "editor-page"}, {"same user another page", f.owner, "owner-other-page"}, {"legacy no page context", f.owner, ""}} {
		t.Run(row.name, func(t *testing.T) {
			before := f.state(t)
			ctx := collaboration.WithCanvasLeaseRequest(f.ctx, row.id, row.page)
			_, err := service.Submit(ctx, row.id.UserID, nodeLeaseProject, before.Revision, uuid.NewString(), move)
			assertNodeLeaseRejected(t, err)
			if after := f.state(t); after != before {
				t.Fatal("denied actual command created graph, receipt, task or event")
			}
		})
	}
	otherMove := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"n2","position":{"x":230,"y":40}}]}`)
	key := uuid.NewString()
	before := f.state(t)
	editorCtx := collaboration.WithCanvasLeaseRequest(f.ctx, f.editor, "editor-page")
	other, err := service.Submit(editorCtx, f.editor.UserID, nodeLeaseProject, before.Revision, key, otherMove)
	if err != nil {
		t.Fatal("lease on n1 blocked a command editing n2", err)
	}
	ownerCtx := collaboration.WithCanvasLeaseRequest(f.ctx, f.owner, "owner-page")
	if _, err = service.Submit(ownerCtx, f.owner.UserID, nodeLeaseProject, other.GraphRevision, uuid.NewString(), move); err != nil {
		t.Fatal("valid lease holder command was rejected", err)
	}
	committed := f.state(t)
	if committed.Revision != before.Revision+2 || committed.Events != before.Events+2 || committed.Receipts != before.Receipts+2 || committed.TaskCount != 0 {
		t.Fatal("successful commands were not atomic with receipts and events")
	}
	// Replaying a committed receipt remains a read even after a new editor
	// leases its node; a new command must still be denied before mutation.
	f.acquire(t, f.owner, "owner-page", "n2")
	replayed, err := service.Submit(editorCtx, f.editor.UserID, nodeLeaseProject, before.Revision, key, otherMove)
	if err != nil || replayed.CommandID != other.CommandID || replayed.GraphRevision != other.GraphRevision {
		t.Fatal("active lease prevented an exact, already committed receipt replay", err)
	}
	if after := f.state(t); after != committed {
		t.Fatal("receipt replay committed another graph revision or event")
	}
	newMove := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"n2","position":{"x":260,"y":50}}]}`)
	_, err = service.Submit(editorCtx, f.editor.UserID, nodeLeaseProject, committed.Revision, uuid.NewString(), newMove)
	assertNodeLeaseRejected(t, err, "n2")
	if after := f.state(t); after != committed {
		t.Fatal("new command bypassed an active lease after an old receipt replay")
	}
}
