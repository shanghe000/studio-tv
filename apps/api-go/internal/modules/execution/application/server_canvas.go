package application

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/principal"
)

// ServerCanvasCommand intentionally has no graph: only persisted owned input
// may enter a trusted Agent execution. The CAS is part of the durable digest.
type ServerCanvasCommand struct {
	Target struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"target"`
}
type serverCanvasStore interface {
	CanvasSnapshot(context.Context, string, string) (json.RawMessage, int64, error)
	CanvasReceipt(context.Context, string, string, string) (domain.Task, bool, error)
}
type CanvasRevisionConflict struct{ Current int64 }

func (e *CanvasRevisionConflict) Error() string { return "canvas revision changed" }

func (s *Service) ServerCanvas(ctx context.Context, owner, project, key string, expected int64, cmd ServerCanvasCommand) (domain.Task, error) {
	if owner == "" || project == "" || len(project) > 200 || expected < 1 || cmd.Target.Type != "NODE" || cmd.Target.ID == "" || len(cmd.Target.ID) > 200 {
		return domain.Task{}, domain.ErrInvalid
	}
	normalized, hash, err := keyHash(key, struct {
		Operation, Project string
		Revision           int64
		Command            ServerCanvasCommand
	}{"serverCanvasExecution", project, expected, cmd})
	if err != nil {
		return domain.Task{}, err
	}
	ctx, storage, err := s.projectScope(ctx, owner, project)
	if err != nil {
		return domain.Task{}, err
	}
	normalized = actorKey(normalized, principal.Actor(ctx, owner), storage)
	owner = storage
	// Keep the existing /canvas-runs key domain independent.
	normalized = uuid.NewSHA1(uuid.NameSpaceOID, []byte("studio-server-canvas/"+normalized)).String()
	store, ok := s.store.(serverCanvasStore)
	if !ok {
		return domain.Task{}, domain.ErrInvalid
	}
	if prior, found, e := store.CanvasReceipt(ctx, owner, normalized, hash); e != nil || found {
		return prior, e
	}
	raw, current, err := store.CanvasSnapshot(ctx, owner, project)
	if err != nil {
		return domain.Task{}, err
	}
	if current != expected {
		return domain.Task{}, &CanvasRevisionConflict{Current: current}
	}
	frozen, err := serverInputClosure(raw, cmd.Target.ID)
	if err != nil {
		return domain.Task{}, err
	}
	task, err := s.canvas(ctx, owner, normalized, hash, domain.CanvasCommand{ProjectID: project, TargetType: "NODE", TargetID: cmd.Target.ID, ExpectedRevision: &expected, Graph: frozen})
	if errors.Is(err, domain.ErrConflict) { // A concurrent graph change after the read is still CAS failure.
		if prior, found, e := store.CanvasReceipt(ctx, owner, normalized, hash); e != nil || found {
			return prior, e
		}
		if _, latest, e := store.CanvasSnapshot(ctx, owner, project); e == nil && latest != expected {
			return domain.Task{}, &CanvasRevisionConflict{Current: latest}
		}
	}
	return task, err
}

// Trim unrelated large canvases without changing input order, node contents,
// edge extensions or the writeback guard. Execution limits apply to the closure.
func serverInputClosure(raw json.RawMessage, target string) (json.RawMessage, error) {
	var g struct {
		Nodes []json.RawMessage `json:"nodes"`
		Edges []json.RawMessage `json:"edges"`
	}
	if json.Unmarshal(raw, &g) != nil || g.Nodes == nil || g.Edges == nil {
		return nil, domain.ErrInvalid
	}
	ids := map[string]bool{}
	incoming := map[string][]string{}
	for _, b := range g.Nodes {
		var n struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(b, &n) != nil || n.ID == "" || ids[n.ID] {
			return nil, domain.ErrInvalid
		}
		ids[n.ID] = true
	}
	if !ids[target] || target == "rhtv_meta_v1" {
		return nil, domain.ErrInvalid
	}
	for _, b := range g.Edges {
		var e domain.Edge
		if json.Unmarshal(b, &e) != nil || !ids[e.Source] || !ids[e.Target] {
			return nil, domain.ErrInvalid
		}
		incoming[e.Target] = append(incoming[e.Target], e.Source)
	}
	chosen := map[string]bool{target: true}
	queue := []string{target}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		for _, src := range incoming[n] {
			if !chosen[src] {
				chosen[src] = true
				queue = append(queue, src)
			}
		}
		if len(chosen) > 499 {
			return nil, domain.ErrInvalid
		}
	}
	nodes, edges := []json.RawMessage{}, []json.RawMessage{}
	for _, b := range g.Nodes {
		var n struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(b, &n)
		if chosen[n.ID] || n.ID == "rhtv_meta_v1" {
			nodes = append(nodes, b)
		}
	}
	for _, b := range g.Edges {
		var e domain.Edge
		_ = json.Unmarshal(b, &e)
		if chosen[e.Target] {
			edges = append(edges, b)
		}
	}
	if len(nodes) > 500 || len(edges) > 2000 {
		return nil, domain.ErrInvalid
	}
	return json.Marshal(map[string]any{"nodes": nodes, "edges": edges})
}
