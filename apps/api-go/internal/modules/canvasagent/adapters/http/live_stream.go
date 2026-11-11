package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"studiotv.local/service/api/internal/canvaswake"
	"strconv"
	"sync"
	"time"

	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

const maxStreamLifetime = 30 * time.Second
const streamPollInterval = time.Second
const streamHeartbeatInterval = 10 * time.Second
const streamOperationTimeout = 5 * time.Second
const maxStreamBytes = 8 * 1024 * 1024
const maxStreamEvents = 1024

type projectStream struct {
	wake                                 *canvaswake.Hub
	service                              *application.LiveService
	mu                                   sync.Mutex
	users                                map[string]int
	active, maxActive, maxUser           int
	lifetime, poll, heartbeat, operation time.Duration
}

func newProjectStream(service *application.LiveService) *projectStream {
	return &projectStream{service: service, users: map[string]int{}, maxActive: 128, maxUser: 8,
		lifetime: maxStreamLifetime, poll: streamPollInterval, heartbeat: streamHeartbeatInterval, operation: streamOperationTimeout}
}
func (s *projectStream) acquire(user string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active >= s.maxActive || s.users[user] >= s.maxUser {
		return false
	}
	s.active++
	s.users[user]++
	return true
}
func (s *projectStream) release(user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active--
	s.users[user]--
	if s.users[user] == 0 {
		delete(s.users, user)
	}
}
func sameStreamIdentity(a, b httpapi.Identity) bool {
	return a.UserID != "" && a.SessionID != "" && a.UserID == b.UserID && a.SessionID == b.SessionID &&
		a.IPACIssuer == b.IPACIssuer && a.IPACSubjectID == b.IPACSubjectID && a.IPACSessionID == b.IPACSessionID && a.IPACSessionVersion == b.IPACSessionVersion
}
func earlier(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}
func verifiedDeadline(identity httpapi.Identity) (time.Time, error) {
	if identity.AccessExpiresAt.IsZero() || identity.SessionExpiresAt.IsZero() {
		return time.Time{}, httpapi.Fail(501, "EVENT_STREAM_AUTH_UNAVAILABLE", "当前鉴权适配器未提供安全的实时流截止时间。")
	}
	deadline := earlier(identity.AccessExpiresAt, identity.SessionExpiresAt)
	if !time.Now().Before(deadline) {
		return time.Time{}, httpapi.Fail(401, "UNAUTHENTICATED", "登录凭据已过期，请重新登录。")
	}
	return deadline, nil
}
func supportsFlush(w http.ResponseWriter) bool {
	if _, ok := w.(http.Flusher); ok {
		return true
	}
	if wrapped, ok := w.(interface{ Unwrap() http.ResponseWriter }); ok {
		return supportsFlush(wrapped.Unwrap())
	}
	return false
}

// Returning on cancellation must not wait for a driver's bounded rollback.
// The admission lease remains held until that operation actually finishes.
func streamOperation[T any](ctx context.Context, deadline time.Time, operation func(context.Context) (T, error)) (T, error, <-chan struct{}) {
	var zero T
	child, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	type outcome struct {
		value T
		err   error
	}
	result := make(chan outcome, 1)
	done := make(chan struct{})
	go func() { value, err := operation(child); close(done); result <- outcome{value, err} }()
	select {
	case value := <-result:
		return value.value, value.err, done
	case <-child.Done():
		return zero, child.Err(), done
	}
}

func (s *projectStream) serve(w http.ResponseWriter, r *http.Request, identity httpapi.Identity, project string, after int64, limit int) error {
	proof := httpapi.LiveAuthorizationFrom(r)
	if proof.Revalidate == nil {
		return httpapi.Fail(501, "EVENT_STREAM_AUTH_UNAVAILABLE", "当前接口没有实时重新鉴权，不能开启事件流。")
	}
	deadline, err := verifiedDeadline(identity)
	if err != nil {
		return err
	}
	deadline = earlier(deadline, time.Now().Add(s.lifetime))
	if !s.acquire(identity.UserID) {
		return httpapi.Retry(429, "EVENT_STREAM_LIMIT", "当前账号的画布实时连接已达到上限，请稍后重试。")
	}
	var operationDone <-chan struct{}
	defer func() {
		if operationDone == nil {
			s.release(identity.UserID)
			return
		}
		select {
		case <-operationDone:
			s.release(identity.UserID)
		default:
			go func() { <-operationDone; s.release(identity.UserID) }()
		}
	}()
	var changed <-chan struct{}
	if s.wake != nil {
		wake, release := s.wake.Subscribe(project)
		changed = wake
		defer release()
	}
	controller := http.NewResponseController(w)
	if !supportsFlush(w) || controller.SetWriteDeadline(time.Time{}) != nil {
		return httpapi.Fail(501, "EVENT_STREAM_TRANSPORT_UNAVAILABLE", "当前服务连接不支持有界事件流。")
	}
	defer controller.SetWriteDeadline(time.Time{})
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	started := false
	sentBytes, sentEvents := 0, 0
	lastHeartbeat := time.Now()
	write := func(frame []byte) error {
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			return context.DeadlineExceeded
		}
		if err := controller.SetWriteDeadline(earlier(deadline, time.Now().Add(s.operation))); err != nil {
			return err
		}
		if _, err := w.Write(frame); err != nil {
			return err
		}
		return controller.Flush()
	}
	controlError := func(failure error) {
		var api *httpapi.Error
		if !errors.As(failure, &api) {
			api = httpapi.Retry(503, "PROJECT_EVENTS_UNAVAILABLE", "画布事件暂时无法读取。")
		}
		body := struct {
			Status    int              `json:"status"`
			Code      string           `json:"code"`
			Message   string           `json:"message"`
			RequestID string           `json:"requestId"`
			Retryable bool             `json:"retryable"`
			Details   []httpapi.Detail `json:"details"`
		}{api.Status, api.Code, api.Message, httpapi.RequestID(r), api.Retryable, api.Details}
		if body.Details == nil {
			body.Details = []httpapi.Detail{}
		}
		raw, _ := json.Marshal(body)
		_ = write(append(append([]byte("event: stream.error\ndata: "), raw...), []byte("\n\n")...))
	}
	for {
		page, readErr, done := streamOperation(ctx, earlier(deadline, time.Now().Add(s.operation)), func(readCtx context.Context) (domain.EventPage, error) {
			return s.service.Events(readCtx, identity.UserID, project, after, limit)
		})
		operationDone = done
		if readErr != nil {
			if ctx.Err() != nil || !time.Now().Before(deadline) {
				return nil
			}
			if errors.Is(readErr, context.DeadlineExceeded) || errors.Is(readErr, context.Canceled) {
				readErr = domain.ErrLiveUnavailable
			}
			if !started {
				return liveHTTPError(readErr)
			}
			controlError(liveHTTPError(readErr))
			return nil
		}
		frames, last, frameErr := streamPage(page, project, after, limit)
		if frameErr != nil {
			if !started {
				return liveHTTPError(frameErr)
			}
			controlError(liveHTTPError(frameErr))
			return nil
		}
		if len(r.Header.Values("X-STUDIO-Canvas-Update")) == 1 && r.Header.Get("X-STUDIO-Canvas-Update") == "delta-v1" {
			_, readErr, done := streamOperation(ctx, earlier(deadline, time.Now().Add(s.operation)), func(readCtx context.Context) (struct{}, error) {
				return struct{}{}, s.promoteDelta(readCtx, identity.UserID, project, page, frames)
			})
			operationDone = done
			if readErr != nil {
				if !started {
					return liveHTTPError(readErr)
				}
				controlError(liveHTTPError(readErr))
				return nil
			}
		}
		// A single complete uncached authentication/scope check gates each page,
		// including empty pages. No private data is emitted after a failed check.
		fresh, authErr, done := streamOperation(ctx, earlier(deadline, time.Now().Add(s.operation)), proof.Revalidate)
		operationDone = done
		if errors.Is(authErr, context.DeadlineExceeded) || errors.Is(authErr, context.Canceled) {
			authErr = httpapi.Retry(503, "IPAC_AUTHORIZATION_UNAVAILABLE", "统一授权服务暂时不可用。")
		}
		if authErr == nil && !sameStreamIdentity(identity, fresh) {
			authErr = httpapi.Fail(401, "STREAM_IDENTITY_CHANGED", "实时流登录身份已变更，请重新连接。")
		}
		if authErr == nil {
			var freshDeadline time.Time
			freshDeadline, authErr = verifiedDeadline(fresh)
			if authErr == nil {
				deadline = earlier(deadline, freshDeadline)
			}
		}
		if authErr != nil {
			if ctx.Err() != nil || !time.Now().Before(deadline) {
				return nil
			}
			if !started {
				return authErr
			}
			controlError(authErr)
			return nil
		}
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			return nil
		}
		if !started {
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(http.StatusOK)
			started = true
			if write([]byte(": connected\n\n")) != nil {
				return nil
			}
		}
		for _, value := range frames {
			frame := value.sse()
			if sentEvents >= maxStreamEvents || sentBytes+len(frame) > maxStreamBytes {
				return nil
			}
			if write(frame) != nil {
				return nil
			}
			sentEvents++
			sentBytes += len(frame)
		}
		after = last
		if !time.Now().Before(deadline) {
			return nil
		}
		if page.HasMore {
			continue
		}
		if time.Since(lastHeartbeat) >= s.heartbeat {
			if write([]byte(": heartbeat\n\n")) != nil {
				return nil
			}
			lastHeartbeat = time.Now()
		}
		wait := time.NewTimer(min(s.poll, time.Until(deadline)))
		select {
		case <-ctx.Done():
			wait.Stop()
			return nil
		case <-changed:
			wait.Stop()
		case <-wait.C:
		}
	}
}

// Validate the complete bounded page before committing HTTP stream headers.
// Decimal cursors remain strings on the wire, including values beyond JS 2^53.
func streamPage(page domain.EventPage, project string, after int64, limit int) ([]roomEvent, int64, error) {
	head, err := domain.ParseEventCursor(page.EventCursor)
	if err != nil || head < after || page.ProjectID != project || len(page.Events) > limit || len(page.Events) > domain.MaxEventPageSize {
		return nil, after, domain.ErrLiveUnavailable
	}
	last := after
	frames := make([]roomEvent, 0, len(page.Events))
	bytes := 0
	for _, raw := range page.Events {
		if last == int64(^uint64(0)>>1) {
			return nil, after, domain.ErrLiveUnavailable
		}
		last++
		raw, err = domain.ReplayProjectEvent(raw, project, last)
		if err != nil {
			return nil, after, err
		}
		bytes += len(raw)
		if bytes > domain.MaxEventPageBytes {
			return nil, after, domain.ErrLiveUnavailable
		}
		var value struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &value) != nil {
			return nil, after, domain.ErrLiveUnavailable
		}
		frames = append(frames, roomEvent{Type: "event", ID: strconv.FormatInt(last, 10), Event: value.Type, Data: raw})
	}
	if page.NextCursor != strconv.FormatInt(last, 10) || last > head || page.HasMore != (last < head) || len(frames) == 0 && last < head {
		return nil, after, domain.ErrLiveUnavailable
	}
	return frames, last, nil
}

type roomEvent struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

func (f roomEvent) sse() []byte {
	return []byte(fmt.Sprintf("id: %s\nevent: %s\ndata: %s\n\n", f.ID, f.Event, f.Data))
}

// Only an indexed transition that still covers the exact authorized event can
// replace its invalidation. A different API process can always send the event.
func (s *projectStream) promoteDelta(ctx context.Context, actor, project string, page domain.EventPage, frames []roomEvent) error {
	if len(frames) != 1 || page.HasMore || frames[0].Event != "canvas.invalidated" {
		return nil
	}
	var ev struct {
		Data struct{ BaseRevision, GraphRevision int64 }
	}
	if json.Unmarshal(page.Events[0], &ev) != nil || !s.service.HasDelta(project, ev.Data.BaseRevision, ev.Data.GraphRevision) {
		return nil
	}
	value, err := s.service.Update(ctx, actor, project, ev.Data.BaseRevision)
	if err != nil {
		return err
	}
	if value.Kind == "DELTA" && value.EventCursor == page.EventCursor && value.GraphRevision == ev.Data.GraphRevision {
		raw, err := json.Marshal(value)
		if err == nil && len(raw) <= domain.MaxEventBytes {
			frames[0].Event = "canvas.delta"
			frames[0].Data = raw
		}
	}
	return nil
}
