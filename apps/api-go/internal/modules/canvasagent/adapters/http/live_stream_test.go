package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type streamRepository struct {
	read func(context.Context, string, string, int64, int) (domain.EventPage, error)
}

func (s streamRepository) OwnedLiveSnapshot(context.Context, string, string) (domain.LiveSnapshot, error) {
	return domain.LiveSnapshot{}, domain.ErrNotFound
}
func (s streamRepository) OwnedProjectEvents(ctx context.Context, owner, project string, after int64, limit int) (domain.EventPage, error) {
	return s.read(ctx, owner, project, after, limit)
}

type streamWriter struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
	writeErr  error
}

func (w *streamWriter) SetWriteDeadline(value time.Time) error {
	w.deadlines = append(w.deadlines, value)
	return nil
}
func (w *streamWriter) Write(raw []byte) (int, error) {
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	return w.ResponseRecorder.Write(raw)
}
func streamIdentity() httpapi.Identity {
	return httpapi.Identity{UserID: "user-a", SessionID: "session-a", IPACIssuer: "issuer", IPACSubjectID: "subject-a", IPACSessionID: "ipac-a", IPACSessionVersion: 1, AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
}
func emptyStreamPage(project string, after int64) domain.EventPage {
	cursor := strconv.FormatInt(after, 10)
	return domain.EventPage{ProjectID: project, Events: []json.RawMessage{}, NextCursor: cursor, EventCursor: cursor}
}
func eventRaw(project string, sequence int64) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"schemaVersion":"1","projectId":%q,"sequence":%q,"occurredAt":"2026-10-06T12:00:00Z","source":{"kind":"API"},"type":"canvas.invalidated","data":{"baseRevision":1,"graphRevision":2,"reason":"REVISION_ONLY"}}`, project, strconv.FormatInt(sequence, 10)))
}
func testStream(read func(context.Context, string, string, int64, int) (domain.EventPage, error)) *projectStream {
	service, _ := application.NewLiveService(streamRepository{read})
	stream := newProjectStream(service)
	stream.lifetime = 40 * time.Millisecond
	stream.poll = 2 * time.Millisecond
	stream.heartbeat = 6 * time.Millisecond
	stream.operation = 100 * time.Millisecond
	return stream
}
func streamRequest(identity httpapi.Identity, check func(context.Context) (httpapi.Identity, error)) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/events", nil)
	r = httpapi.WithIdentity(r, identity)
	return httpapi.WithLiveAuthorization(r, httpapi.LiveAuthorization{Revalidate: check})
}
func waitStreamIdle(t *testing.T, s *projectStream) {
	t.Helper()
	until := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		active, users := s.active, len(s.users)
		s.mu.Unlock()
		if active == 0 && users == 0 {
			return
		}
		if time.Now().After(until) {
			t.Fatal("stream lease did not finish", active, users)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSSEReplaysDecimalStringCursorThenClosesBoundedAndReleasesCapacity(t *testing.T) {
	const after = int64(9007199254740992)
	calls, checks := 0, 0
	identity := streamIdentity()
	stream := testStream(func(_ context.Context, owner, project string, cursor int64, limit int) (domain.EventPage, error) {
		calls++
		if owner != identity.UserID || project != "owned" || limit != 100 {
			t.Fatal("untrusted owner/page")
		}
		if calls == 1 {
			return domain.EventPage{ProjectID: project, Events: []json.RawMessage{eventRaw(project, after+1)}, NextCursor: "9007199254740993", EventCursor: "9007199254740993"}, nil
		}
		if cursor != after+1 {
			t.Fatal("cursor did not advance exactly")
		}
		return emptyStreamPage(project, cursor), nil
	})
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	req := streamRequest(identity, func(context.Context) (httpapi.Identity, error) { checks++; return identity, nil })
	if err := stream.serve(w, req, identity, "owned", after, 100); err != nil {
		t.Fatal(err)
	}
	waitStreamIdle(t, stream)
	if w.Code != 200 || w.Header().Get("Content-Type") != "text/event-stream; charset=utf-8" || w.Header().Get("X-Accel-Buffering") != "no" {
		t.Fatal(w.Code, w.Header())
	}
	body := w.Body.String()
	if !strings.Contains(body, "id: 9007199254740993\nevent: canvas.invalidated\ndata: ") || !strings.Contains(body, ": heartbeat\n\n") || strings.Count(body, "id: ") != 1 {
		t.Fatal(body)
	}
	if checks > calls || calls-checks > 1 || calls < 2 || stream.active != 0 || len(stream.users) != 0 {
		t.Fatal("page authentication/capacity cleanup", checks, calls, stream.active)
	}
	for _, deadline := range w.deadlines {
		if !deadline.IsZero() && deadline.After(identity.AccessExpiresAt) {
			t.Fatal("write outlived access proof")
		}
	}
}
func TestSSEAuthorizationFailureBeforeHeadersKeepsFormalHTTPError(t *testing.T) {
	identity := streamIdentity()
	stream := testStream(func(_ context.Context, _ string, p string, a int64, _ int) (domain.EventPage, error) {
		return domain.EventPage{ProjectID: p, Events: []json.RawMessage{eventRaw(p, a+1)}, NextCursor: "1", EventCursor: "1"}, nil
	})
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	req := streamRequest(identity, func(context.Context) (httpapi.Identity, error) {
		return httpapi.Identity{}, httpapi.Fail(403, "IPAC_PERMISSION_DENIED", "denied")
	})
	err := stream.serve(w, req, identity, "owned", 0, 100)
	httpapi.WriteError(w, req, err)
	if w.Code != 403 || strings.Contains(w.Body.String(), "id:") || w.Header().Get("Content-Type") != "application/json; charset=utf-8" || stream.active != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestSSERevocationAfterHeadersHasNoCursorAndEmitsNoSubsequentData(t *testing.T) {
	for _, status := range []int{401, 403, 503} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			identity := streamIdentity()
			calls, checks := 0, 0
			stream := testStream(func(_ context.Context, _ string, p string, a int64, _ int) (domain.EventPage, error) {
				calls++
				if calls == 1 {
					return emptyStreamPage(p, a), nil
				}
				return domain.EventPage{ProjectID: p, Events: []json.RawMessage{eventRaw(p, a+1)}, NextCursor: strconv.FormatInt(a+1, 10), EventCursor: strconv.FormatInt(a+1, 10)}, nil
			})
			w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
			req := streamRequest(identity, func(context.Context) (httpapi.Identity, error) {
				checks++
				if checks == 1 {
					return identity, nil
				}
				return httpapi.Identity{}, httpapi.Fail(status, "STOPPED", "stopped")
			})
			if err := stream.serve(w, req, identity, "owned", 0, 100); err != nil {
				t.Fatal(err)
			}
			body := w.Body.String()
			if !strings.Contains(body, "event: stream.error\ndata: ") || strings.Contains(body, "id:") || strings.Contains(body, "sequence") || strings.Contains(body, "canvas.invalidated") {
				t.Fatal(body)
			}
			if !strings.Contains(body, fmt.Sprintf(`"status":%d`, status)) || checks != 2 || calls != 2 || stream.active != 0 {
				t.Fatal(body, checks, calls)
			}
		})
	}
}
func TestSSEIdentityCannotChangeDuringRevalidation(t *testing.T) {
	identity := streamIdentity()
	stream := testStream(func(_ context.Context, _ string, p string, a int64, _ int) (domain.EventPage, error) {
		return emptyStreamPage(p, a), nil
	})
	fresh := identity
	fresh.SessionID = "other-session"
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) { return fresh, nil }), identity, "owned", 0, 100)
	api, ok := err.(*httpapi.Error)
	if !ok || api.Code != "STREAM_IDENTITY_CHANGED" || w.Body.Len() != 0 {
		t.Fatal(err, w.Body.String())
	}
}
func TestSSETailRechecksOwnerAndStopsOnProjectDeletion(t *testing.T) {
	identity := streamIdentity()
	calls := 0
	stream := testStream(func(_ context.Context, owner, p string, a int64, _ int) (domain.EventPage, error) {
		calls++
		if owner != identity.UserID {
			t.Fatal("owner changed")
		}
		if calls == 1 {
			return emptyStreamPage(p, a), nil
		}
		return domain.EventPage{}, domain.ErrNotFound
	})
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	if err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) { return identity, nil }), identity, "owned", 0, 100); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(w.Body.String(), `"status":404`) || strings.Contains(w.Body.String(), "id:") || calls != 2 || stream.active != 0 {
		t.Fatal(w.Body.String())
	}
}
func TestSSEExpiresAtFrozenAccessOrSessionDeadline(t *testing.T) {
	for _, kind := range []string{"access", "session"} {
		t.Run(kind, func(t *testing.T) {
			identity := streamIdentity()
			cutoff := time.Now().Add(12 * time.Millisecond)
			if kind == "access" {
				identity.AccessExpiresAt = cutoff
			} else {
				identity.SessionExpiresAt = cutoff
			}
			calls := 0
			stream := testStream(func(ctx context.Context, _ string, p string, a int64, _ int) (domain.EventPage, error) {
				calls++
				if deadline, ok := ctx.Deadline(); !ok || deadline.After(cutoff) {
					t.Fatal("read was not bounded by verified expiry")
				}
				return emptyStreamPage(p, a), nil
			})
			stream.lifetime = time.Second
			w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
			began := time.Now()
			err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) { return identity, nil }), identity, "owned", 0, 100)
			elapsed := time.Since(began)
			waitStreamIdle(t, stream)
			if err != nil || elapsed > 100*time.Millisecond || calls < 1 || stream.active != 0 {
				t.Fatal(err, time.Since(began), calls)
			}
		})
	}
}
func TestSSEDisconnectCancelsPendingReadAndCapacity(t *testing.T) {
	identity := streamIdentity()
	ctx, cancel := context.WithCancel(context.Background())
	stream := testStream(func(ctx context.Context, _ string, _ string, _ int64, _ int) (domain.EventPage, error) {
		cancel()
		<-ctx.Done()
		return domain.EventPage{}, domain.ErrLiveUnavailable
	})
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	req := streamRequest(identity, func(context.Context) (httpapi.Identity, error) {
		t.Fatal("cancelled read reauthenticated")
		return identity, nil
	})
	req = httpapi.WithLiveAuthorization(httptest.NewRequest("GET", "/events", nil).WithContext(ctx), httpapi.LiveAuthorization{Revalidate: httpapi.LiveAuthorizationFrom(req).Revalidate})
	if err := stream.serve(w, req, identity, "owned", 0, 100); err != nil || w.Body.Len() != 0 {
		t.Fatal(err, w.Body.String())
	}
	waitStreamIdle(t, stream)
}
func TestSSEWriteFailureStopsWithoutAnotherRead(t *testing.T) {
	identity := streamIdentity()
	calls := 0
	stream := testStream(func(_ context.Context, _ string, p string, a int64, _ int) (domain.EventPage, error) {
		calls++
		return emptyStreamPage(p, a), nil
	})
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder(), writeErr: errors.New("closed transport")}
	if err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) { return identity, nil }), identity, "owned", 0, 100); err != nil || calls != 1 || stream.active != 0 {
		t.Fatal(err, calls)
	}
}
func TestSSEConnectionLimitsRejectAndCleanUpAfterErrors(t *testing.T) {
	identity := streamIdentity()
	stream := testStream(func(context.Context, string, string, int64, int) (domain.EventPage, error) {
		return domain.EventPage{}, domain.ErrNotFound
	})
	stream.maxActive = 1
	stream.maxUser = 1
	if !stream.acquire(identity.UserID) {
		t.Fatal("cannot acquire")
	}
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	req := streamRequest(identity, func(context.Context) (httpapi.Identity, error) { return identity, nil })
	err := stream.serve(w, req, identity, "owned", 0, 100)
	api, ok := err.(*httpapi.Error)
	if !ok || api.Status != 429 || !api.Retryable {
		t.Fatal(err)
	}
	stream.release(identity.UserID)
	err = stream.serve(w, req, identity, "owned", 0, 100)
	api, ok = err.(*httpapi.Error)
	if !ok || api.Status != 404 || stream.active != 0 || len(stream.users) != 0 {
		t.Fatal(err, stream.active)
	}
}
func TestSSERequiresTrustedExpiryRevalidationAndWriteDeadlineSupport(t *testing.T) {
	identity := streamIdentity()
	stream := testStream(func(context.Context, string, string, int64, int) (domain.EventPage, error) {
		t.Fatal("unsafe stream reached private reader")
		return domain.EventPage{}, nil
	})
	for _, kind := range []string{"missing-proof", "missing-expiry", "unsupported-transport"} {
		t.Run(kind, func(t *testing.T) {
			who := identity
			req := streamRequest(who, func(context.Context) (httpapi.Identity, error) { return who, nil })
			if kind == "missing-proof" {
				req = httptest.NewRequest("GET", "/events", nil)
			}
			if kind == "missing-expiry" {
				who.AccessExpiresAt = time.Time{}
			}
			err := stream.serve(httptest.NewRecorder(), req, who, "owned", 0, 100)
			api, ok := err.(*httpapi.Error)
			if !ok || api.Status != 501 || stream.active != 0 {
				t.Fatal(err)
			}
		})
	}
}
func TestSSEMalformedReplayNeverCommitsHeadersOrLeaksData(t *testing.T) {
	identity := streamIdentity()
	stream := testStream(func(_ context.Context, _ string, p string, a int64, _ int) (domain.EventPage, error) {
		return domain.EventPage{ProjectID: p, Events: []json.RawMessage{eventRaw(p, 2)}, NextCursor: "2", EventCursor: "2"}, nil
	})
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) { return identity, nil }), identity, "owned", 0, 100)
	api, ok := err.(*httpapi.Error)
	if !ok || api.Status != 503 || w.Body.Len() != 0 || stream.active != 0 {
		t.Fatal(err, w.Body.String())
	}
}
func TestStreamPageRejectsGapWrongOwnerHeadAndCursorAuthority(t *testing.T) {
	valid := domain.EventPage{ProjectID: "owned", Events: []json.RawMessage{eventRaw("owned", 1)}, NextCursor: "1", EventCursor: "2", HasMore: true}
	for _, change := range []func(*domain.EventPage){func(p *domain.EventPage) { p.ProjectID = "other" }, func(p *domain.EventPage) { p.NextCursor = "2" }, func(p *domain.EventPage) { p.EventCursor = "0" }, func(p *domain.EventPage) { p.HasMore = false }, func(p *domain.EventPage) { p.Events = []json.RawMessage{} }, func(p *domain.EventPage) { p.Events = []json.RawMessage{eventRaw("owned", 2)} }} {
		p := valid
		change(&p)
		if _, _, err := streamPage(p, "owned", 0, 100); err == nil {
			t.Fatal("invalid replay accepted", p)
		}
	}
	if frames, last, err := streamPage(valid, "owned", 0, 100); err != nil || last != 1 || len(frames) != 1 {
		t.Fatal(err, last)
	}
}
func TestSSEDeadlineReturnsWithoutWaitingForCanceledDatabaseCleanup(t *testing.T) {
	identity := streamIdentity()
	identity.AccessExpiresAt = time.Now().Add(15 * time.Millisecond)
	finish := make(chan struct{})
	stream := testStream(func(context.Context, string, string, int64, int) (domain.EventPage, error) {
		<-finish
		return domain.EventPage{}, domain.ErrLiveUnavailable
	})
	stream.lifetime = time.Second
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	began := time.Now()
	err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) {
		t.Fatal("expired reader was authenticated")
		return identity, nil
	}), identity, "owned", 0, 100)
	if err != nil || time.Since(began) > 100*time.Millisecond || w.Body.Len() != 0 {
		t.Fatal(err, time.Since(began), w.Body.String())
	}
	stream.mu.Lock()
	active := stream.active
	stream.mu.Unlock()
	if active != 1 {
		t.Fatal("unfinished operation released its admission lease")
	}
	close(finish)
	waitStreamIdle(t, stream)
}
func TestSSEDeadlineReturnsWithoutWaitingForCanceledAuthorization(t *testing.T) {
	identity := streamIdentity()
	identity.SessionExpiresAt = time.Now().Add(15 * time.Millisecond)
	finish := make(chan struct{})
	stream := testStream(func(_ context.Context, _ string, p string, a int64, _ int) (domain.EventPage, error) {
		return emptyStreamPage(p, a), nil
	})
	stream.lifetime = time.Second
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	began := time.Now()
	err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) { <-finish; return identity, nil }), identity, "owned", 0, 100)
	if err != nil || time.Since(began) > 100*time.Millisecond || w.Body.Len() != 0 {
		t.Fatal(err, time.Since(began), w.Body.String())
	}
	close(finish)
	waitStreamIdle(t, stream)
}
func TestSSEEventBudgetEndsAtLastActuallySentCursor(t *testing.T) {
	identity := streamIdentity()
	stream := testStream(func(_ context.Context, _ string, p string, a int64, limit int) (domain.EventPage, error) {
		events := make([]json.RawMessage, 0, limit)
		for i := 1; i <= limit; i++ {
			events = append(events, eventRaw(p, a+int64(i)))
		}
		return domain.EventPage{ProjectID: p, Events: events, NextCursor: strconv.FormatInt(a+int64(limit), 10), EventCursor: "10000", HasMore: true}, nil
	})
	stream.lifetime = time.Second
	w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
	if err := stream.serve(w, streamRequest(identity, func(context.Context) (httpapi.Identity, error) { return identity, nil }), identity, "owned", 0, 100); err != nil {
		t.Fatal(err)
	}
	if strings.Count(w.Body.String(), "id: ") != maxStreamEvents || !strings.Contains(w.Body.String(), "id: 1024\n") || strings.Contains(w.Body.String(), "id: 1025\n") {
		t.Fatal("replay advanced past delivered events")
	}
	waitStreamIdle(t, stream)
}
func TestSSEUserAndProcessAdmissionAreBothBounded(t *testing.T) {
	stream := newProjectStream(nil)
	stream.maxActive = 2
	stream.maxUser = 1
	if !stream.acquire("a") || stream.acquire("a") || !stream.acquire("b") || stream.acquire("c") {
		t.Fatal("admission limits bypassed")
	}
	stream.release("a")
	stream.release("b")
	waitStreamIdle(t, stream)
}
func TestSSEAcceptQualityDoesNotSelectExplicitlyRefusedStream(t *testing.T) {
	for _, value := range []string{"text/event-stream;q=0", "text/event-stream;q=0.0", "text/event-stream;q=0.000", "text/event-stream;q=2", "text/event-stream;q=invalid", "text/event-stream, application/json"} {
		if onlyEventStreamAccepted([]string{value}) {
			t.Fatal("refused or ambiguous stream selected", value)
		}
	}
	if !onlyEventStreamAccepted([]string{"text/event-stream;q=1"}) {
		t.Fatal("explicit stream refused")
	}
}
