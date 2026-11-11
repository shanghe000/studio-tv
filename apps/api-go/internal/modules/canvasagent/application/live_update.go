package application

import (
	"context"
	"encoding/json"
	"studiotv.local/service/api/internal/canvasdelta"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	"time"
)

// The envelope is assembled solely from the existing authorized repeatable-read
// snapshot. Newer database state cannot be paired with an earlier event cursor.
type LiveUpdate struct {
	SchemaVersion          string                      `json:"schemaVersion"`
	ProjectID              string                      `json:"projectId"`
	GraphRevision          int64                       `json:"graphRevision"`
	EventCursor            string                      `json:"eventCursor"`
	UpdatedAt              time.Time                   `json:"updatedAt"`
	NodeStates             []domain.NodeExecutionState `json:"nodeStates"`
	NodeExecutionAvailable bool                        `json:"nodeExecutionAvailable"`
	Kind                   string                      `json:"kind"`
	FromRevision           int64                       `json:"fromRevision,omitempty"`
	Graph                  json.RawMessage             `json:"graph,omitempty"`
	Delta                  *canvasdelta.Delta          `json:"delta,omitempty"`
}

func (s *LiveService) HasDelta(project string, from, to int64) bool {
	return s.deltas.Has(project, from, to)
}
func (s *LiveService) Update(ctx context.Context, actor, project string, from int64) (LiveUpdate, error) {
	var v LiveUpdate
	snap, e := s.Snapshot(ctx, actor, project)
	if e != nil {
		return v, e
	}
	v = LiveUpdate{SchemaVersion: snap.SchemaVersion, ProjectID: snap.ProjectID, GraphRevision: snap.GraphRevision, EventCursor: snap.EventCursor, UpdatedAt: snap.UpdatedAt, NodeStates: snap.NodeStates, NodeExecutionAvailable: snap.NodeExecutionAvailable, Kind: "SNAPSHOT", Graph: snap.Graph}
	s.deltas.WaitForCommit(ctx, project, from, snap.GraphRevision)
	if e = ctx.Err(); e != nil {
		return LiveUpdate{}, e
	}
	if delta, ok := s.deltas.Read(snap.ProjectID, from, snap.GraphRevision, snap.Graph); ok {
		v.Kind = "DELTA"
		v.Graph = nil
		v.FromRevision = from
		v.Delta = delta
	}
	return v, nil
}
