package postgres_test

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/principal"
	"testing"
)

func TestPostgresCollaborativeExecutionActorReadWriteAndRevocation(t *testing.T) {
	f := newHistoryInputFixture(t)
	if _, e := f.pool.Exec(f.ctx, `INSERT INTO public.users(id,email,display_name) VALUES('input-viewer','viewer@example.test','Viewer');
 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('input-project','input-other','EDITOR','input-owner'),('input-project','input-viewer','VIEWER','input-owner')`); e != nil {
		t.Fatal(e)
	}
	f.service.WithProjectAccess(func(ctx context.Context, a, p string) (string, error) {
		scope, e := collaboration.RequireProject(ctx, f.pool, a, p, "EDITOR", false)
		return scope.StorageOwnerID, e
	})
	key := uuid.NewString()
	cmd := domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "target", Graph: json.RawMessage(`{"nodes":[{"id":"target","type":"rh-text","data":{"capabilityRef":"history-input-fixture","prompt":"QA only"}}],"edges":[]}`)}
	task, e := f.service.Canvas(f.ctx, "input-other", key, cmd)
	if e != nil {
		t.Fatal(e)
	}
	if task.OwnerID != "input-owner" || task.InitiatedBy != "input-other" {
		t.Fatal("bad collaborative execution attribution")
	}
	// A caller who can compute another member's derived UUID cannot claim its receipt.
	var derived, hash string
	if e = f.pool.QueryRow(f.ctx, `SELECT idempotency_key,request_hash FROM execution.tasks WHERE id=$1`, task.ID).Scan(&derived, &hash); e != nil {
		t.Fatal(e)
	}
	squatter := task
	squatter.ID = "squatter-" + uuid.NewString()
	squatter.InitiatedBy = "input-owner"
	if _, e = f.store.Create(f.ctx, squatter, derived, hash, nil); e != domain.ErrConflict {
		t.Fatal("receipt actor attribution not checked", e)
	}
	var actor string
	if e = f.pool.QueryRow(f.ctx, `SELECT initiated_by FROM execution.tasks WHERE id=$1`, task.ID).Scan(&actor); e != nil || actor != "input-other" {
		t.Fatal("initiator not persisted", e)
	}
	for _, a := range []string{"input-owner", "input-other", "input-viewer"} {
		if _, e = f.store.Get(f.ctx, a, task.ID); e != nil {
			t.Fatal("shared task hidden", a, e)
		}
	}
	if _, e = f.service.Canvas(f.ctx, "input-viewer", uuid.NewString(), cmd); e == nil {
		t.Fatal("viewer submitted generation")
	}
	if _, e = f.store.Cancel(f.ctx, "input-viewer", task.ID); e == nil {
		t.Fatal("viewer canceled task")
	}
	if e = collaboration.AuthorizeProjectAssets(f.ctx, f.pool, "input-other", "input-project", []string{"input-old-image"}); e == nil {
		t.Fatal("editor inherited all owner private assets")
	}
	if _, e = f.store.Assets(principal.WithProject(principal.WithActor(f.ctx, "input-other"), "input-project"), "input-owner", []string{"input-old-image"}); e == nil {
		t.Fatal("executor bypassed project asset boundary")
	}
	// The same UUID used by owner is another receipt, not another actor's replay.
	own, e := f.service.Canvas(f.ctx, "input-owner", key, cmd)
	if e != nil || own.ID == task.ID {
		t.Fatal("receipt leaked across actor", e)
	}
	if _, e = f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1`, task.ID, key); e != nil {
		t.Fatal(e)
	}
	if _, e = f.pool.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id='input-project' AND user_id='input-other'`); e != nil {
		t.Fatal(e)
	}
	if _, e = f.store.Get(f.ctx, "input-other", task.ID); e == nil {
		t.Fatal("revoked actor reads task")
	}
	if _, e = f.service.Canvas(f.ctx, "input-other", key, cmd); e == nil {
		t.Fatal("revoked actor replays task")
	}
	task.State = "SUCCEEDED"
	task.Plans[0].State = "SUCCEEDED"
	text := "must not publish"
	task.Plans[0].Outputs = []domain.Output{{ID: "collab-output", Type: "TEXT", Text: &text, TestMode: true}}
	if ok, e := f.store.Save(f.ctx, task, key); e != nil || !ok {
		t.Fatal("revocation cleanup failed", e)
	}
	got, e := f.store.Get(f.ctx, "input-owner", task.ID)
	if e != nil || got.State != "CANCELED" || len(got.Plans[0].Outputs) > 0 {
		t.Fatal("revoked worker published result", e)
	}
	// Existing owner data and legacy nullable initiator remain visible.
	old := f.history(t, "input-owner", "input-project", "legacy", "SUCCEEDED", []domain.Output{})
	if _, e = f.pool.Exec(f.ctx, `UPDATE execution.tasks SET initiated_by=NULL,payload=payload-'initiatedBy' WHERE id=$1`, old.ID); e != nil {
		t.Fatal(e)
	}
	got, e = f.store.Get(f.ctx, "input-owner", old.ID)
	if e != nil || got.InitiatedBy != "input-owner" {
		t.Fatal("legacy attribution changed", e)
	}
}
