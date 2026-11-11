package postgres

import (
	"context"
	"encoding/json"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/observability"
)

func (s *Store) WithObserver(o *observability.Observer) { s.observer = o }
func (s *Store) record(ctx context.Context, t domain.Task, stage string, notify bool) {
	if s.observer == nil {
		return
	}
	g := observability.Generation{ActorID: taskActor(t), TaskID: t.ID, Kind: t.Kind, State: t.State, Stage: stage, CreatedAt: t.CreatedAt, Notify: notify}
	if t.ProjectID != nil {
		g.ProjectID = *t.ProjectID
	}
	if t.ErrorCode != nil {
		g.ErrorCode = *t.ErrorCode
	}
	// Failed/running plan identifies which step of a multi-node run failed.
	var selected *domain.Plan
	for i := range t.Plans {
		p := &t.Plans[i]
		g.Outputs += len(p.Outputs)
		if selected == nil || p.State == "RUNNING" || p.State == "FAILED" {
			selected = p
		}
		if p.State == "FAILED" {
			break
		}
	}
	if selected != nil {
		enrichGeneration(&g, *selected)
	}
	s.observer.Generation(ctx, g)
}
func enrichGeneration(g *observability.Generation, p domain.Plan) {
	g.NodeID = p.NodeID
	g.ExecutionID = p.ExecutionID
	g.CapabilityRef = p.CapabilityRef
	g.CapabilityVersion = p.CapabilityVersion
	if p.InvocationRef != nil {
		g.InvocationRef = *p.InvocationRef
	}
	if g.ErrorCode == "" && p.ErrorCode != nil {
		g.ErrorCode = *p.ErrorCode
	}
	var n struct {
		Data struct {
			SceneCode       string `json:"sceneCode"`
			PromptSelection struct {
				SceneCode string `json:"sceneCode"`
			} `json:"promptSelection"`
		} `json:"data"`
	}
	_ = json.Unmarshal(p.NodeSnapshot, &n)
	g.SceneCode = n.Data.SceneCode
	if g.SceneCode == "" {
		g.SceneCode = n.Data.PromptSelection.SceneCode
	}
}
func (s *Store) recordSave(ctx context.Context, old, t domain.Task) {
	if s.observer == nil {
		return
	}
	for i, p := range t.Plans {
		if i < len(old.Plans) && old.Plans[i].State == p.State && sameInvocation(old.Plans[i].InvocationRef, p.InvocationRef) {
			continue
		}
		g := observability.Generation{ActorID: taskActor(t), TaskID: t.ID, Kind: t.Kind, State: p.State, Stage: "PLAN_UPDATED", CreatedAt: t.CreatedAt, Outputs: len(p.Outputs)}
		if t.ProjectID != nil {
			g.ProjectID = *t.ProjectID
		}
		enrichGeneration(&g, p)
		s.observer.Generation(ctx, g)
	}
	if old.State != t.State {
		s.record(ctx, t, "TASK_UPDATED", t.State == "FAILED")
	}
}
func sameInvocation(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func (s *Store) RecordRetry(ctx context.Context, t domain.Task, code string) {
	t.State = "RETRY_PENDING"
	t.ErrorCode = &code
	s.record(ctx, t, "UPSTREAM_RETRY", true)
}
