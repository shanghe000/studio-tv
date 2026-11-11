package postgres_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"net/http/httptest"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/adapters/pfhttp"
	agent "studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	"testing"
	"time"
)

func TestPostgresCollaborativeCanvasCommandsAndReadOnlyLive(t *testing.T) {
	pool, ctx := isolatedCommandDatabase(t)
	if _, e := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('owner-a','a@example.test','A'),('owner-b','b@example.test','B'),('viewer','v@example.test','V');INSERT INTO public.projects(id,owner_id,name) VALUES('project','owner-a','Shared');INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('project','owner-b','EDITOR','owner-a'),('project','viewer','VIEWER','owner-a')`); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `UPDATE public.projects SET graph=$1 WHERE id='project'`, json.RawMessage(initialCommandGraph)); e != nil {
		t.Fatal(e)
	}
	var base int64
	if e := pool.QueryRow(ctx, `SELECT revision FROM public.projects WHERE id='project'`).Scan(&base); e != nil {
		t.Fatal(e)
	}
	router := commandRouter(t, postgres.NewCommandUnitOfWork(pool))
	key := uuid.NewString()
	move := `{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":30,"y":40}}]}`
	first := callCommand(router, "POST", "/api/v2/projects/project/canvas-commands", "owner-b", move, commandHeaders(key, base))
	assertCommandStatus(t, first, 200)
	receipt := commandData(first)
	if receipt["graphRevision"] != float64(base+1) {
		t.Fatal("wrong graph revision", receipt)
	}
	var actor, storage string
	if e := pool.QueryRow(ctx, `SELECT actor_id,owner_id FROM canvas.command_receipts WHERE project_id='project'`).Scan(&actor, &storage); e != nil || actor != "owner-b" || storage != "owner-a" {
		t.Fatal("command actor collapsed", e)
	}
	second := callCommand(router, "POST", "/api/v2/projects/project/canvas-commands", "owner-a", `{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":70,"y":80}}]}`, commandHeaders(key, base+1))
	assertCommandStatus(t, second, 200)
	if commandData(second)["commandId"] == receipt["commandId"] {
		t.Fatal("actors shared receipt UUID")
	}
	live, _ := application.NewLiveService(postgres.New(pool))
	snap, e := live.Snapshot(ctx, "viewer", "project")
	if e != nil || snap.GraphRevision != base+2 {
		t.Fatal("viewer cannot read live snapshot", e)
	}
	commands, _ := application.NewCommandService(postgres.NewCommandUnitOfWork(pool), core.ValidateProductGraph)
	if _, e = commands.Submit(ctx, "viewer", "project", base+2, uuid.NewString(), json.RawMessage(move)); e == nil {
		t.Fatal("viewer edited graph")
	}
	if _, e = pool.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='project' AND user_id='owner-b'`); e != nil {
		t.Fatal(e)
	}
	assertCommandStatus(t, callCommand(router, "POST", "/api/v2/projects/project/canvas-commands", "owner-b", move, commandHeaders(key, base)), 404)
	if _, e = live.Snapshot(ctx, "owner-b", "project"); e != domain.ErrNotFound {
		t.Fatal("revoked actor received live graph", e)
	}
	var unchanged int64
	if e = pool.QueryRow(ctx, `SELECT revision FROM public.projects WHERE id='project'`).Scan(&unchanged); e != nil || unchanged != base+2 {
		t.Fatal(fmt.Sprint("denied write changed graph ", e))
	}
}

// Exercises the real Agent tool transport, canvas command route, and project
// transaction together. A delayed tool may retain a still-valid account token
// and the very same browser page after an edit handoff and return.
func TestAgentCommandUsesOriginalCanvasTenure(t *testing.T) {
	pool, ctx := isolatedCommandDatabase(t)
	proof, term := "test-private-browser-page-proof-for-agent-tools", uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name)VALUES('owner-a','agent@example.test','A');
 INSERT INTO projects(id,owner_id,name)VALUES('project','owner-a','Agent')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE projects SET graph=$1 WHERE id='project'`, json.RawMessage(initialCommandGraph)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collaboration.canvas_edit_sessions(project_id,actor_id,session_id,client_id,page_hash,lease_id,expires_at)
 VALUES ('project','owner-a','test-session','page-a',$1,$2,now()+interval '10 minutes')`, collaboration.CanvasProofDigest(proof), term); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/v2/conversations/c/agent-runs", nil)
	request.Header.Set(collaboration.CanvasProofHeader, proof)
	request.Header.Set(collaboration.CanvasLeaseHeader, term)
	originalPage := collaboration.WithCanvasLeaseRequest(collaboration.ContextWithCanvasProof(request), httpapi.Identity{UserID: "owner-a", SessionID: "test-session"}, "page-a")
	now := time.Now()
	actor := agent.Actor{OwnerID: "owner-a", SessionID: "test-session", IssuedAt: now, AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour)}
	credential := agent.Credential{Actor: actor, Bearer: "owner-a", ExpiresAt: actor.AccessExpiresAt, Canvas: collaboration.CanvasDelegationFrom(originalPage)}
	server := httptest.NewServer(commandRouter(t, postgres.NewCommandUnitOfWork(pool)))
	t.Cleanup(server.Close)
	exec, err := pfhttp.New(server.URL, server.Client(), func(context.Context, string) (agent.Actor, error) { return actor, nil })
	if err != nil {
		t.Fatal(err)
	}
	move := func(rev int64, pos string) agent.ToolResponse {
		t.Helper()
		out, e := exec.Execute(ctx, credential, agent.ToolRequest{Method: "POST", Path: "/api/v2/projects/project/canvas-commands", ExpectedRevision: rev, IdempotencyKey: uuid.NewString(), Body: json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":` + pos + `,"y":40}}]}`)})
		if e != nil {
			t.Fatal(e)
		}
		return out
	}
	var rev int64
	if err = pool.QueryRow(ctx, `SELECT revision FROM projects WHERE id='project'`).Scan(&rev); err != nil {
		t.Fatal(err)
	}
	if out := move(rev, "33"); out.Status != 200 {
		t.Fatal(out)
	}
	if _, err = pool.Exec(ctx, `UPDATE collaboration.canvas_edit_sessions SET lease_id=$1 WHERE project_id='project'`, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if out := move(rev+1, "66"); out.Status != 409 || out.ErrorCode != "EDIT_SESSION_EXPIRED" {
		t.Fatal(out)
	}
	var actual int
	if err = pool.QueryRow(ctx, `SELECT (graph->'nodes'->1->'position'->>'x')::int FROM projects WHERE id='project'`).Scan(&actual); err != nil || actual != 33 {
		t.Fatal(actual, err)
	}
}
