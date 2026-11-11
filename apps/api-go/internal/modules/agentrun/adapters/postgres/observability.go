package postgres

import (
	"context"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	"studiotv.local/service/api/internal/observability"
)

func (s *Store) WithObserver(o *observability.Observer) { s.observer = o }
func (s *Store) record(ctx context.Context, r domain.Run, stage string, notify bool) {
	if s.observer == nil {
		return
	}
	code := ""
	if r.ErrorCode != nil {
		code = *r.ErrorCode
	}
	s.observer.Generation(ctx, observability.Generation{ActorID: r.OwnerID, TaskID: r.ID, ProjectID: r.ProjectID, Kind: "AGENT", CapabilityRef: r.CapabilityRef, CapabilityVersion: r.CapabilityVersion, State: string(r.State), Stage: stage, ErrorCode: code, CreatedAt: r.CreatedAt, Notify: notify})
}
