package core

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/canvasdelta"
	"studiotv.local/service/api/internal/canvaswake"
	"studiotv.local/service/api/internal/httpapi"
	liveHTTP "studiotv.local/service/api/internal/modules/canvasagent/adapters/http"
	pg "studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	app "studiotv.local/service/api/internal/modules/canvasagent/application"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPostgresCanvasRoomCommitReplayAndRevokedSession(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	live, _ := app.NewLiveService(pg.New(f.db), f.prepared.CanvasDeltas)
	base, err := live.Snapshot(f.ctx, f.owner.UserID, nodeLeaseProject)
	if err != nil {
		t.Fatal(err)
	}
	hub := canvaswake.New()
	router := chi.NewRouter()
	var revoked atomic.Bool
	verify := func(ctx context.Context, bearer string) (httpapi.Identity, error) {
		if revoked.Load() {
			return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "revoked")
		}
		return f.prepared.AuthorizeProductBearer(ctx, bearer)
	}
	dummy := func(_ string, h httpapi.Handler) http.HandlerFunc { return httpapi.Wrap(h) }
	if err := liveHTTP.RegisterLiveRoom(router, router, live, dummy, hub, []string{"https://studio.test"}, verify, f.prepared.CanvasWrite); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	go hub.Run(ctx, f.db.Config().ConnConfig.Copy())
	srv := httptest.NewServer(router)
	defer srv.Close()
	endpoint := strings.Replace(srv.URL, "http://", "ws://", 1) + "/api/v2/projects/" + nodeLeaseProject + "/canvas-room"
	dial := func(origin string) (*websocket.Conn, *http.Response, error) {
		return websocket.Dial(ctx, endpoint, &websocket.DialOptions{Subprotocols: []string{"studiotv.canvas.v1"}, HTTPHeader: http.Header{"Origin": []string{origin}}})
	}
	if _, resp, err := dial("https://other.test"); err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatal("foreign origin admitted")
	}
	send := func(c *websocket.Conn, body any) {
		t.Helper()
		b, e := json.Marshal(body)
		if e != nil {
			t.Fatal(e)
		}
		if e = c.Write(ctx, websocket.MessageText, b); e != nil {
			t.Fatal(e)
		}
	}
	read := func(c *websocket.Conn, kind string) map[string]any {
		t.Helper()
		for {
			_, b, e := c.Read(ctx)
			if e != nil {
				t.Fatal(e)
			}
			if bytes.Contains(b, []byte(a.proof)) || bytes.Contains(b, []byte(a.lease)) {
				t.Fatal("private writer credential escaped")
			}
			var frame map[string]any
			if json.Unmarshal(b, &frame) != nil {
				t.Fatal("unreadable frame")
			}
			if frame["type"] == kind {
				return frame
			}
			if frame["type"] == "error" || frame["type"] == "receipt" || frame["type"] == "ready" {
				t.Fatalf("unexpected frame %#v", frame)
			}
		}
	}
	join := func(token, cursor string) *websocket.Conn {
		c, _, e := dial("https://studio.test")
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { c.CloseNow() })
		send(c, map[string]any{"type": "join", "token": token, "after": cursor})
		return c
	}
	bad := join("unverified-bearer", base.EventCursor)
	if read(bad, "error")["status"] != float64(401) {
		t.Fatal("invalid bearer admitted")
	}
	peer := join(a.token, base.EventCursor)
	read(peer, "ready")
	writer := join(a.token, base.EventCursor)
	read(writer, "ready")
	batch := map[string]any{"schemaVersion": "1", "batchId": uuid.NewString(), "clientId": a.page, "observedRevision": base.GraphRevision, "operations": []canvasOperation{{Type: "node.patch", NodeID: "n1", Set: []canvasOperationValue{{Path: []string{"position", "x"}, Value: 167}}}}}
	write := map[string]any{"type": "write", "requestId": "edit_one", "proof": a.proof, "lease": a.lease, "baseRevision": base.GraphRevision, "body": batch}
	send(writer, write)
	receipt := read(writer, "receipt")
	if receipt["status"] != float64(200) || receipt["requestId"] != "edit_one" {
		t.Fatalf("write failed %#v", receipt)
	}
	d := receipt["body"].(map[string]any)["data"].(map[string]any)
	if d["batchId"] != batch["batchId"] || d["revision"] != float64(base.GraphRevision+1) || d["kind"] != "DELTA" {
		t.Fatalf("wrong receipt %v", d)
	}
	frame := read(peer, "event")
	if frame["event"] != "canvas.delta" || frame["id"] != d["eventCursor"] {
		t.Fatalf("mismatched committed event %#v", frame)
	}
	// A lost socket reply can always be queried/replayed through HTTP.
	f.call(t, a, "POST", "canvas-operations", batch, 200)
	if got := f.state(t).Revision; int64(got) != base.GraphRevision+1 {
		t.Fatal("duplicate revision", got)
	}
	writer.CloseNow()
	old := join(a.token, base.EventCursor)
	read(old, "ready")
	if read(old, "event")["id"] != frame["id"] {
		t.Fatal("reconnect did not replay")
	}
	write["proof"] = strings.Repeat("x", 36)
	batch["batchId"] = uuid.NewString()
	send(old, write)
	if read(old, "receipt")["status"] != float64(409) {
		t.Fatal("stale page wrote")
	}
	// A second API replica has an independent room listener and a cold delta
	// cache. Its authorized invalidation carries the same committed cursor.
	replicaHub := canvaswake.New()
	go replicaHub.Run(ctx, f.db.Config().ConnConfig.Copy())
	probe := uuid.NewString()
	wakeProbe, releaseProbe := replicaHub.Subscribe(probe)
	defer releaseProbe()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
listening:
	for {
		select {
		case <-ctx.Done():
			t.Fatal("replica listener did not start")
		case <-wakeProbe:
			break listening
		case <-ticker.C:
			if _, e := f.db.Exec(ctx, "SELECT pg_notify('studiotv_canvas_commit',$1)", probe); e != nil {
				t.Fatal(e)
			}
		}
	}
	cold, _ := app.NewLiveService(pg.New(f.db), canvasdelta.New())
	replicaRouter := chi.NewRouter()
	if e := liveHTTP.RegisterLiveRoom(replicaRouter, replicaRouter, cold, dummy, replicaHub, []string{"https://studio.test"}, verify, f.prepared.CanvasWrite); e != nil {
		t.Fatal(e)
	}
	replica := httptest.NewServer(replicaRouter)
	defer replica.Close()
	endpoint = strings.Replace(replica.URL, "http://", "ws://", 1) + "/api/v2/projects/" + nodeLeaseProject + "/canvas-room"
	other := join(a.token, d["eventCursor"].(string))
	read(other, "ready")
	batch["batchId"] = uuid.NewString()
	batch["operations"] = []canvasOperation{{Type: "node.patch", NodeID: "n1", Set: []canvasOperationValue{{Path: []string{"position", "x"}, Value: 278}}}}
	f.call(t, a, "POST", "canvas-operations", batch, 200)
	update := read(other, "event")
	canonical, e := cold.Snapshot(ctx, f.owner.UserID, nodeLeaseProject)
	if e != nil || update["event"] != "canvas.invalidated" || update["id"] != canonical.EventCursor || canonical.GraphRevision != base.GraphRevision+2 {
		t.Fatal("replica missed canonical HTTP edit", update, e)
	}
	// Replaying through WS and HTTP must log independent server-generated
	// correlation IDs even though all frames share the same physical socket.
	batch["batchId"] = uuid.NewString()
	send(old, write)
	rejected := read(old, "receipt")
	rejectedID := rejected["body"].(map[string]any)["requestId"]
	if _, err := uuid.Parse(rejectedID.(string)); err != nil || rejectedID == receipt["body"].(map[string]any)["requestId"] {
		t.Fatal("shared message log ID")
	}
	revoked.Store(true)
	send(old, write)
	if read(old, "error")["status"] != float64(401) {
		t.Fatal("revoked token remained writable")
	}
	if got := f.state(t).Revision; int64(got) != base.GraphRevision+2 {
		t.Fatal("rejected message wrote", got)
	}
}

// Pinned credentials are a frame compression shortcut. Dropped acknowledgments,
// a new page term, and mixed HTTP writers still go through the canonical fence.
func TestPostgresRoomMoveAcrossHTTPAndBindingRollover(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	otherPage := accountReady(t, f, handoffBrowser{token: f.a.token, page: uuid.NewString(), proof: uuid.NewString()})
	h := canvaswake.New()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	go h.Run(ctx, f.db.Config().ConnConfig.Copy())
	live, _ := app.NewLiveService(pg.New(f.db), f.prepared.CanvasDeltas)
	base, e := live.Snapshot(ctx, f.owner.UserID, nodeLeaseProject)
	if e != nil {
		t.Fatal(e)
	}
	mux := chi.NewRouter()
	pass := func(_ string, x httpapi.Handler) http.HandlerFunc { return httpapi.Wrap(x) }
	if e := liveHTTP.RegisterLiveRoom(mux, mux, live, pass, h, []string{"https://studio.test"}, f.prepared.AuthorizeProductBearer, f.prepared.CanvasWrite); e != nil {
		t.Fatal(e)
	}
	ts := httptest.NewServer(mux)
	defer ts.Close()
	url := strings.Replace(ts.URL, "http://", "ws://", 1) + "/api/v2/projects/" + nodeLeaseProject + "/canvas-room"
	open := func() *websocket.Conn {
		c, _, e := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"studiotv.canvas.v1"}, HTTPHeader: http.Header{"Origin": {"https://studio.test"}}})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { c.CloseNow() })
		join, _ := json.Marshal(map[string]any{"type": "join", "token": a.token, "after": base.EventCursor, "formats": []string{"move-v1"}})
		if e = c.Write(ctx, websocket.MessageText, join); e != nil {
			t.Fatal(e)
		}
		_, hello, e := c.Read(ctx)
		if e != nil || !bytes.Contains(hello, []byte("move-v1")) {
			t.Fatal("move not negotiated", string(hello), e)
		}
		return c
	}
	writer := open()
	peer := open()
	propose := func(request string, batch string, client, proof, lease any, revision int64, x, y float64) {
		v, _ := json.Marshal([]any{request, batch, client, proof, lease, revision, revision, revision, false, [][]any{{"n1", x, y}}})
		if e := writer.Write(ctx, websocket.MessageBinary, append([]byte{'M'}, v...)); e != nil {
			t.Fatal(e)
		}
	}
	response := func(request string) map[string]any {
		for {
			kind, raw, e := writer.Read(ctx)
			if e != nil {
				t.Fatal(e)
			}
			if kind == websocket.MessageBinary {
				continue
			}
			var v map[string]any
			if json.Unmarshal(raw, &v) != nil {
				t.Fatal("unreadable receipt")
			}
			if v["type"] == "error" {
				t.Fatal(v)
			}
			if v["type"] == "receipt" && v["requestId"] == request {
				return v
			}
		}
	}
	httpBatch := func(b string, revision int64, x, y float64) map[string]any {
		return map[string]any{"schemaVersion": "1", "batchId": b, "clientId": a.page, "observedRevision": revision, "baseRevision": revision, "operations": []canvasOperation{{Type: "node.patch", NodeID: "n1", Set: []canvasOperationValue{{Path: []string{"position", "x"}, Value: x}, {Path: []string{"position", "y"}, Value: y}}, Unset: [][]string{}}}}
	}
	rev := base.GraphRevision
	id := uuid.NewString()
	propose("one", id, a.page, a.proof, a.lease, rev, 0.000001, -123.45678901234568)
	r := response("one")
	if r["bound"] != true || r["status"] != float64(200) {
		t.Fatal("first binding was not confirmed", r)
	}
	// First commit through M, exact replay via the legacy HTTP transport.
	f.call(t, a, "POST", "canvas-operations", httpBatch(id, rev, 0.000001, -123.45678901234568), 200)
	for {
		kind, b, e := peer.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if kind == websocket.MessageText {
			var v map[string]any
			_ = json.Unmarshal(b, &v)
			if v["type"] == "heartbeat" {
				continue
			}
		}
		if kind != websocket.MessageBinary || len(b) < 2 || b[0] != 'E' {
			t.Fatalf("unexpected move event %.100s", b)
		}
		var parts []json.RawMessage
		if json.Unmarshal(b[1:], &parts) != nil || len(parts) != 7 || !bytes.Contains(parts[6], []byte(`["n1",0.000001,-123.45678901234568]`)) {
			t.Fatal("location not preserved", string(b))
		}
		break
	}
	rev++
	id = uuid.NewString()
	// HTTP -> short M uses the same receipt even with an obsolete CAS observation.
	f.call(t, a, "POST", "canvas-operations", httpBatch(id, rev, 3.25, -4.5), 200)
	propose("two", id, nil, nil, nil, rev, 3.25, -4.5)
	if v := response("two"); v["bound"] != true || v["status"] != float64(200) {
		t.Fatal("HTTP receipt missing through short frame", v)
	}
	rev++
	propose("other", uuid.NewString(), otherPage.page, otherPage.proof, otherPage.lease, rev, 12.5, 9)
	// Another admitted page under the same login may use its full grant,
	// but even a successful write cannot replace the socket's first binding.
	if v := response("other"); v["status"] != float64(200) || v["bound"] != nil {
		t.Fatal("a new full grant incorrectly replaced the binding", v)
	}
	rev++
	propose("three", uuid.NewString(), nil, nil, nil, rev, 17, 22)
	if v := response("three"); v["bound"] != true || v["status"] != float64(200) {
		t.Fatal("pinned grant was replaced", v)
	}
	rev++
	expireSnapshotPage(t, f, a)
	propose("stale", uuid.NewString(), nil, nil, nil, rev, 21, 25)
	if v := response("stale"); v["status"] != float64(409) || v["bound"] != nil {
		t.Fatal("expired binding granted access", v)
	}
	if got := int64(f.state(t).Revision); got != rev {
		t.Fatal("read/duplicate/rejected frames changed revision", got, rev)
	}
}
