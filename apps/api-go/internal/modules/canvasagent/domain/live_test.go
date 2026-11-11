package domain

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestEventCursorCanonicalBigint(t *testing.T) {
	for _, valid := range []string{"0", "1", "9007199254740993", "9223372036854775807"} {
		if _, err := ParseEventCursor(valid); err != nil {
			t.Fatal("valid precision-safe cursor rejected", valid)
		}
	}
	for _, invalid := range []string{"", "-1", "+1", "01", "00", "1.0", "1e3", " 1", "1 ", "١", "9223372036854775808"} {
		if _, err := ParseEventCursor(invalid); err == nil {
			t.Fatal("ambiguous or out-of-range cursor admitted", invalid)
		}
	}
}

func TestNodeExecutionStateRequiresBoundIdentityAndImplementedStates(t *testing.T) {
	valid := NodeExecutionState{NodeID: "node", TaskID: "task", ExecutionID: "execution", State: "SUCCEEDED", ApplicationState: "APPLIED"}
	for _, state := range []string{"QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"} {
		for _, application := range []string{"PENDING", "APPLIED", "DETACHED"} {
			candidate := valid
			candidate.State, candidate.ApplicationState = state, application
			if err := candidate.Validate(); err != nil {
				t.Fatal("implemented node state rejected", candidate, err)
			}
		}
	}
	for _, alter := range []func(*NodeExecutionState){
		func(s *NodeExecutionState) { s.NodeID = "" },
		func(s *NodeExecutionState) { s.TaskID = "" },
		func(s *NodeExecutionState) { s.ExecutionID = strings.Repeat("x", 201) },
		func(s *NodeExecutionState) { s.State = "WAITING_TOOL" },
		func(s *NodeExecutionState) { s.ApplicationState = "SUCCESS" },
		func(s *NodeExecutionState) { s.Reason = strings.Repeat("x", 201) },
	} {
		candidate := valid
		alter(&candidate)
		if candidate.Validate() == nil {
			t.Fatal("invalid or reserved node-state evidence admitted", candidate)
		}
	}
}

func TestProjectEventRejectsCorruptAndReservedEvidence(t *testing.T) {
	valid := `{"schemaVersion":"1","projectId":"project","sequence":"1","occurredAt":"2026-10-06T00:00:00Z","source":{"kind":"API"},"type":"canvas.invalidated","data":{"baseRevision":1,"graphRevision":2,"reason":"LEGACY_GRAPH_WRITE"}}`
	if err := ValidateProjectEvent(json.RawMessage(valid), "project", 1); err != nil {
		t.Fatal(err)
	}
	for _, corrupt := range []string{
		strings.Replace(valid, `"projectId":"project"`, `"projectId":"foreign"`, 1),
		strings.Replace(valid, `"sequence":"1"`, `"sequence":"01"`, 1),
		strings.Replace(valid, `"graphRevision":2`, `"graphRevision":0`, 1),
		strings.Replace(valid, `"reason":"LEGACY_GRAPH_WRITE"`, `"reason":"SUCCESS"`, 1),
		strings.Replace(valid, `"kind":"API"`, `"kind":"AGENT"`, 1),
		strings.Replace(valid, `"type":"canvas.invalidated"`, `"type":"node.execution.changed"`, 1),
		strings.Replace(valid, `"type":"canvas.invalidated"`, `"type":"canvas.changed"`, 1),
	} {
		if err := ValidateProjectEvent(json.RawMessage(corrupt), "project", 1); err == nil {
			t.Fatal("corrupt or reserved event published")
		}
	}
}

func TestReplayEventByteBoundIncludesJSONEscaping(t *testing.T) {
	// PostgreSQL emits literal '<'; Go's JSON response expands it to '\u003c'.
	raw := json.RawMessage(fmt.Sprintf(`{"schemaVersion":"1","projectId":"project","sequence":"1","occurredAt":"2026-10-06T00:00:00Z","source":{"kind":"API"},"type":"canvas.changed","data":{"commandId":"cmd_one","baseRevision":1,"graphRevision":2,"delta":{"nodesUpsert":[{"id":"text","data":{"text":%q}}],"nodesRemoved":[],"edgesUpsert":[],"edgesRemoved":[]}}}`, strings.Repeat("<", MaxEventBytes/2)))
	replayed, err := ReplayProjectEvent(raw, "project", 1)
	if err != nil || len(replayed) > 4096 || !strings.Contains(string(replayed), `"reason":"DELTA_TOO_LARGE"`) || !strings.Contains(string(replayed), `"sequence":"1"`) {
		t.Fatal("escaped historical event bypassed wire bound", len(replayed), err)
	}
}
