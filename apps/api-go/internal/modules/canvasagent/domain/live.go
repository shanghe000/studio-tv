package domain

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

var ErrLiveUnavailable = errors.New("project event read unavailable")
var ErrEventCursorAhead = errors.New("project event cursor is ahead of current head")

const MaxEventPageSize = 100
const MaxEventBytes = 1024 * 1024
const MaxEventPageBytes = 2 * MaxEventBytes

// ParseEventCursor accepts canonical nonnegative signed-bigint decimal strings.
// Cursor values stay strings at the public boundary to avoid JS rounding.
func ParseEventCursor(value string) (int64, error) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 || strconv.FormatInt(parsed, 10) != value {
		return 0, ErrInvalid
	}
	return parsed, nil
}

type LiveSnapshot struct {
	SchemaVersion          string               `json:"schemaVersion"`
	ProjectID              string               `json:"projectId"`
	Graph                  json.RawMessage      `json:"graph"`
	GraphRevision          int64                `json:"graphRevision"`
	EventCursor            string               `json:"eventCursor"`
	UpdatedAt              time.Time            `json:"updatedAt"`
	NodeStates             []NodeExecutionState `json:"nodeStates"`
	NodeExecutionAvailable bool                 `json:"nodeExecutionAvailable"`
}

// NodeExecutionState is a read-only projection of the latest server binding for
// the current node incarnation. Persisted graph display fields are not evidence.
type NodeExecutionState struct {
	NodeID           string `json:"nodeId"`
	TaskID           string `json:"taskId"`
	ExecutionID      string `json:"executionId"`
	State            string `json:"state"`
	ApplicationState string `json:"applicationState"`
	Reason           string `json:"reason,omitempty"`
}

func (s NodeExecutionState) Validate() error {
	for _, id := range []string{s.NodeID, s.TaskID, s.ExecutionID} {
		if len(id) < 1 || len(id) > 200 {
			return ErrLiveUnavailable
		}
	}
	switch s.State {
	case "QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED":
	default:
		return ErrLiveUnavailable
	}
	switch s.ApplicationState {
	case "PENDING", "APPLIED", "DETACHED":
	default:
		return ErrLiveUnavailable
	}
	if len(s.Reason) > 200 {
		return ErrLiveUnavailable
	}
	return nil
}

type EventPage struct {
	ProjectID   string            `json:"projectId"`
	Events      []json.RawMessage `json:"events"`
	NextCursor  string            `json:"nextCursor"`
	HasMore     bool              `json:"hasMore"`
	EventCursor string            `json:"eventCursor"`
}

// ValidateProjectEvent checks immutable evidence before publishing it. The
// data remains its stored normalized event, rather than client-supplied state.
func ValidateProjectEvent(raw json.RawMessage, project string, sequence int64) error {
	var value struct {
		SchemaVersion string          `json:"schemaVersion"`
		ProjectID     string          `json:"projectId"`
		Sequence      string          `json:"sequence"`
		OccurredAt    time.Time       `json:"occurredAt"`
		Type          string          `json:"type"`
		Data          json.RawMessage `json:"data"`
		Source        struct {
			Kind string `json:"kind"`
		} `json:"source"`
	}
	if len(raw) > MaxEventBytes || json.Unmarshal(raw, &value) != nil || value.SchemaVersion != "1" || value.ProjectID != project || value.Sequence != strconv.FormatInt(sequence, 10) || sequence < 1 || value.OccurredAt.IsZero() || value.Source.Kind != "API" {
		return ErrLiveUnavailable
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(value.Data, &data) != nil || data == nil {
		return ErrLiveUnavailable
	}
	var payload struct {
		CommandID     string      `json:"commandId"`
		BaseRevision  int64       `json:"baseRevision"`
		GraphRevision int64       `json:"graphRevision"`
		Delta         *GraphDelta `json:"delta"`
		Reason        string      `json:"reason"`
	}
	if json.Unmarshal(value.Data, &payload) != nil || payload.BaseRevision < 1 || payload.GraphRevision < payload.BaseRevision {
		return ErrLiveUnavailable
	}
	switch value.Type {
	case "canvas.changed":
		if !ValidCommandID(payload.CommandID) || payload.GraphRevision != payload.BaseRevision+1 || payload.Delta == nil || payload.Delta.NodesUpsert == nil || payload.Delta.NodesRemoved == nil || payload.Delta.EdgesUpsert == nil || payload.Delta.EdgesRemoved == nil {
			return ErrLiveUnavailable
		}
	case "canvas.invalidated":
		if payload.CommandID != "" && !ValidCommandID(payload.CommandID) {
			return ErrLiveUnavailable
		}
		switch payload.Reason {
		case "LEGACY_GRAPH_WRITE", "REVISION_ONLY", "PROJECT_DELETED", "UNREPRESENTABLE_CHANGE", "DELTA_TOO_LARGE":
		default:
			return ErrLiveUnavailable
		}
	default:
		// Execution events remain reserved until real binding/projection and
		// its own validated payload schema have been implemented.
		return ErrLiveUnavailable
	}
	return nil
}

// ReplayProjectEvent bounds the actual JSON representation too: HTML-significant
// characters can expand when the response encoder escapes them. An immutable
// changed event may be safely projected as a same-cursor invalidation.
func ReplayProjectEvent(raw json.RawMessage, project string, sequence int64) (json.RawMessage, error) {
	if err := ValidateProjectEvent(raw, project, sequence); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, ErrLiveUnavailable
	}
	if len(encoded) <= MaxEventBytes {
		return encoded, nil
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil || string(envelope["type"]) != `"canvas.changed"` {
		return nil, ErrLiveUnavailable
	}
	var data struct {
		CommandID     string `json:"commandId"`
		BaseRevision  int64  `json:"baseRevision"`
		GraphRevision int64  `json:"graphRevision"`
	}
	if json.Unmarshal(envelope["data"], &data) != nil {
		return nil, ErrLiveUnavailable
	}
	envelope["type"] = json.RawMessage(`"canvas.invalidated"`)
	envelope["data"], err = json.Marshal(map[string]any{"commandId": data.CommandID, "baseRevision": data.BaseRevision, "graphRevision": data.GraphRevision, "reason": "DELTA_TOO_LARGE"})
	if err != nil {
		return nil, ErrLiveUnavailable
	}
	encoded, err = json.Marshal(envelope)
	if err != nil || len(encoded) > MaxEventBytes {
		return nil, ErrLiveUnavailable
	}
	return encoded, nil
}
