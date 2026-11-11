package application

import (
	"context"
	"errors"
	"testing"
)

func TestUnconfiguredExecutionDoesNotAcceptOrInventInvocation(t *testing.T) {
	var gateway InvocationGateway = Unconfigured{}
	actor := Actor{SubjectRef: "verified_user"}
	calls := map[string]func() (Invocation, error){
		"submit": func() (Invocation, error) {
			return gateway.Submit(context.Background(), actor, Submission{IdempotencyKey: "attempt_1"})
		},
		"read": func() (Invocation, error) {
			return gateway.Invocation(context.Background(), actor, "inv_1")
		},
		"cancel": func() (Invocation, error) {
			return gateway.Cancel(context.Background(), actor, "inv_1", CancelRequest{})
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			value, err := call()
			if !errors.Is(err, ErrNotConfigured) || value.Ref != "" || value.State != "" || len(value.OutputParts) != 0 || len(value.Artifacts) != 0 || value.Usage != nil || value.Context != nil || value.Billing != nil {
				t.Fatal("unconfigured execution must return a failure with no receipt, state, output or measurement")
			}
		})
	}
}
