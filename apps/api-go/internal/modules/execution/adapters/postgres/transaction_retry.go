package postgres

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

// Each attempt must open and finish its entire SQL transaction before returning.
// Only PostgreSQL errors that guarantee transaction abort are retried; provider
// calls and business conflicts never belong inside this boundary.
func retryTransaction[T any](ctx context.Context, once func() (T, error)) (T, error) {
	var zero T
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return zero, err
		}
		result, err := once()
		var postgresError *pgconn.PgError
		if err == nil || attempt == 2 || !errors.As(err, &postgresError) || (postgresError.Code != "40P01" && postgresError.Code != "40001") {
			return result, err
		}
		timer := time.NewTimer(time.Duration(10*(1<<attempt)) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return zero, ctx.Err()
		case <-timer.C:
		}
	}
	return zero, nil
}

// Create/Save mutate plans and output tombstones. Isolate those slices so an
// aborted attempt cannot change the task used to start the next transaction.
// Private input bytes and references remain immutable and retain their fields.
func transactionTask(t domain.Task) domain.Task {
	t.Plans = slices.Clone(t.Plans)
	for i := range t.Plans {
		t.Plans[i].Outputs = slices.Clone(t.Plans[i].Outputs)
		if t.Plans[i].CanvasBinding != nil {
			binding := *t.Plans[i].CanvasBinding
			t.Plans[i].CanvasBinding = &binding
		}
	}
	return t
}
