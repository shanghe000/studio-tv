package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

func TestTransactionRetryOnlyRetriesAbortedSQLTransactions(t *testing.T) {
	for _, code := range []string{"40P01", "40001"} {
		t.Run(code, func(t *testing.T) {
			attempts := 0
			value, err := retryTransaction(context.Background(), func() (int, error) {
				attempts++
				if attempts < 3 {
					return 0, fmt.Errorf("aborted transaction: %w", &pgconn.PgError{Code: code})
				}
				return 42, nil
			})
			if err != nil || value != 42 || attempts != 3 {
				t.Fatal("aborted transaction was not fully retried", value, attempts, err)
			}
			attempts = 0
			aborted := &pgconn.PgError{Code: code}
			_, err = retryTransaction(context.Background(), func() (int, error) {
				attempts++
				return 0, aborted
			})
			if err != aborted || attempts != 3 {
				t.Fatal("transaction retry exceeded its bound or lost the failure", attempts, err)
			}
		})
	}
	for _, failure := range []error{domain.ErrConflict, domain.ErrNotFound, domain.ErrInvalid, errors.New("connection lost after commit"), &pgconn.PgError{Code: "23505"}, &pgconn.PgError{Code: "08006"}} {
		attempts := 0
		_, err := retryTransaction(context.Background(), func() (bool, error) {
			attempts++
			return false, failure
		})
		if err != failure || attempts != 1 {
			t.Fatal("business or uncertain-commit failure was replayed", attempts, err)
		}
	}
}

func TestTransactionRetryHonorsCancellationBeforeAttemptAndDuringBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	attempts := 0
	_, err := retryTransaction(ctx, func() (bool, error) {
		attempts++
		return true, nil
	})
	if !errors.Is(err, context.Canceled) || attempts != 0 {
		t.Fatal("canceled transaction was started", attempts, err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	_, err = retryTransaction(ctx, func() (bool, error) {
		attempts++
		cancel()
		return false, &pgconn.PgError{Code: "40P01"}
	})
	if !errors.Is(err, context.Canceled) || attempts != 1 {
		t.Fatal("backoff ignored cancellation", attempts, err)
	}
	ctx, deadlineCancel := context.WithTimeout(context.Background(), 2*time.Millisecond)
	defer deadlineCancel()
	attempts = 0
	_, err = retryTransaction(ctx, func() (bool, error) {
		attempts++
		return false, &pgconn.PgError{Code: "40001"}
	})
	if !errors.Is(err, context.DeadlineExceeded) || attempts != 1 {
		t.Fatal("backoff ignored deadline", attempts, err)
	}
}

func TestTransactionTaskKeepsAbortedPlanChangesOutOfNextAttempt(t *testing.T) {
	input := domain.Task{Plans: []domain.Plan{{ExecutionID: "execution", Request: []byte(`{"frozen":true}`), InputReferences: []domain.InputReference{{HistoryTaskID: "source-task"}}, Outputs: []domain.Output{{ID: "output"}}}}}
	attempts := 0
	_, err := retryTransaction(context.Background(), func() (bool, error) {
		attempts++
		current := transactionTask(input)
		if current.Plans[0].CanvasBinding != nil || current.Plans[0].Outputs[0].DeletedAt != nil {
			t.Fatal("rolled-back writeback decisions contaminated a later attempt")
		}
		if string(current.Plans[0].Request) != `{"frozen":true}` || current.Plans[0].InputReferences[0].HistoryTaskID != "source-task" {
			t.Fatal("private frozen inputs were dropped from the retry")
		}
		current.Plans[0].CanvasBinding = &domain.CanvasBinding{ApplicationState: "DETACHED"}
		now := time.Now()
		current.Plans[0].Outputs[0].DeletedAt = &now
		if attempts == 1 {
			return false, &pgconn.PgError{Code: "40001"}
		}
		return true, nil
	})
	if err != nil || attempts != 2 || input.Plans[0].CanvasBinding != nil || input.Plans[0].Outputs[0].DeletedAt != nil {
		t.Fatal("transaction retry changed its original input", attempts, err)
	}
	input.Plans[0].CanvasBinding = &domain.CanvasBinding{ApplicationState: "PENDING"}
	input.Plans[0].Outputs = []domain.Output{}
	current := transactionTask(input)
	current.Plans[0].CanvasBinding.ApplicationState = "DETACHED"
	if input.Plans[0].CanvasBinding.ApplicationState != "PENDING" || current.Plans[0].Outputs == nil {
		t.Fatal("retry copy aliased the binding or changed an empty output array to null")
	}
}
