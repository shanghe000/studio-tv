package postgres_test

import (
	"errors"
	"github.com/google/uuid"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"testing"
)

func TestPostgresServerCanvasExecutionOwnSnapshotCASReplayAndClosure(t *testing.T) {
	f := newHistoryInputFixture(t)
	revision := setManagedGraph(t, f, managedGraph)
	cmd := execution.ServerCanvasCommand{}
	cmd.Target.Type = "NODE"
	cmd.Target.ID = "target"
	key := uuid.NewString()
	task, err := f.service.ServerCanvas(f.ctx, "input-owner", "input-project", key, revision, cmd)
	if err != nil || !task.CanvasManaged || len(task.Plans) != 1 || task.Plans[0].CanvasBinding == nil {
		t.Fatal("server acceptance", task, err)
	}
	replay, err := f.service.ServerCanvas(f.ctx, "input-owner", "input-project", key, revision, cmd)
	if err != nil || replay.ID != task.ID {
		t.Fatal("CAS replay after acceptance changed revision", err)
	}
	_, err = f.service.ServerCanvas(f.ctx, "input-owner", "input-project", key, revision+1, cmd)
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatal("same key changed request", err)
	}
	_, err = f.service.ServerCanvas(f.ctx, "input-owner", "input-project", uuid.NewString(), revision, cmd)
	var conflict *execution.CanvasRevisionConflict
	if !errors.As(err, &conflict) {
		t.Fatal("stale revision accepted", err)
	}
	_, err = f.service.ServerCanvas(f.ctx, "other-owner", "input-project", uuid.NewString(), revision, cmd)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("cross owner snapshot", err)
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='input-project'`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.ServerCanvas(f.ctx, "input-owner", "input-project", key, revision, cmd); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted parent receipt disclosed", err)
	}
}
