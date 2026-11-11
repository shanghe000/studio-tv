package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/testdb"
)

func TestPostgresTransactionRetryRecoversRealDeadlockAtomically(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testdb.New(t).Open(t)
	if _, err := pool.Exec(ctx, `CREATE TABLE execution_retry_rows(id integer PRIMARY KEY,value integer NOT NULL);
	 INSERT INTO execution_retry_rows VALUES(1,0),(2,0);
	 CREATE TABLE execution_retry_receipts(id integer PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		attempts  int
		deadlocks int
		err       error
	}
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan outcome, 2)
	for _, first := range []int{1, 2} {
		go func(first int) {
			attempts, deadlocks := 0, 0
			_, err := retryTransaction(ctx, func() (bool, error) {
				attempts++
				tx, err := pool.Begin(ctx)
				if err != nil {
					return false, err
				}
				defer tx.Rollback(ctx)
				if _, err = tx.Exec(ctx, `INSERT INTO execution_retry_receipts VALUES($1)`, first); err != nil {
					return false, err
				}
				if _, err = tx.Exec(ctx, `UPDATE execution_retry_rows SET value=value+1 WHERE id=$1`, first); err != nil {
					return false, err
				}
				// Both first attempts hold a different row before requesting the
				// other's lock, guaranteeing a real PostgreSQL deadlock.
				if attempts == 1 {
					ready <- struct{}{}
					select {
					case <-ctx.Done():
						return false, ctx.Err()
					case <-release:
					}
				}
				if _, err = tx.Exec(ctx, `UPDATE execution_retry_rows SET value=value+1 WHERE id=$1`, 3-first); err != nil {
					var postgresError *pgconn.PgError
					if errors.As(err, &postgresError) && postgresError.Code == "40P01" {
						deadlocks++
					}
					return false, err
				}
				return true, tx.Commit(ctx)
			})
			done <- outcome{attempts, deadlocks, err}
		}(first)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-ready:
		case result := <-done:
			t.Fatal("transaction failed before the deadlock barrier", result.err)
		case <-ctx.Done():
			t.Fatal("transactions did not reach the deadlock barrier", ctx.Err())
		}
	}
	close(release)
	attempts, deadlocks := 0, 0
	for i := 0; i < 2; i++ {
		select {
		case result := <-done:
			if result.err != nil {
				t.Fatal("complete transaction did not recover", result.err)
			}
			attempts += result.attempts
			deadlocks += result.deadlocks
		case <-ctx.Done():
			t.Fatal("deadlock recovery did not finish", ctx.Err())
		}
	}
	if attempts != 3 || deadlocks != 1 {
		t.Fatal("test did not exercise one real aborted-and-retried transaction", attempts, deadlocks)
	}
	var rows, minimum, maximum, receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*),min(value),max(value) FROM execution_retry_rows`).Scan(&rows, &minimum, &maximum); err != nil || rows != 2 || minimum != 2 || maximum != 2 {
		t.Fatal("aborted transaction writes survived or a result was lost", rows, minimum, maximum, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM execution_retry_receipts`).Scan(&receipts); err != nil || receipts != 2 {
		t.Fatal("transaction receipt was duplicated or lost", receipts, err)
	}
}

func executionLockFixture(t *testing.T) (context.Context, *pgxpool.Pool, domain.Task, string, string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool := testdb.New(t).Open(t)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	owner, project := "lock-owner", "lock-project"
	if _, err := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES($1,'lock@example.test','Lock fixture')`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,'Lock fixture')`, project, owner); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	task := domain.Task{ID: "tsk_lock_fixture", OwnerID: owner, InitiatedBy: owner, ProjectID: &project,
		Kind: "CANVAS", State: "QUEUED", Revision: 1, Plans: []domain.Plan{}, CreatedAt: now, UpdatedAt: now}
	key, hash, lease := uuid.NewString(), strings.Repeat("a", 64), uuid.NewString()
	body, err := encode(task)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO execution.tasks(id,owner_id,project_id,kind,state,request_hash,idempotency_key,payload,lease_token,lease_until,created_at,updated_at,initiated_by)
	 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '60 seconds',$10,$10,$2)`, task.ID, owner, project, task.Kind, task.State, hash, key, body, lease, now); err != nil {
		t.Fatal(err)
	}
	return ctx, pool, task, key, hash, lease
}

func executionLockPool(t *testing.T, ctx context.Context, original *pgxpool.Pool, tracer pgx.QueryTracer) (*pgxpool.Pool, int32) {
	t.Helper()
	configuration := original.Config()
	configuration.MaxConns = 1
	configuration.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var pid int32
	if err = pool.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	return pool, pid
}

func waitForExecutionLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pid int32) {
	t.Helper()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT COALESCE(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("SQL did not reach its controlled lock barrier", ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestPostgresReceiptReplayLocksTaskBeforeProject(t *testing.T) {
	ctx, pool, task, key, hash, _ := executionLockFixture(t)
	replayPool, replayPID := executionLockPool(t, ctx, pool, nil)
	store, _ := New(replayPool)
	worker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Rollback(ctx)
	if _, err = worker.Exec(ctx, `SELECT id FROM execution.tasks WHERE id=$1 FOR UPDATE`, task.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		replayed, err := store.Create(ctx, task, key, hash, nil)
		if err == nil && replayed.ID != task.ID {
			err = errors.New("receipt replay changed task identity")
		}
		done <- err
	}()
	waitForExecutionLock(t, ctx, pool, replayPID)
	// A replay blocked on this task must not already own its project. This is
	// the same task-before-project order used by Save, BindInputs and Cancel.
	if _, err = worker.Exec(ctx, `SET LOCAL lock_timeout='500ms'`); err != nil {
		t.Fatal(err)
	}
	if _, err = worker.Exec(ctx, `SELECT id FROM public.projects WHERE id=$1 FOR UPDATE`, *task.ProjectID); err != nil {
		t.Fatal("receipt replay inverted the worker task/project lock order", err)
	}
	if err = worker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("receipt replay did not resume after worker commit", ctx.Err())
	}
}

type executionProjectLockBarrier struct {
	once    sync.Once
	ready   chan struct{}
	release chan struct{}
}

func (b *executionProjectLockBarrier) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(data.SQL, "SELECT owner_id FROM public.projects ") && strings.HasSuffix(data.SQL, " FOR UPDATE") {
		b.once.Do(func() {
			close(b.ready)
			select {
			case <-b.release:
			case <-ctx.Done():
			}
		})
	}
	return ctx
}

func (*executionProjectLockBarrier) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
}

func TestPostgresSaveRetriesProjectAuthorizationDeadlock(t *testing.T) {
	ctx, pool, task, _, _, lease := executionLockFixture(t)
	barrier := &executionProjectLockBarrier{ready: make(chan struct{}), release: make(chan struct{})}
	savePool, _ := executionLockPool(t, ctx, pool, barrier)
	// The Save backend is the first detector only after a complete cycle exists.
	if _, err := savePool.Exec(ctx, `SET deadlock_timeout='50ms'`); err != nil {
		t.Fatal(err)
	}
	store, _ := New(savePool)
	other, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Rollback(ctx)
	if _, err = other.Exec(ctx, `SET LOCAL deadlock_timeout='5s'`); err != nil {
		t.Fatal(err)
	}
	if _, err = other.Exec(ctx, `SELECT id FROM public.projects WHERE id=$1 FOR UPDATE`, *task.ProjectID); err != nil {
		t.Fatal(err)
	}
	var otherPID int32
	if err = other.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&otherPID); err != nil {
		t.Fatal(err)
	}
	task.State = "RUNNING"
	saved := make(chan error, 1)
	go func() {
		ok, err := store.Save(ctx, task, lease)
		if err == nil && !ok {
			err = errors.New("Save lost the original lease during deadlock recovery")
		}
		saved <- err
	}()
	select {
	case <-barrier.ready:
	case <-ctx.Done():
		t.Fatal("Save did not lock its task before authorization", ctx.Err())
	}
	otherDone := make(chan error, 1)
	go func() {
		_, err := other.Exec(ctx, `SELECT id FROM execution.tasks WHERE id=$1 FOR UPDATE`, task.ID)
		if err == nil {
			err = other.Commit(ctx)
		}
		otherDone <- err
	}()
	waitForExecutionLock(t, ctx, pool, otherPID)
	close(barrier.release)
	for _, result := range []<-chan error{otherDone, saved} {
		select {
		case err = <-result:
			if err != nil {
				t.Fatal("real authorization deadlock did not retry atomically", err)
			}
		case <-ctx.Done():
			t.Fatal("authorization deadlock recovery did not finish", ctx.Err())
		}
	}
	got, err := store.Get(ctx, task.OwnerID, task.ID)
	if err != nil || got.State != "RUNNING" || got.ErrorCode != nil {
		t.Fatal("SQL failure was published as access revocation", got.State, got.ErrorCode, err)
	}
	var events int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM execution.events WHERE task_id=$1`, task.ID).Scan(&events); err != nil || events != 1 {
		t.Fatal("aborted Save duplicated or lost its state event", events, err)
	}
}
