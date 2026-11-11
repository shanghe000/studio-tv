package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/principal"
)

// These are persistence-only TEST MODE tasks. No worker, Router or model is
// started; rejected acceptance must leave even the queued task table empty.
func TestPostgresCanvasTaskNodeLeaseGuardRejectsForeignOwnerBeforeCreation(t *testing.T) {
	f := newHistoryInputFixture(t)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO collaboration.project_members(project_id,user_id,role,created_by)VALUES('input-project','input-other','EDITOR','input-owner')`); err != nil {
		t.Fatal(err)
	}
	setManagedGraph(t, f, managedGraph)
	presence, err := collaboration.NewPresenceService(f.pool)
	if err != nil {
		t.Fatal(err)
	}
	identity := func(user, session string) httpapi.Identity {
		return httpapi.Identity{UserID: user, SessionID: session, AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	}
	owner := identity("input-owner", "owner-session")
	editor := identity("input-other", "editor-session")
	if _, err = presence.Heartbeat(f.ctx, owner, "input-project", "owner-page", nil, []string{"target"}); err != nil {
		t.Fatal(err)
	}
	if _, err = presence.Acquire(f.ctx, owner, "input-project", "owner-page", []string{"target"}); err != nil {
		t.Fatal(err)
	}
	caller := func(id httpapi.Identity, page string) context.Context {
		return collaboration.WithCanvasLeaseRequest(principal.WithActor(f.ctx, id.UserID), id, page)
	}
	task := func(actor, kind, node string) domain.Task {
		project := "input-project"
		now := time.Now().UTC()
		return domain.Task{ID: "node-lease-" + uuid.NewString(), OwnerID: "input-owner", InitiatedBy: actor, ProjectID: &project, Kind: kind, TargetType: "NODE", TargetID: node, State: "QUEUED", Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(managedGraph), Plans: []domain.Plan{{NodeID: node, ExecutionID: "execution-" + uuid.NewString(), State: "QUEUED", TestMode: true, NodeSnapshot: json.RawMessage(`{"id":"` + node + `","type":"rh-text","data":{"prompt":"fixture input"}}`), Request: json.RawMessage(`{}`)}}}
	}
	count := func() int {
		var n int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM execution.tasks WHERE project_id='input-project'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for _, row := range []struct {
		name, kind, page string
		id               httpapi.Identity
		emptyPlans       bool
		planNode         string
	}{
		{name: "foreign canvas holder", kind: "CANVAS", page: "editor-page", id: editor},
		{name: "foreign media holder", kind: "MEDIA", page: "editor-page", id: editor},
		{name: "visible page id does not confer another account authority", kind: "CANVAS", page: "owner-page", id: editor},
		{name: "same account another page", kind: "CANVAS", page: "other-page", id: owner},
		{name: "same account another session", kind: "CANVAS", page: "owner-page", id: identity("input-owner", "other-session")},
		{name: "legacy owner missing page", kind: "CANVAS", id: owner},
		{name: "legacy empty plans still protect target", kind: "CANVAS", page: "editor-page", id: editor, emptyPlans: true},
		{name: "target differs from unoccupied plan", kind: "CANVAS", page: "editor-page", id: editor, planNode: "source"},
	} {
		t.Run(row.name, func(t *testing.T) {
			candidate := task(row.id.UserID, row.kind, "target")
			if row.emptyPlans {
				candidate.Plans = nil
			} else if row.planNode != "" {
				candidate.Plans[0].NodeID = row.planNode
			}
			_, err := f.store.Create(caller(row.id, row.page), candidate, uuid.NewString(), strings.Repeat("a", 64), nil)
			var api *httpapi.Error
			if !errors.As(err, &api) || api.Status != 409 || api.Code != "NODE_EDIT_OCCUPIED" {
				t.Fatalf("expected definite pre-creation occupancy refusal, got%v", err)
			}
			if count() != 0 {
				t.Fatal("occupancy refusal created a queued task")
			}
		})
	}
	// Verified caller metadata and the attributed initiator must agree even on
	// internal service calls; neither page ids nor graph fields can change it.
	if _, err := f.store.Create(caller(owner, "owner-page"), task(editor.UserID, "CANVAS", "target"), uuid.NewString(), strings.Repeat("a", 64), nil); err == nil {
		t.Fatal("mismatched caller and attributed task actor accepted")
	} else {
		var api *httpapi.Error
		if !errors.As(err, &api) || api.Status != 403 || api.Code != "AUTHORIZATION_DENIED" {
			t.Fatalf("expected attributed actor authorization refusal, got %v", err)
		}
	}
	if count() != 0 {
		t.Fatal("actor mismatch created a task")
	}
	if _, err := f.store.Create(caller(owner, "owner-page"), task(owner.UserID, "CANVAS", "target"), uuid.NewString(), strings.Repeat("b", 64), nil); err != nil {
		t.Fatal("holder could not submit", err)
	}
	if _, err := f.store.Create(caller(editor, "editor-page"), task(editor.UserID, "CANVAS", "source"), uuid.NewString(), strings.Repeat("c", 64), nil); err != nil {
		t.Fatal("unrelated node generation was blocked", err)
	}
	if count() != 2 {
		t.Fatal("accepted nodes did not create exactly two tasks")
	}
}

func TestPostgresCanvasTaskNodeLeaseDoesNotRejectAnExistingIdempotentReceipt(t *testing.T) {
	f := newHistoryInputFixture(t)
	setManagedGraph(t, f, managedGraph)
	now := time.Now().UTC()
	project := "input-project"
	identity := httpapi.Identity{UserID: "input-owner", SessionID: "owner-session", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour)}
	ctx := collaboration.WithCanvasLeaseRequest(principal.WithActor(f.ctx, identity.UserID), identity, "original-page")
	task := domain.Task{ID: "lease-replay-" + uuid.NewString(), OwnerID: "input-owner", InitiatedBy: "input-owner", ProjectID: &project, Kind: "CANVAS", TargetType: "NODE", TargetID: "target", State: "QUEUED", Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now, Plans: []domain.Plan{{NodeID: "target", ExecutionID: uuid.NewString(), State: "QUEUED", TestMode: true}}}
	key, hash := uuid.NewString(), strings.Repeat("d", 64)
	accepted, err := f.store.Create(ctx, task, key, hash, nil)
	if err != nil {
		t.Fatal(err)
	}
	presence, _ := collaboration.NewPresenceService(f.pool)
	if _, err = presence.Heartbeat(f.ctx, identity, project, "new-holder-page", nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = presence.Acquire(f.ctx, identity, project, "new-holder-page", []string{"target"}); err != nil {
		t.Fatal(err)
	}
	replay, err := f.store.Create(ctx, task, key, hash, nil)
	if err != nil || replay.ID != accepted.ID {
		t.Fatal("new occupancy prevented trusted receipt replay", err)
	}
	var count int
	if err = f.pool.QueryRow(f.ctx, `SELECT count(*) FROM execution.tasks WHERE project_id='input-project'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("receipt replay created duplicate work", count, err)
	}
}

// All three routes derive the canvas from the saved task. A previous page's
// request (including a missing header) must never alter a task after handoff.
func TestCanvasTaskMutationsFencePreviousPageAfterHandoff(t *testing.T) {
	f := newHistoryInputFixture(t)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('input-project','input-other','EDITOR','input-owner')`); err != nil {
		t.Fatal(err)
	}
	v := "retained"
	out := []domain.Output{{ID: "output-one", Type: "TEXT", Text: &v}}
	saved := f.history(t, "input-owner", "input-project", "target", "SUCCEEDED", out)
	batch := f.history(t, "input-owner", "input-project", "target", "SUCCEEDED", out)
	queued := f.history(t, "input-owner", "input-project", "target", "QUEUED", nil)
	// An imported media task is also an interactive canvas target. A project
	// task of another kind does not gain a canvas lease dependency.
	createKind := func(kind string) domain.Task {
		t.Helper()
		row := queued
		row.ID = uuid.NewString()
		row.Kind = kind
		row.Plans = append([]domain.Plan(nil), queued.Plans...)
		row.Plans[0].ExecutionID = uuid.NewString()
		result, err := f.store.Create(f.ctx, row, uuid.NewString(), strings.Repeat("a", 64), nil)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	media := createKind("MEDIA")
	sketch := createKind("SKETCH")
	rev := setManagedGraph(t, f, managedGraph)
	accepted := managedTask(t, f, managedGraph, rev)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO collaboration.canvas_edit_sessions (project_id,actor_id,session_id,client_id,expires_at) VALUES('input-project','input-other','new-session','new-page',now()+interval '10 minutes')`); err != nil {
		t.Fatal(err)
	}
	caller := func(user, session, page string) context.Context {
		return collaboration.WithCanvasLeaseRequest(f.ctx, httpapi.Identity{UserID: user, SessionID: session}, page)
	}
	requireCode := func(err error, code string) {
		t.Helper()
		var a *httpapi.Error
		if !errors.As(err, &a) || a.Code != code {
			t.Fatalf("wanted %s, got %v", code, err)
		}
	}
	for _, attempt := range []struct{ user, session, page string }{{"input-owner", "old-session", "old-page"}, {"input-owner", "old-session", "new-page"}, {"input-owner", "old-session", ""}, {"input-other", "new-session", "former-tab"}} {
		ctx := caller(attempt.user, attempt.session, attempt.page)
		if _, e := f.store.Cancel(ctx, attempt.user, queued.ID); e != nil {
			requireCode(e, "PROJECT_EDIT_OCCUPIED")
		} else {
			t.Fatal("superseded page canceled a task")
		}
		_, e := f.store.DeleteHistory(ctx, attempt.user, []string{batch.Plans[0].ExecutionID})
		requireCode(e, "PROJECT_EDIT_OCCUPIED")
		_, e = f.store.DeleteOutput(ctx, attempt.user, saved.Plans[0].ExecutionID, "output-one", 1)
		requireCode(e, "PROJECT_EDIT_OCCUPIED")
	}
	oldOwner := caller("input-owner", "old-session", "old-page")
	_, err := f.store.Cancel(oldOwner, "input-owner", media.ID)
	requireCode(err, "PROJECT_EDIT_OCCUPIED")
	if _, err = f.store.Cancel(oldOwner, "input-owner", sketch.ID); err != nil {
		t.Fatal("project task unrelated to canvas was fenced", err)
	}
	for _, original := range []domain.Task{saved, batch, queued, media} {
		current, e := f.store.Get(f.ctx, "input-owner", original.ID)
		if e != nil || current.State != original.State || current.Revision != original.Revision || current.Plans[0].HistoryDeletedAt != nil {
			t.Fatal("rejected changes modified a task", e)
		}
	}
	// The worker which was already accepted can publish a terminal result after
	// the holder changes, including its canvas binding and history.
	accepted.State = "SUCCEEDED"
	accepted.Plans[0].State = "SUCCEEDED"
	accepted.Plans[0].Outputs = out
	if ok, e := f.store.Save(f.ctx, accepted, "05764324-02f4-4125-9501-4b441fce3f18"); e != nil || !ok {
		t.Fatal("accepted worker could not finish", e)
	}
	accepted, e := f.store.Get(f.ctx, "input-owner", accepted.ID)
	if e != nil || accepted.Plans[0].CanvasBinding.ApplicationState != "APPLIED" {
		t.Fatal("worker lost writeback after handoff", e)
	}
	leaseID := uuid.NewString()
	if _, e := f.pool.Exec(f.ctx, `UPDATE collaboration.canvas_edit_sessions SET lease_id=$2,page_hash=$1 WHERE project_id='input-project'`, collaboration.CanvasProofDigest("private-browser-proof-for-the-new-writer-page"), leaseID); e != nil {
		t.Fatal(e)
	}
	// Same authenticated account and even a known client ID do not establish
	// possession of the editor when the request lacks the private page proof.
	unproven := caller("input-other", "new-session", "new-page")
	_, e = f.store.Cancel(unproven, "input-other", queued.ID)
	requireCode(e, "PROJECT_EDIT_OCCUPIED")
	request := httptest.NewRequest("POST", "/api/v2/tasks/example/cancel", nil).WithContext(unproven)
	request.Header.Set(collaboration.CanvasProofHeader, "private-browser-proof-for-the-new-writer-page")
	request.Header.Set(collaboration.CanvasLeaseHeader, uuid.NewString())
	previousTerm := collaboration.ContextWithCanvasProof(request)
	_, e = f.store.DeleteHistory(previousTerm, "input-other", []string{batch.Plans[0].ExecutionID})
	requireCode(e, "EDIT_SESSION_EXPIRED")
	request.Header.Set(collaboration.CanvasLeaseHeader, leaseID)
	current := collaboration.ContextWithCanvasProof(request)
	if _, e = f.store.Cancel(current, "input-other", queued.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.store.DeleteHistory(current, "input-other", []string{batch.Plans[0].ExecutionID}); e != nil {
		t.Fatal(e)
	}
	if _, e = f.store.DeleteOutput(current, "input-other", saved.Plans[0].ExecutionID, "output-one", 1); e != nil {
		t.Fatal(e)
	}
	if _, e = f.pool.Exec(f.ctx, `UPDATE collaboration.project_members SET role='VIEWER' WHERE project_id='input-project' AND user_id='input-other'`); e != nil {
		t.Fatal(e)
	}
	_, e = f.store.Cancel(current, "input-other", queued.ID)
	var denied *httpapi.Error
	if !errors.As(e, &denied) || denied.Status != 403 {
		t.Fatal("former holder kept write access after role demotion", e)
	}
}
