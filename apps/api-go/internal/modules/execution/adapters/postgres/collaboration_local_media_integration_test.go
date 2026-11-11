package postgres_test

import (
	"encoding/json"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"strings"
	"testing"
	"time"
)

func TestPostgresSharedLocalMediaHistoryUsesCanonicalOwner(t *testing.T) {
	f := newHistoryInputFixture(t)
	if _, e := f.pool.Exec(f.ctx, `INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('input-project','input-other','EDITOR','input-owner')`); e != nil {
		t.Fatal(e)
	}
	project := "input-project"
	now := time.Now().UTC()
	task := domain.Task{ID: "media-" + uuid.NewString(), OwnerID: "input-owner", InitiatedBy: "input-other", ProjectID: &project, Kind: "MEDIA", TargetType: "NODE", TargetID: "local-media", State: "QUEUED", Revision: 1, Snapshot: json.RawMessage(`{}`), CreatedAt: now, UpdatedAt: now, Plans: []domain.Plan{{NodeID: "local-media", ExecutionID: "local-" + uuid.NewString(), State: "QUEUED"}}}
	task, e := f.store.Create(f.ctx, task, uuid.NewString(), strings.Repeat("c", 64), nil)
	if e != nil {
		t.Fatal(e)
	}
	lease := uuid.NewString()
	if _, e = f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1`, task.ID, lease); e != nil {
		t.Fatal(e)
	}
	task.State = "SUCCEEDED"
	task.Plans[0].State = "SUCCEEDED"
	if ok, e := f.store.Save(f.ctx, task, lease); e != nil || !ok {
		t.Fatal("shared local processing history failed", e)
	}
	if _, e = f.store.Get(f.ctx, "input-other", task.ID); e != nil {
		t.Fatal("local media task not visible", e)
	}
	var storage string
	if e = f.pool.QueryRow(f.ctx, `SELECT owner_id FROM execution.history_revisions WHERE project_id='input-project' AND node_id='local-media'`).Scan(&storage); e != nil || storage != "input-owner" {
		t.Fatal("local media history has wrong storage owner", e)
	}
}
