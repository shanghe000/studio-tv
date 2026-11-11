package domain

import "testing"

func TestModelCancellationDoesNotChangeLocalProcessors(t *testing.T) {
	for _, kind := range []string{"CANVAS", "ASSISTANT", "MEDIA", "STUDIO"} {
		for _, state := range []string{"QUEUED", "RUNNING", "SUCCEEDED"} {
			for _, claimed := range []bool{false, true} {
				task := Task{Kind: kind, State: state, Plans: []Plan{{CapabilityRef: "local-or-router", State: state, TestMode: false}}}
				want := (kind == "CANVAS" || kind == "ASSISTANT") && state != "SUCCEEDED" && (claimed || state != "QUEUED")
				if task.RequiresNativeCancellation(claimed) != want {
					t.Fatalf("kind=%s state=%s claimed=%v", kind, state, claimed)
				}
				task.Plans[0].TestMode = true
				if task.RequiresNativeCancellation(claimed) {
					t.Fatal("fixture cancellation blocked")
				}
			}
		}
	}
}
