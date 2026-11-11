package core

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/canvasdelta"
	"studiotv.local/service/api/internal/httpapi"
	liveHTTP "studiotv.local/service/api/internal/modules/canvasagent/adapters/http"
	pg "studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	app "studiotv.local/service/api/internal/modules/canvasagent/application"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPostgresLiveUpdateReadsCommittedCanonicalHeadAndRevalidatesProject(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	repo := pg.New(f.db)
	live, _ := app.NewLiveService(repo, f.prepared.CanvasDeltas)
	base, e := live.Snapshot(f.ctx, f.owner.UserID, nodeLeaseProject)
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	req := map[string]any{"schemaVersion": "1", "clientId": a.page, "batchId": id, "operations": []canvasOperation{{Type: "node.patch", NodeID: "n1", Set: []canvasOperationValue{{Path: []string{"position", "x"}, Value: 76}}}}}
	f.call(t, a, "POST", "canvas-operations", req, 200)
	v, e := live.Update(f.ctx, f.editor.UserID, nodeLeaseProject, base.GraphRevision)
	if e != nil {
		t.Fatal(e)
	}
	truth, e := live.Snapshot(f.ctx, f.editor.UserID, nodeLeaseProject)
	if e != nil {
		t.Fatal(e)
	}
	if v.Kind != "DELTA" || v.Graph != nil || v.GraphRevision != truth.GraphRevision || v.EventCursor != truth.EventCursor || !v.UpdatedAt.Equal(truth.UpdatedAt) || len(v.Delta.Positions) != 1 || v.Delta.Positions[0].X != 76 || len(v.NodeStates) != len(truth.NodeStates) || v.NodeExecutionAvailable != truth.NodeExecutionAvailable {
		t.Fatalf("invalid canonical delta %#v", v)
	}
	f.call(t, a, "POST", "canvas-operations", req, 200)
	// Direct task/legacy writes never enter the operation cache. Another process
	// or a forged fromRevision simply receives the full authorized snapshot.
	if _, e = f.db.Exec(f.ctx, `UPDATE projects SET graph=jsonb_set(graph,'{nodes,0,data,status}','"running"'),revision=revision+1 WHERE id=$1`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	next, e := live.Update(f.ctx, f.owner.UserID, nodeLeaseProject, base.GraphRevision)
	if e != nil || next.Kind != "SNAPSHOT" || next.Graph == nil || next.Delta != nil {
		t.Fatal("writeback bridged unproven revision", next, e)
	}
	cold, _ := app.NewLiveService(repo, canvasdelta.New())
	next, e = cold.Update(f.ctx, f.owner.UserID, nodeLeaseProject, base.GraphRevision)
	if e != nil || next.Kind != "SNAPSHOT" {
		t.Fatal("cold read", e)
	}
	if _, e = f.db.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id=$1 AND user_id=$2`, nodeLeaseProject, f.editor.UserID); e != nil {
		t.Fatal(e)
	}
	if _, e = live.Update(f.ctx, f.editor.UserID, nodeLeaseProject, base.GraphRevision); e == nil {
		t.Fatal("revoked reader reached cache")
	}
}

func TestPostgresLargeCanvasSmallCommittedReceiptAndObserverFrames(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	// Seed the synthetic baseline before the page subscribes. The first full
	// read is intentionally required, as it would be on a second computer.
	raw := graphFrom(t, nodeLeaseGraph)
	nodes := raw["nodes"].([]any)
	for i := 0; i < 240; i++ {
		n := operationNode(fmt.Sprintf("large_%d", i))
		n["type"] = "rh-text"
		n["data"] = map[string]any{"text": strings.Repeat("layout note ", 128)}
		nodes = append(nodes, n)
	}
	raw["nodes"] = nodes
	graph, _ := json.Marshal(raw)
	if _, e := f.db.Exec(f.ctx, `UPDATE projects SET graph=$2,revision=revision+1 WHERE id=$1`, nodeLeaseProject, graph); e != nil {
		t.Fatal(e)
	}
	live, _ := app.NewLiveService(pg.New(f.db), f.prepared.CanvasDeltas)
	base, e := live.Snapshot(f.ctx, f.owner.UserID, nodeLeaseProject)
	if e != nil {
		t.Fatal(e)
	}
	origin := strconv.FormatInt(base.GraphRevision, 10)
	req := map[string]any{"schemaVersion": "1", "batchId": uuid.NewString(), "clientId": a.page, "operations": []canvasOperation{{Type: "node.patch", NodeID: "large_155", Set: []canvasOperationValue{{Path: []string{"position", "x"}, Value: 165}}}}}
	headers := []string{"X-STUDIO-Canvas-Receipt", "delta-v1", "X-STUDIO-Canvas-Base", origin}
	small := f.call(t, a, "POST", "canvas-operations", req, 200, headers...)
	var sent struct {
		Data struct {
			Kind                       string
			EventCursor                string
			Revision, AcceptedRevision int64
			BatchID                    string
			Delta                      *canvasdelta.Delta
			Graph                      json.RawMessage
		}
	}
	json.Unmarshal([]byte(small.raw), &sent)
	if sent.Data.Kind != "DELTA" || sent.Data.Graph != nil || len(sent.Data.Delta.Positions) != 1 || sent.Data.Delta.Positions[0].X != 165 || sent.Data.AcceptedRevision != base.GraphRevision+1 || sent.Data.BatchID != req["batchId"] {
		t.Fatal("invalid small writer receipt")
	}
	again := f.call(t, a, "POST", "canvas-operations", req, 200, headers...)
	if !strings.Contains(again.raw, `"kind":"DELTA"`) {
		t.Fatal("retry lost original receipt")
	}
	req["receiptOnly"] = true
	full := f.call(t, a, "POST", "canvas-operations", req, 200, headers...)
	if strings.Contains(full.raw, `"kind":"DELTA"`) || !strings.Contains(full.raw, "layout note") {
		t.Fatal("receiptOnly must return full graph")
	}
	// Use the real live HTTP transports and PostgreSQL event replay. Only the
	// outer authenticator is the isolated test identity; project membership is real.
	router := chi.NewRouter()
	id := f.editor
	guard := func(_ string, next httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return next(w, httpapi.WithLiveAuthorization(httpapi.WithIdentity(r, id), httpapi.LiveAuthorization{Revalidate: func(context.Context) (httpapi.Identity, error) { return id, nil }}))
		})
	}
	if e = liveHTTP.RegisterLiveRoutes(router, live, guard); e != nil {
		t.Fatal(e)
	}
	srv := httptest.NewServer(router)
	defer srv.Close()
	prefix := srv.URL + "/api/v2/projects/" + nodeLeaseProject + "/"
	client := srv.Client()
	client.Timeout = 4 * time.Second
	read := func(path string) []byte {
		resp, e := client.Get(prefix + path)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		content, e := io.ReadAll(resp.Body)
		if e != nil || resp.StatusCode != 200 {
			t.Fatal(resp.Status, e)
		}
		return content
	}
	smallObserver := read("live-update?fromRevision=" + origin)
	largeObserver := read("live-snapshot")
	var watch struct{ Data app.LiveUpdate }
	if json.Unmarshal(smallObserver, &watch) != nil || watch.Data.Delta == nil || watch.Data.GraphRevision != sent.Data.Revision || watch.Data.EventCursor != sent.Data.EventCursor || watch.Data.Delta.Positions[0].X != 165 {
		t.Fatal("observer did not match commit")
	}
	r, _ := http.NewRequest("GET", prefix+"events?after="+base.EventCursor, nil)
	r.Header.Set("Accept", "text/event-stream")
	r.Header.Set("X-STUDIO-Canvas-Update", "delta-v1")
	resp, e := client.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	frameBytes := 0
	gotID, gotEvent := false, false
	for {
		line, e := reader.ReadString('\n')
		if e != nil {
			t.Fatal("incomplete frame", resp.Status, e)
		}
		if strings.HasPrefix(line, "id: ") {
			gotID = strings.TrimSpace(strings.TrimPrefix(line, "id: ")) == sent.Data.EventCursor
		}
		if strings.HasPrefix(line, "event: ") {
			gotEvent = strings.TrimSpace(line) == "event: canvas.delta"
		}
		if gotID {
			frameBytes += len(line)
		}
		if strings.HasPrefix(line, "data: ") {
			var v app.LiveUpdate
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &v) != nil || !gotID || !gotEvent || v.Delta == nil || v.Delta.Positions[0].X != 165 || v.GraphRevision != sent.Data.Revision {
				t.Fatal("wrong SSE frame", line[:min(len(line), 120)])
			}
			break
		}
	}
	if len(small.raw)*20 >= len(full.raw) || len(smallObserver)*20 >= len(largeObserver) || frameBytes*20 >= len(largeObserver) {
		t.Fatal("large graph repeated")
	}
	t.Logf("242 nodes; sender HTTP %d vs full receipt %d bytes; observer HTTP %d vs full snapshot %d; inline SSE %d bytes (uncompressed)", len(small.raw), len(full.raw), len(smallObserver), len(largeObserver), frameBytes+1)
	// A no-op may be acknowledged compactly without inventing another revision.
	delete(req, "receiptOnly")
	req["batchId"] = uuid.NewString()
	headers[3] = strconv.FormatInt(sent.Data.Revision, 10)
	noop := f.call(t, a, "POST", "canvas-operations", req, 200, headers...)
	if !strings.Contains(noop.raw, `"positions":[]`) {
		t.Fatal("same revision was not empty")
	}
}
