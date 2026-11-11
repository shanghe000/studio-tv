// Package canvaswake accelerates replay of committed canvas changes. A wake
// carries no graph data and is never an authorization grant or a cursor.
package canvaswake

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[chan struct{}]struct{}
}

func New() *Hub { return &Hub{rooms: make(map[string]map[chan struct{}]struct{})} }

// Subscribe precedes the first database read so a commit racing the initial
// read is either visible in that read or leaves a pending wake.
func (h *Hub) Subscribe(project string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	room := h.rooms[project]
	if room == nil {
		room = make(map[chan struct{}]struct{})
		h.rooms[project] = room
	}
	room[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(room, ch)
		if len(room) == 0 && len(h.rooms[project]) == 0 {
			delete(h.rooms, project)
		}
	}
}
func (h *Hub) wake(project string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.rooms[project] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// One dedicated database connection per API process, independent of active
// tabs and of the query pool. On an interruption, the SSE replay poll remains
// live. PostgreSQL sends NOTIFY only after the enclosing graph commit.
func (h *Hub) Run(ctx context.Context, cfg *pgx.ConnConfig) {
	for ctx.Err() == nil {
		c, err := pgx.ConnectConfig(ctx, cfg.Copy())
		if err == nil {
			_, err = c.Exec(ctx, "LISTEN studiotv_canvas_commit")
			for err == nil && ctx.Err() == nil {
				n, e := c.WaitForNotification(ctx)
				err = e
				if err == nil && n != nil {
					h.wake(n.Payload)
				}
			}
			closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			_ = c.Close(closeCtx)
			cancel()
		}
		t := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}
