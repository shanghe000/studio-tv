package postgres_test

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

// Persistence fixtures only; this test never calls a model or creates Router
// invocations, and testdb owns and removes its isolated PostgreSQL database.
func TestGenerationQueueCountsStudioWaitingTasksOnceBeforeRouterSubmission(t *testing.T) {
	f := newHistoryInputFixture(t)
	add := func(state string, age time.Duration, capabilities ...string) domain.Task {
		t.Helper()
		project := "input-project"
		now := time.Now().UTC().Add(-age)
		task := domain.Task{ID: "queue-" + uuid.NewString(), OwnerID: "input-owner", ProjectID: &project, Kind: "CANVAS", TargetType: "NODE", TargetID: "queue-target", State: state, Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now}
		for _, ref := range capabilities {
			task.Plans = append(task.Plans, domain.Plan{NodeID: "queue-target", ExecutionID: uuid.NewString(), CapabilityRef: ref, CapabilityVersion: "2", State: state, TestMode: true, Outputs: []domain.Output{}})
		}
		created, err := f.store.Create(f.ctx, task, uuid.NewString(), strings.Repeat("e", 64), nil)
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	oldest := add("QUEUED", 2*time.Minute, "h3-first-last-frame-v1", "h3-reference-v1")
	add("QUEUED", time.Minute, "h3-video-reference-v1")
	add("RUNNING", 10*time.Minute, "h3-reference-v1")
	add("QUEUED", 30*time.Second, "codex-image-generate-v1")
	add("QUEUED", 20*time.Second) // A missing/JSON null plans list is still one task.
	add("SUCCEEDED", 20*time.Minute, "h3-reference-v1")
	add("FAILED", 20*time.Minute, "h3-reference-v1")
	add("CANCELED", 20*time.Minute, "h3-reference-v1")
	// Delayed/leased QUEUED work remains outstanding and must remain visible.
	if _, err := f.pool.Exec(f.ctx, `UPDATE execution.tasks SET available_at=now()+interval '1 hour', lease_until=now()+interval '1 hour', lease_token=$2 WHERE id=$1`, oldest.ID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	groups, err := f.store.GenerationQueue(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 2 {
		t.Fatalf("unexpected active queue groups: %+v", groups)
	}
	for _, group := range groups {
		if group.Kind != "CANVAS" {
			t.Fatal("wrong task kind", group)
		}
		switch group.CapabilityFamily {
		case "h3":
			if group.Queued != 2 || group.Running != 1 || group.OldestQueuedAgeSeconds < 120 || group.OldestQueuedAgeSeconds > 125 {
				t.Fatal("H3 task count, pre-Router queue, terminal filter or oldest age is wrong", group)
			}
		case "other":
			if group.Queued != 2 || group.Running != 0 || group.OldestQueuedAgeSeconds < 30 || group.OldestQueuedAgeSeconds > 35 {
				t.Fatal("other generation queue is wrong", group)
			}
		default:
			t.Fatal("unbounded capability grouping", group)
		}
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE execution.tasks SET state='SUCCEEDED' WHERE state IN ('QUEUED','RUNNING')`); err != nil {
		t.Fatal(err)
	}
	groups, err = f.store.GenerationQueue(f.ctx)
	if err != nil || len(groups) != 0 {
		t.Fatal("empty queue retained active tasks", groups, err)
	}
}
