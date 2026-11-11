package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/canvaswake"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

func TestRoomAdmissionExpiryAndCompressedInputLimit(t *testing.T) {
	stream := testStream(func(ctx context.Context, owner, project string, after int64, limit int) (domain.EventPage, error) {
		if project != "allowed" {
			return domain.EventPage{}, domain.ErrNotFound
		}
		return emptyStreamPage(project, after), nil
	})
	stream.maxUser = 1
	stream.wake = canvaswake.New()
	var writeCalls atomic.Int64
	var verifyCalls atomic.Int64

	room := canvasRoom{stream: stream, origins: []string{"https://studio.test"}, joining: make(chan struct{}, 3), verify: func(_ context.Context, token string) (httpapi.Identity, error) {
		verifyCalls.Add(1)
		id := streamIdentity()
		if token == "short" {
			id.AccessExpiresAt = time.Now().Add(150 * time.Millisecond)
		}
		return id, nil
	}, write: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { writeCalls.Add(1) })}
	mux := chi.NewRouter()
	mux.Get("/r/{projectId}", httpapi.Wrap(room.serve))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	dial := func(project string, compress bool) *websocket.Conn {
		opts := websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://studio.test"}}, Subprotocols: []string{roomProtocol}}
		if compress {
			opts.CompressionMode = websocket.CompressionNoContextTakeover
			opts.CompressionThreshold = 1
		}
		c, resp, err := websocket.Dial(ctx, strings.Replace(srv.URL, "http", "ws", 1)+"/r/"+project, &opts)
		if err != nil {
			t.Fatal(err)
		}
		if compress {
			extension := resp.Header.Get("Sec-WebSocket-Extensions")
			if !strings.Contains(extension, "server_no_context_takeover") || !strings.Contains(extension, "client_no_context_takeover") {
				t.Fatal("compression must not reuse a credential dictionary", extension)
			}
		}
		t.Cleanup(func() { c.CloseNow() })
		return c
	}
	join := func(c *websocket.Conn, token string) {
		if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"join","token":"`+token+`","after":"0"}`)); err != nil {
			t.Fatal(err)
		}
	}
	read := func(c *websocket.Conn) roomResponse {
		_, data, e := c.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		var f roomResponse
		if json.Unmarshal(data, &f) != nil {
			t.Fatal("bad response")
		}
		return f
	}
	bomb := dial("allowed", true)
	join(bomb, strings.Repeat("x", 18*1024))
	_, _, err := bomb.Read(ctx)
	if err == nil || verifyCalls.Load() != 0 {
		t.Fatal("inflated unauthenticated payload reached verifier")
	}
	foreign := dial("private", false)
	join(foreign, "normal")
	if f := read(foreign); f.Status != 404 || f.Type != "error" {
		t.Fatal("room disclosed a foreign project")
	}
	first := dial("allowed", true)
	join(first, "normal")
	if f := read(first); f.Type != "ready" {
		t.Fatal(f)
	}
	blocked := dial("allowed", false)
	join(blocked, "normal")
	if f := read(blocked); f.Status != 429 {
		t.Fatal("account limit", f)
	}
	oversize := []byte(`{"type":"write","requestId":"large","body":{"value":"` + strings.Repeat("a", roomFrameLimit) + `"}}`)
	_ = first.Write(ctx, websocket.MessageText, oversize)
	if _, _, e := first.Read(ctx); e == nil || writeCalls.Load() != 0 {
		t.Fatal("compressed oversized body reached writer")
	}
	// The failed socket releases its account slot. A fresh short-lived bearer
	// expires even when the socket is completely idle.
	first.CloseNow()
	for {
		stream.mu.Lock()
		active := stream.active
		stream.mu.Unlock()
		if active == 0 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("disconnected account slot was not released")
		case <-time.After(time.Millisecond):
		}
	}
	short := dial("allowed", true)
	join(short, "short")
	if f := read(short); f.Type != "ready" {
		t.Fatal(f)
	}
	if _, _, e := short.Read(ctx); e == nil || ctx.Err() != nil {
		t.Fatal("idle socket outlived its access token")
	}
}

func TestSlowRoomReceiverHasBoundedWrite(t *testing.T) {
	done := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := websocket.Accept(w, r, nil)
		if e != nil {
			done <- e
			return
		}
		defer c.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 150*time.Millisecond)
		defer cancel()
		// The raw peer never drains its TCP receive buffer.
		message := strings.Repeat("x", 512*1024)
		for i := 0; i < 128; i++ {
			if e := writeMessage(ctx, c, message); e != nil {
				done <- e
				return
			}
		}
		done <- nil
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, e := websocket.Dial(ctx, strings.Replace(server.URL, "http", "ws", 1), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer c.CloseNow()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("undrained peer did not hit write bound")
		}
	case <-ctx.Done():
		t.Fatal("slow peer held the room writer")
	}
}
