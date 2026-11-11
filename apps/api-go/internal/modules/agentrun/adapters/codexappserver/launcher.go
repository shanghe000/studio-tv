package codexappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"sync"
	"time"

	app "studiotv.local/service/api/internal/modules/agentrun/application"
)

type isolatedFrames struct {
	conn      net.Conn
	reader    *bufio.Reader
	writeMu   sync.Mutex
	closeOnce sync.Once
	closed    chan struct{}
}

// The host launcher alone owns Docker access. The API receives only this one
// fixed-profile stdio channel, no exec/create/filesystem operation capability.
func openIsolated(ctx context.Context, socket string, r app.RuntimeRequest) (Frames, error) {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket {
		return nil, ErrUnavailable
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, ErrUnavailable
	}
	p := &isolatedFrames{conn: conn, reader: bufio.NewReaderSize(conn, 65536), closed: make(chan struct{})}
	owner := digest(struct{ Owner string }{r.OwnerID})
	scope := digest(struct{ Conversation, Profile, Tools, Prompt string }{r.ConversationID, r.ProfileVersion, r.ToolSchemaHash, r.PromptHash})
	run := digest(struct{ Run string }{r.RunID})
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	raw, _ := json.Marshal(map[string]any{"version": 1, "profile": ProfileVersion, "ownerKey": owner, "scopeKey": scope, "runKey": run})
	if _, err = conn.Write(append(raw, '\n')); err != nil {
		_ = conn.Close()
		return nil, ErrUnavailable
	}
	reply, err := readBoundedLine(p.reader, 4096)
	if err != nil {
		_ = conn.Close()
		return nil, ErrUnavailable
	}
	var ready struct {
		Ready   bool   `json:"ready"`
		Version string `json:"runtimeVersion"`
		Profile string `json:"profile"`
		Owner   string `json:"ownerKey"`
		Scope   string `json:"scopeKey"`
		Run     string `json:"runKey"`
	}
	if json.Unmarshal(reply, &ready) != nil || !ready.Ready || ready.Version != RuntimeVersion || ready.Profile != ProfileVersion || ready.Owner != owner || ready.Scope != scope || ready.Run != run {
		_ = conn.Close()
		return nil, ErrProfile
	}
	_ = conn.SetDeadline(time.Time{})
	go func() {
		select {
		case <-ctx.Done():
			_ = p.Close()
		case <-p.closed:
		}
	}()
	return p, nil
}
func readBoundedLine(r *bufio.Reader, limit int) ([]byte, error) {
	var out []byte
	for {
		part, prefix, err := r.ReadLine()
		if err != nil {
			return nil, err
		}
		if len(out)+len(part) > limit {
			return nil, ErrProtocol
		}
		out = append(out, part...)
		if !prefix {
			return out, nil
		}
	}
}
func (p *isolatedFrames) Send(ctx context.Context, raw json.RawMessage) error {
	if ctx.Err() != nil || !json.Valid(raw) || len(raw) > maxFrame {
		return ErrUnknown
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	deadline := time.Now().Add(30 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = p.conn.SetWriteDeadline(deadline)
	_, err := p.conn.Write(append(append([]byte(nil), raw...), '\n'))
	_ = p.conn.SetWriteDeadline(time.Time{})
	if err != nil {
		return ErrUnknown
	}
	return nil
}
func (p *isolatedFrames) Receive(ctx context.Context) (json.RawMessage, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	raw, err := readBoundedLine(p.reader, maxFrame)
	if err != nil {
		return nil, err
	}
	if !json.Valid(raw) {
		return nil, ErrProtocol
	}
	return raw, nil
}
func (p *isolatedFrames) Close() error {
	p.closeOnce.Do(func() { close(p.closed); _ = p.conn.Close() })
	return nil
}

var _ io.Closer = (*isolatedFrames)(nil)
