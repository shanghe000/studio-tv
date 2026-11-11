package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"time"
)

func presenceDeadline(id httpapi.Identity) (time.Time, error) {
	if id.AccessExpiresAt.IsZero() || id.SessionExpiresAt.IsZero() {
		return time.Time{}, httpapi.Fail(501, "PRESENCE_STREAM_AUTH_UNAVAILABLE", "当前鉴权适配器未提供安全的协作流截止时间。")
	}
	until := id.AccessExpiresAt
	if id.SessionExpiresAt.Before(until) {
		until = id.SessionExpiresAt
	}
	if !time.Now().Before(until) {
		return until, httpapi.Fail(401, "UNAUTHENTICATED", "登录凭据已过期，请重新登录。")
	}
	return until, nil
}
func samePresenceIdentity(a, b httpapi.Identity) bool {
	return a.UserID != "" && a.SessionID != "" && a.UserID == b.UserID && a.SessionID == b.SessionID && a.IPACIssuer == b.IPACIssuer && a.IPACSubjectID == b.IPACSubjectID && a.IPACSessionID == b.IPACSessionID && a.IPACSessionVersion == b.IPACSessionVersion
}
func presenceEarlier(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}
func (s *PresenceService) subscribeStream(project, user string) (chan struct{}, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Content streams separately allow two connections per account. Keep two
	// presence streams so an HTTP/1.1 browser still has slots for heartbeats,
	// lease mutations and graph saves; additional pages use bounded polling.
	if s.activeStreams >= 128 || s.userStreams[user] >= 2 {
		return nil, nil, httpapi.Retry(429, "PRESENCE_STREAM_LIMIT", "当前账号的协作连接已达到上限，请稍后重试。")
	}
	s.activeStreams++
	s.userStreams[user]++
	p := s.projectLocked(project)
	ch := make(chan struct{}, 1)
	p.watchers[ch] = struct{}{}
	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(p.watchers, ch)
		s.activeStreams--
		s.userStreams[user]--
		if s.userStreams[user] == 0 {
			delete(s.userStreams, user)
		}
		s.expireLocked(p, time.Now())
		if len(p.members) == 0 && len(p.watchers) == 0 {
			delete(s.projects, project)
		}
	}, nil
}
func (s *PresenceService) serveStream(w http.ResponseWriter, r *http.Request, project string) error {
	identity := httpapi.IdentityFrom(r)
	if err := presenceIdentity(identity); err != nil {
		return err
	}
	proof := httpapi.LiveAuthorizationFrom(r)
	if proof.Revalidate == nil {
		return httpapi.Fail(501, "PRESENCE_STREAM_AUTH_UNAVAILABLE", "当前接口没有实时重新鉴权，不能开启协作流。")
	}
	deadline, err := presenceDeadline(identity)
	if err != nil {
		return err
	}
	deadline = presenceEarlier(deadline, time.Now().Add(s.streamLifetime))
	initial, err := s.Snapshot(r.Context(), identity, project)
	if err != nil {
		return err
	}
	controller := http.NewResponseController(w)
	if controller.SetWriteDeadline(time.Time{}) != nil {
		return httpapi.Fail(501, "PRESENCE_STREAM_TRANSPORT_UNAVAILABLE", "当前连接不支持协作事件流。")
	}
	defer controller.SetWriteDeadline(time.Time{})
	changed, release, err := s.subscribeStream(project, identity.UserID)
	if err != nil {
		return err
	}
	defer release()
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	started := false
	lastAuth := time.Time{}
	lastSent := time.Time{}
	bytes, frames := 0, 0
	write := func(data []byte) error {
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			return context.DeadlineExceeded
		}
		if err := controller.SetWriteDeadline(presenceEarlier(deadline, time.Now().Add(5*time.Second))); err != nil {
			return err
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
		return controller.Flush()
	}
	failure := func(err error) error {
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			return nil
		}
		if !started {
			return err
		}
		var api *httpapi.Error
		if !errors.As(err, &api) {
			api = httpapi.Retry(503, "CANVAS_PRESENCE_UNAVAILABLE", "协作状态暂时不可用。")
		}
		raw, _ := json.Marshal(struct {
			Status    int    `json:"status"`
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		}{api.Status, api.Code, api.Message, api.Retryable})
		_ = write(append(append([]byte("event: stream.error\ndata: "), raw...), []byte("\n\n")...))
		return nil
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	snapshot := initial
	for {
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			return nil
		}
		// Local membership gates every snapshot. Session/tool scope revalidation is
		// bounded to one second; no frame follows a known authorization failure.
		if time.Since(lastAuth) >= s.streamReauthorize {
			child, stop := context.WithTimeout(ctx, 5*time.Second)
			fresh, authErr := proof.Revalidate(child)
			stop()
			if authErr != nil {
				return failure(authErr)
			}
			if !samePresenceIdentity(identity, fresh) {
				return failure(httpapi.Fail(401, "STREAM_IDENTITY_CHANGED", "协作登录身份已变更，请重新连接。"))
			}
			until, e := presenceDeadline(fresh)
			if e != nil {
				return failure(e)
			}
			deadline = presenceEarlier(deadline, until)
			lastAuth = time.Now()
		}
		if !started {
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(200)
			started = true
		}
		body, _ := json.Marshal(snapshot)
		frame := append(append([]byte("event: presence.snapshot\ndata: "), body...), []byte("\n\n")...)
		if len(frame) > 2*1024*1024 || bytes+len(frame) > 16*1024*1024 || frames >= 1024 {
			return nil
		}
		if write(frame) != nil {
			return nil
		}
		bytes += len(frame)
		frames++
		lastSent = time.Now()
		select {
		case <-ctx.Done():
			return nil
		case <-changed:
		case <-ticker.C:
		}
		if delay := s.streamPoll - time.Since(lastSent); delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil
			case <-timer.C:
			}
		}
		child, stop := context.WithTimeout(ctx, 5*time.Second)
		snapshot, err = s.Snapshot(child, identity, project)
		stop()
		if err != nil {
			return failure(err)
		}
	}
}
