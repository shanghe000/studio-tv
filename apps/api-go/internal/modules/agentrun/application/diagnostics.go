package application

import (
	"context"
	"errors"
	"log/slog"

	"studiotv.local/service/api/internal/modules/agentrun/domain"
)

// Only fixed classifications cross the logging boundary. Errors can contain
// private HTTP or database material and must never be serialized here.
func logRunFailure(ctx context.Context, runID, stage string, err error) {
	class := "OTHER"
	switch {
	case errors.Is(err, context.Canceled):
		class = "CANCELED"
	case errors.Is(err, context.DeadlineExceeded):
		class = "DEADLINE_EXCEEDED"
	case errors.Is(err, domain.ErrUnavailable):
		class = "UNAVAILABLE"
	case errors.Is(err, domain.ErrFenced):
		class = "LEASE_FENCED"
	case errors.Is(err, domain.ErrAuth):
		class = "AUTH_REQUIRED"
	case errors.Is(err, domain.ErrBudget):
		class = "TOOL_BUDGET"
	case errors.Is(err, domain.ErrToolRejected):
		class = "TOOL_REJECTED"
	case errors.Is(err, domain.ErrConflict):
		class = "CONFLICT"
	case errors.Is(err, domain.ErrInvalid):
		class = "INVALID"
	case errors.Is(err, domain.ErrNotFound):
		class = "NOT_FOUND"
	}
	contextState := "ACTIVE"
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		contextState = "CANCELED"
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		contextState = "DEADLINE_EXCEEDED"
	}
	attrs := []any{"runId", runID, "stage", stage, "errorClass", class, "contextState", contextState}
	var verification *VerificationFailure
	if errors.As(err, &verification) {
		attrs = append(attrs, "verificationStatus", verification.status, "verificationCode", verification.code)
	}
	slog.WarnContext(ctx, "Agent operation stopped", attrs...)
}
