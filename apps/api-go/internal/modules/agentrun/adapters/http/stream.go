package http

import (
	"context"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	"strconv"
	"strings"
	"sync"
	"time"
)

func wantsSSE(r *http.Request) bool {
	stream := false
	for _, value := range r.Header.Values("Accept") {
		for _, part := range strings.Split(value, ",") {
			kind, params, e := mime.ParseMediaType(strings.TrimSpace(part))
			if e != nil {
				continue
			}
			if raw, ok := params["q"]; ok {
				quality, e := strconv.ParseFloat(raw, 64)
				if e != nil || quality <= 0 || quality > 1 {
					continue
				}
			}
			if kind == "application/json" || kind == "application/*" || kind == "*/*" {
				return false
			}
			stream = stream || kind == "text/event-stream"
		}
	}
	return stream
}

// Streams use bounded admission, live authorization and the frozen JWT expiry.
// Clients reconnect with fresh Authorization and the last durable cursor.
type streamAdmission struct {
	mu     sync.Mutex
	count  int
	owners map[string]int
}

func newAdmission() *streamAdmission { return &streamAdmission{owners: map[string]int{}} }
func (a *streamAdmission) serve(w http.ResponseWriter, r *http.Request, s *application.Service, id string, after int64, limit int) error {
	who := httpapi.IdentityFrom(r)
	live := httpapi.LiveAuthorizationFrom(r)
	if who.AccessExpiresAt.IsZero() || who.SessionExpiresAt.IsZero() || live.Revalidate == nil {
		return httpapi.Fail(501, "STREAM_AUTH_UNAVAILABLE", "实时Agent事件需要登录截止时间与实时授权检查。")
	}
	expiry := who.AccessExpiresAt
	if who.SessionExpiresAt.Before(expiry) {
		expiry = who.SessionExpiresAt
	}
	if time.Now().Add(25 * time.Second).Before(expiry) {
		expiry = time.Now().Add(25 * time.Second)
	}
	if !time.Now().Before(expiry) {
		return domain.ErrAuth
	}
	ctx, cancel := context.WithDeadline(r.Context(), expiry)
	defer cancel()
	r = r.WithContext(ctx)
	a.mu.Lock()
	if a.count >= 64 || a.owners[who.UserID] >= 2 {
		a.mu.Unlock()
		return httpapi.Retry(429, "STREAM_LIMIT", "实时事件连接已达到上限。")
	}
	a.count++
	a.owners[who.UserID]++
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.count--; a.owners[who.UserID]--; a.mu.Unlock() }()
	controller := http.NewResponseController(w)
	if e := controller.SetWriteDeadline(expiry); e != nil {
		return httpapi.Fail(501, "STREAM_TRANSPORT_UNAVAILABLE", "当前传输不支持有界事件写入。")
	}
	defer controller.SetWriteDeadline(time.Time{})
	started := false
	sent := 0
	timer := time.NewTicker(400 * time.Millisecond)
	defer timer.Stop()
	streamError := func(e error) error {
		if !started {
			return e
		}
		raw, _ := json.Marshal(map[string]any{"code": "STREAM_AUTH_OR_STORAGE_UNAVAILABLE"})
		_, _ = fmt.Fprintf(w, "event: stream.error\ndata: %s\n\n", raw)
		_ = controller.Flush()
		return nil
	}
	for {
		if ctx.Err() != nil || !time.Now().Before(expiry) {
			return nil
		}
		current, e := live.Revalidate(ctx)
		if e != nil {
			return streamError(e)
		}
		if current.UserID != who.UserID || current.SessionID != who.SessionID || !time.Now().Before(current.SessionExpiresAt) {
			return streamError(domain.ErrAuth)
		}
		page, e := s.Events(ctx, who.UserID, id, after, limit)
		if e != nil {
			return streamError(e)
		}
		if ctx.Err() != nil || !time.Now().Before(expiry) {
			return nil
		}
		if !started {
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(200)
			started = true
		}
		for _, item := range page.Items {
			if ctx.Err() != nil || !time.Now().Before(expiry) {
				return nil
			}
			raw, e := json.Marshal(item)
			if e != nil {
				return nil
			}
			if _, e = fmt.Fprintf(w, "id: %s\nevent: %s\ndata: %s\n\n", item.Sequence, item.Type, raw); e != nil {
				return nil
			}
			if e = controller.Flush(); e != nil {
				return nil
			}
			after, _ = strconv.ParseInt(item.Sequence, 10, 64)
			sent++
			if sent >= 200 {
				return nil
			}
		}
		if page.Terminal && len(page.Items) < limit {
			return nil
		}
		if len(page.Items) == limit {
			continue
		}
		if _, e = fmt.Fprint(w, ": heartbeat\n\n"); e != nil {
			return nil
		}
		if controller.Flush() != nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
	}
}
