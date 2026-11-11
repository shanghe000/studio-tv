package postgres_test

import (
	"encoding/json"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"strings"
	"testing"
	"time"
)

func TestPostgresImageBatchCollaboratorKeepsOwnerAndRevocationStopsNodes(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		name := "editor"
		if revoked {
			name = "revoked"
		}
		t.Run(name, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			if _, err := f.pool.Exec(f.ctx, `INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('input-project','input-other','EDITOR','input-owner'); UPDATE public.assets SET project_id='input-project' WHERE id IN ('input-old-image','input-new-image')`); err != nil {
				t.Fatal(err)
			}
			rev := setManagedGraph(t, f, imageBatchGraph)
			project, now := "input-project", time.Now().UTC()
			task := domain.Task{ID: "batch-editor-" + uuid.NewString(), OwnerID: "input-owner", InitiatedBy: "input-other", ProjectID: &project, Kind: "CANVAS", TargetType: "NODE", TargetID: "target", State: "QUEUED", Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(imageBatchGraph), ExpectedRevision: &rev, Plans: []domain.Plan{{NodeID: "target", ExecutionID: "batch-editor-execution-" + uuid.NewString(), CapabilityRef: "codex-image-generate-v1", CapabilityVersion: "2", State: "QUEUED", TestMode: true, NodeSnapshot: json.RawMessage(`{"id":"target","type":"rh-image","data":{}}`), Request: json.RawMessage(`{}`)}}}
			got, err := f.store.Create(f.ctx, task, uuid.NewString(), strings.Repeat("d", 64), nil)
			if err != nil {
				t.Fatal(err)
			}
			task = got
			lease := uuid.NewString()
			if _, err = f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1`, task.ID, lease); err != nil {
				t.Fatal(err)
			}
			if revoked {
				if _, err = f.pool.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id='input-project' AND user_id='input-other'`); err != nil {
					t.Fatal(err)
				}
			}
			a, b := "input-old-image", "input-new-image"
			task.State = "SUCCEEDED"
			task.Plans[0].State = "SUCCEEDED"
			task.Plans[0].Outputs = []domain.Output{{ID: "one", Type: "ASSET", AssetID: &a, MimeType: "image/png", TestMode: true}, {ID: "two", Type: "ASSET", AssetID: &b, MimeType: "image/png", TestMode: true}}
			if ok, err := f.store.Save(f.ctx, task, lease); err != nil || !ok {
				t.Fatal(ok, err)
			}
			got, err = f.store.Get(f.ctx, "input-owner", task.ID)
			if err != nil || got.OwnerID != "input-owner" || got.InitiatedBy != "input-other" {
				t.Fatal("batch actor/storage owner changed", err)
			}
			raw, _ := currentManagedGraph(t, f)
			var graph struct{ Nodes []json.RawMessage }
			_ = json.Unmarshal([]byte(raw), &graph)
			if revoked {
				if got.State != "CANCELED" || len(graph.Nodes) != 1 || len(got.Plans[0].Outputs) != 0 {
					t.Fatal("revoked editor published nodes")
				}
			} else {
				if got.State != "SUCCEEDED" || len(graph.Nodes) != 2 {
					t.Fatal("authorized editor batch missing")
				}
				if _, err = f.store.Get(f.ctx, "input-other", task.ID); err != nil {
					t.Fatal("editor cannot see own batch", err)
				}
			}
		})
	}
}
