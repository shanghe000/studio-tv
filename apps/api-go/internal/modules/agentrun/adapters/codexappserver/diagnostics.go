package codexappserver

import (
	"context"
	"errors"
	"log/slog"
)

type runtimePhase uint8

const (
	phaseValidate runtimePhase = iota
	phaseOpen
	phaseInitialize
	phaseThreadStart
	phaseThreadResume
	phaseSubmissionCheckpoint
	phaseTurnStart
	phaseBind
	phaseAcceptedCheckpoint
	phaseEvents
	phaseNotification
	phaseToolWorker
	phaseSnapshot
	phaseTranscript
	phaseToolHandler
	phaseToolReceipt
	phaseToolCheckpoint
	phaseToolResponse
	phaseTransportReceive
	phaseTransportFrame
	phaseTransportRequest
	phaseTransportQueue
	phaseTransportReply
	phaseTransportClosed
	phaseRPCWait
)

var phaseNames = [...]string{"validate", "open", "initialize", "thread_start", "thread_resume", "submission_checkpoint", "turn_start", "bind", "accepted_checkpoint", "events", "notification", "tool_worker", "snapshot", "transcript", "tool_handler", "tool_receipt", "tool_checkpoint", "tool_response", "transport_receive", "transport_frame", "transport_request", "transport_queue", "transport_reply", "transport_closed", "rpc_wait"}

// Only fixed stage/error enums and cancellation bits enter private operator
// diagnostics. Never format an error, frame, native identity or tool payload.
func diagnoseRuntime(ctx context.Context, phase runtimePhase, err error) {
	if err == nil {
		return
	}
	name := "unclassified"
	if int(phase) < len(phaseNames) {
		name = phaseNames[phase]
	}
	class := "ErrUnknown"
	switch {
	case errors.Is(err, ErrProfile):
		class = "ErrProfile"
	case errors.Is(err, ErrProtocol):
		class = "ErrProtocol"
	case errors.Is(err, ErrUnavailable):
		class = "ErrUnavailable"
	case errors.Is(err, ErrCanceled):
		class = "ErrCanceled"
	case errors.Is(err, ErrTurnFailed):
		class = "ErrTurnFailed"
	}
	slog.Warn("codex agent runtime stopped", "phase", name, "error_class", class, "context_canceled", errors.Is(ctx.Err(), context.Canceled), "context_deadline", errors.Is(ctx.Err(), context.DeadlineExceeded))
}
