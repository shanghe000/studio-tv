package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	executionPG "studiotv.local/service/api/internal/modules/execution/adapters/postgres"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	domain "studiotv.local/service/api/internal/modules/execution/domain"
	lfpg "studiotv.local/service/api/internal/modules/longform/adapters/postgres"
	app "studiotv.local/service/api/internal/modules/longform/application"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	mediaPG "studiotv.local/service/api/internal/modules/modelmedia/adapters/postgres"
	media "studiotv.local/service/api/internal/modules/modelmedia/application"
	"studiotv.local/service/api/internal/testdb"
)

type fixture struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	store  *lfpg.Store
	caller app.Caller
	in     app.Create
}

func setup(t *testing.T) fixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool := testdb.New(t).Open(t)
	if e := database.Migrate(ctx, pool); e != nil {
		t.Fatal(e)
	}
	_, e := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('lf-owner','lf@example.test','Longform'),('lf-other','lfother@example.test','Other');
 INSERT INTO public.projects(id,owner_id,name,graph)VALUES('lf-canvas','lf-owner','Longform fixture','{"nodes":[{"id":"source","type":"rh-image","data":{"sourceObjects":["rhtv-asset:ast_lf_input"]}},{"id":"video","type":"rh-video","data":{}}],"edges":[{"source":"source","target":"video"}]}');
 INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key)VALUES('ast_lf_input','lf-owner','lf-canvas','input.png','IMAGE','image/png',100,repeat('a',64),'READY','ast_lf_input'),('ast_lf_unbound','lf-owner','lf-canvas','unbound.png','IMAGE','image/png',100,repeat('b',64),'READY','ast_lf_unbound');
 INSERT INTO collaboration.canvas_edit_sessions(project_id,actor_id,session_id,client_id,expires_at)VALUES('lf-canvas','lf-owner','lf-session','lf-page',now()+interval '5 minutes')`)
	if e != nil {
		t.Fatal(e)
	}
	return fixture{ctx, pool, lfpg.New(pool), app.Caller{Identity: httpapi.Identity{UserID: "lf-owner", SessionID: "lf-session"}, ClientID: "lf-page"}, app.Create{RequestID: uuid.NewString(), CanvasID: "lf-canvas", NodeID: "video", Title: "fixture", Settings: json.RawMessage(`{"seed":"18446744073709551615"}`), CommonPrompt: "fixture", Segments: json.RawMessage(`[{"id":"s1","prompt":"fixture"}]`), References: []app.Reference{{Kind: "IMAGE", AssetID: "ast_lf_input"}}}}
}
func status(e error) int {
	var a *httpapi.Error
	if errors.As(e, &a) {
		return a.Status
	}
	return 0
}
func TestLongformBindingPermissionsReceiptsAndScopedMedia(t *testing.T) {
	f := setup(t)
	wrong := f.caller
	wrong.ClientID = "another-page"
	if _, _, e := f.store.PrepareCreate(f.ctx, wrong, f.in, strings.Repeat("a", 64)); status(e) != 409 {
		t.Fatal("other page wrote", e)
	}
	wrong = f.caller
	wrong.Identity.UserID = "lf-other"
	if _, _, e := f.store.PrepareCreate(f.ctx, wrong, f.in, strings.Repeat("a", 64)); status(e) != 404 {
		t.Fatal("foreign canvas visible", e)
	}
	unbound := f.in
	unbound.References = []app.Reference{{Kind: "IMAGE", AssetID: "ast_lf_unbound"}}
	if _, _, e := f.store.PrepareCreate(f.ctx, f.caller, unbound, strings.Repeat("a", 64)); status(e) != 422 {
		t.Fatal("unbound media accepted", e)
	}
	b, r, e := f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("a", 64))
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(r.Body), `"seed":"18446744073709551615"`) || strings.Contains(string(r.Body), `"canvasId"`) {
		t.Fatal("seed precision or private binding leaked", string(r.Body))
	}
	replay, again, e := f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("a", 64))
	if e != nil || replay.ID != b.ID || !jsonEqual(again.Body, r.Body) {
		t.Fatal("stable receipt lost", e)
	}
	if _, _, e = f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("b", 64)); status(e) != 409 {
		t.Fatal("request collision accepted", e)
	}
	if _, e = f.store.Get(f.ctx, "lf-other", b.ID, false); status(e) != 404 {
		t.Fatal("binding leaked", e)
	}
	var create struct {
		References []struct {
			Attachment struct{ SourceRef, SourceVersion, SHA256, ReadGrantRef string }
		}
	}
	if e = json.Unmarshal(r.Body, &create); e != nil {
		t.Fatal(e)
	}
	a := create.References[0].Attachment
	reader := mediaPG.New(f.pool, nil)
	grant := media.Request{SubjectRef: "lf-owner", SourceRef: a.SourceRef, SourceVersion: a.SourceVersion, SHA256: a.SHA256, ReadGrantRef: a.ReadGrantRef}
	if _, e = reader.Resolve(f.ctx, grant); e != nil {
		t.Fatal("valid media grant failed", e)
	}
	grant.SubjectRef = "lf-other"
	if _, e = reader.Resolve(f.ctx, grant); !errors.Is(e, media.ErrNotFound) {
		t.Fatal("grant crossed owner", e)
	}
	grant.SubjectRef = "lf-owner"
	if _, e = f.pool.Exec(f.ctx, `UPDATE public.assets SET deleted_at=now() WHERE id='ast_lf_input'`); e != nil {
		t.Fatal(e)
	}
	if _, e = reader.Resolve(f.ctx, grant); !errors.Is(e, media.ErrNotFound) {
		t.Fatal("revoked asset grant survived", e)
	}
}
func TestLongformArchivesHistoryAndCanvasWithoutRepeatedRevisions(t *testing.T) {
	f := setup(t)
	b, r, e := f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("a", 64))
	if e != nil {
		t.Fatal(e)
	}
	art := uuid.NewString()
	b.RemoteID = uuid.NewString()
	if _, e = f.pool.Exec(f.ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key,width,height,duration_seconds)VALUES('ast_lf_result','lf-owner','lf-canvas','result.mp4','VIDEO','video/mp4',100,repeat('c',64),'READY','ast_lf_result',1344,768,60)`); e != nil {
		t.Fatal(e)
	}
	raw := json.RawMessage(`{"id":"` + b.RemoteID + `","revision":2,"activeJobId":null,"segments":[],"compositions":[{"id":"comp","artifactId":"` + art + `","assetId":"ast_lf_result","url":"rhtv-asset:ast_lf_result"}]}`)
	w, h := 1344, 768
	duration := int64(60000)
	archive := app.Archived{ArtifactID: art, Asset: execution.Asset{ID: "ast_lf_result", Kind: "VIDEO", MimeType: "video/mp4", SHA256: strings.Repeat("c", 64), Width: &w, Height: &h, DurationMs: &duration}, Composition: true}
	b, e = f.store.Save(f.ctx, b, raw, []app.Archived{archive}, &r)
	if e != nil {
		t.Fatal(e)
	}
	var revision int
	if e = f.pool.QueryRow(f.ctx, `SELECT revision FROM public.projects WHERE id='lf-canvas'`).Scan(&revision); e != nil {
		t.Fatal(e)
	}
	if _, e = f.store.Save(f.ctx, b, raw, nil, nil); e != nil {
		t.Fatal(e)
	}
	var after int
	_ = f.pool.QueryRow(f.ctx, `SELECT revision FROM public.projects WHERE id='lf-canvas'`).Scan(&after)
	if after != revision {
		t.Fatal("unchanged polling mutated canvas", revision, after)
	}
	var graph string
	_ = f.pool.QueryRow(f.ctx, `SELECT graph::text FROM public.projects WHERE id='lf-canvas'`).Scan(&graph)
	if !strings.Contains(graph, "rhtv-asset:ast_lf_result") || !strings.Contains(graph, b.ID) {
		t.Fatal("composition not written", graph)
	}
	history, _ := executionPG.New(f.pool)
	page, e := history.History(f.ctx, "lf-owner", execution.HistoryQuery{ProjectID: "lf-canvas", NodeID: "video", Type: "", Page: 1, Size: 20})
	if e != nil || len(page.Records) != 1 || page.Records[0].Outputs[0].AssetID == nil || *page.Records[0].Outputs[0].AssetID != "ast_lf_result" {
		t.Fatal("existing history cannot read longform", e, page)
	}
	if _, e = history.Get(f.ctx, "lf-owner", page.Records[0].TaskID); e != nil {
		t.Fatal("history task payload incompatible", e)
	}
	old := json.RawMessage(`{"id":"` + b.RemoteID + `","revision":1,"segments":[],"compositions":[]}`)
	saved, e := f.store.Save(f.ctx, b, old, nil, nil)
	if e != nil || !strings.Contains(string(saved.Snapshot), `"revision": 2`) {
		t.Fatal("stale poll rolled back snapshot", e, string(saved.Snapshot))
	}
}
func TestLongformActionsFreezeReferencesAndKeepFollowing(t *testing.T) {
	f := setup(t)
	b, r, e := f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("a", 64))
	if e != nil {
		t.Fatal(e)
	}
	b.RemoteID = uuid.NewString()
	b, e = f.store.Save(f.ctx, b, json.RawMessage(`{"id":"`+b.RemoteID+`","revision":1,"segments":[],"compositions":[]}`), nil, &r)
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	body := json.RawMessage(`{"requestId":"` + id + `","expectedRevision":1,"type":"retrySegment","segmentId":"s1","references":[{"kind":"IMAGE","assetId":"ast_lf_input"}],"commonPrompt":"new"}`)
	if e = app.ValidateAction(body); e != nil {
		t.Fatal(e)
	}
	_, req, e := f.store.PrepareAction(f.ctx, f.caller, b.ID, body, strings.Repeat("d", 64))
	if e != nil || !strings.Contains(string(req.Body), "readGrantRef") || strings.Contains(string(req.Body), `"assetId"`) {
		t.Fatal("retry reference bypassed transfer", e, string(req.Body))
	}
	update := json.RawMessage(`{"requestId":"` + uuid.NewString() + `","expectedRevision":1,"type":"updateDraft","patch":{"title":"Updated","settings":{"seed":"18446744073709551615"},"references":[{"kind":"IMAGE","assetId":"ast_lf_input"}]}}`)
	_, updateReq, e := f.store.PrepareAction(f.ctx, f.caller, b.ID, update, strings.Repeat("e", 64))
	if e != nil {
		t.Fatal(e)
	}
	var flat map[string]json.RawMessage
	_ = json.Unmarshal(updateReq.Body, &flat)
	if flat["patch"] != nil || string(flat["title"]) != `"Updated"` || !strings.Contains(string(flat["references"]), "readGrantRef") || !strings.Contains(string(flat["settings"]), "18446744073709551615") {
		t.Fatal("updateDraft was not flattened safely", string(updateReq.Body))
	}
	b, e = f.store.Save(f.ctx, b, json.RawMessage(`{"id":"`+b.RemoteID+`","revision":2,"segments":[],"compositions":[]}`), nil, &updateReq)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(b.CreateBody), "readGrantRef") {
		t.Fatal("flat draft lost locally trusted asset references")
	}
	keep := json.RawMessage(`{"requestId":"` + uuid.NewString() + `","expectedRevision":1,"type":"keepFollowing","segmentId":"s1"}`)
	if e = app.ValidateAction(keep); e != nil {
		t.Fatal(e)
	}
}

func jsonEqual(a, b []byte) bool {
	var x, y any
	_ = json.Unmarshal(a, &x)
	_ = json.Unmarshal(b, &y)
	return reflect.DeepEqual(x, y)
}

// The gateway fixture reports only draft state: no synthetic model output.
type draftGateway struct {
	remote                   string
	createCalls, actionCalls int
	rejectCreateOnce         bool
	rejectAction             bool
}

func (g *draftGateway) LongformCapabilities(context.Context, gateway.Actor) (json.RawMessage, error) {
	return json.RawMessage(`{"available":true}`), nil
}
func (g *draftGateway) LongformCreate(context.Context, gateway.Actor, json.RawMessage) (json.RawMessage, error) {
	g.createCalls++
	if g.rejectCreateOnce && g.createCalls == 1 {
		return nil, &gateway.Fault{Code: "GATEWAY_UNAVAILABLE", HTTPStatus: 503, Retryable: true}
	}
	return json.RawMessage(`{"id":"` + g.remote + `","revision":1,"segments":[],"compositions":[]}`), nil
}
func (g *draftGateway) LongformProject(context.Context, gateway.Actor, string) (json.RawMessage, error) {
	return json.RawMessage(`{"id":"` + g.remote + `","revision":1,"segments":[],"compositions":[]}`), nil
}
func (g *draftGateway) LongformAction(context.Context, gateway.Actor, string, json.RawMessage) (json.RawMessage, error) {
	g.actionCalls++
	return nil, &gateway.Fault{Code: "LONGFORM_PREDECESSOR_REQUIRED", HTTPStatus: 409}
}
func (g *draftGateway) LongformArtifact(context.Context, gateway.Actor, string, string) (gateway.Artifact, []byte, error) {
	panic("draft cannot fetch artifacts")
}

type noArtifacts struct{}

func (noArtifacts) ImportLongform(context.Context, string, string, string, gateway.Artifact, []byte) (execution.Asset, error) {
	panic("draft cannot import artifacts")
}
func TestLongformUncertainSubmissionReplaysButDefiniteRejectionStops(t *testing.T) {
	f := setup(t)
	g := &draftGateway{remote: uuid.NewString(), rejectCreateOnce: true}
	s := app.New(f.store, g, noArtifacts{}, true)
	if _, e := s.Create(f.ctx, f.caller, f.in); e == nil {
		t.Fatal("uncertain create reported success")
	}
	listed, listErr := s.List(f.ctx, "lf-owner", "lf-canvas", "video")
	if listErr != nil || !strings.Contains(string(mustJSON(listed)), "PENDING") {
		t.Fatal("pending project list cannot restore", listErr, listed)
	}
	pending, e := f.store.Pending(f.ctx)
	if e != nil || len(pending) != 1 {
		t.Fatal("uncertain receipt lost", e)
	}
	raw, e := s.Create(f.ctx, f.caller, f.in)
	if e != nil || g.createCalls != 2 || !strings.Contains(string(raw), f.in.RequestID) {
		t.Fatal("same request failed recovery", e, string(raw))
	}
	action := json.RawMessage(`{"requestId":"` + uuid.NewString() + `","expectedRevision":1,"type":"retrySegment","segmentId":"s1"}`)
	if _, e = s.Action(f.ctx, f.caller, f.in.RequestID, action); e == nil {
		t.Fatal("definite rejection reported success")
	}
	b, e := f.store.Get(f.ctx, "lf-owner", f.in.RequestID, false)
	if e != nil {
		t.Fatal(e)
	}
	rs, e := f.store.PendingRequests(f.ctx, b)
	if e != nil || len(rs) != 0 {
		t.Fatal("rejected action left for replay", e)
	}
	if _, e = s.Get(f.ctx, "lf-owner", b.ID); e != nil || g.actionCalls != 1 {
		t.Fatal("GET resubmitted rejected operation", e, g.actionCalls)
	}
}

func TestLongformLateOutputCannotOverwriteRecreatedNodeAndBlocksOrdinaryGeneration(t *testing.T) {
	f := setup(t)
	b, r, e := f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("a", 64))
	if e != nil {
		t.Fatal(e)
	}
	ordinary, _ := executionPG.New(f.pool)
	pid := "lf-canvas"
	now := time.Now().UTC()
	task := domain.Task{ID: "tsk_" + uuid.NewString(), OwnerID: "lf-owner", InitiatedBy: "lf-owner", ProjectID: &pid, Kind: "CANVAS", TargetType: "NODE", TargetID: "video", State: "QUEUED", Revision: 1, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(`{"nodes":[],"edges":[]}`), Plans: []domain.Plan{{NodeID: "video", ExecutionID: "exe_" + uuid.NewString(), State: "QUEUED", Request: json.RawMessage(`{}`)}}}
	if _, e = ordinary.Create(f.ctx, task, uuid.NewString(), strings.Repeat("b", 64), nil); status(e) != 409 {
		t.Fatal("ordinary generation raced longform", e)
	}
	b.RemoteID = uuid.NewString()
	raw := json.RawMessage(`{"id":"` + b.RemoteID + `","revision":1,"segments":[],"compositions":[]}`)
	b, e = f.store.Save(f.ctx, b, raw, nil, &r)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.pool.Exec(f.ctx, `UPDATE public.projects SET graph='{"nodes":[],"edges":[]}',revision=revision+1 WHERE id='lf-canvas';UPDATE public.projects SET graph='{"nodes":[{"id":"video","type":"rh-video","data":{"prompt":"new unrelated node"}}],"edges":[]}',revision=revision+1 WHERE id='lf-canvas'`); e != nil {
		t.Fatal(e)
	}
	if _, e = f.store.Save(f.ctx, b, raw, nil, nil); e != nil {
		t.Fatal(e)
	}
	var graph string
	_ = f.pool.QueryRow(f.ctx, `SELECT graph::text FROM public.projects WHERE id='lf-canvas'`).Scan(&graph)
	if strings.Contains(graph, "studioLongformProjectId") {
		t.Fatal("recreated node inherited old longform", graph)
	}
	action := json.RawMessage(`{"requestId":"` + uuid.NewString() + `","expectedRevision":1,"type":"generateAll"}`)
	if _, _, e = f.store.PrepareAction(f.ctx, f.caller, b.ID, action, strings.Repeat("c", 64)); status(e) != 409 {
		t.Fatal("recreated node accepted old binding action", e)
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestLongformSubmittingAndComposingBlockOrdinaryGeneration(t *testing.T) {
	f := setup(t)
	b, r, e := f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("a", 64))
	if e != nil {
		t.Fatal(e)
	}
	b.RemoteID = uuid.NewString()
	ordinary, _ := executionPG.New(f.pool)
	pid := "lf-canvas"
	for i, state := range []string{"SUBMITTING", "COMPOSING"} {
		raw := json.RawMessage(`{"id":"` + b.RemoteID + `","revision":` + fmt.Sprint(i+1) + `,"segments":[],"compositions":[],"jobs":[{"id":"job","status":"` + state + `"}]}`)
		b, e = f.store.Save(f.ctx, b, raw, nil, &r)
		if e != nil {
			t.Fatal(e)
		}
		now := time.Now().UTC()
		task := domain.Task{ID: "tsk_" + uuid.NewString(), OwnerID: "lf-owner", InitiatedBy: "lf-owner", ProjectID: &pid, Kind: "CANVAS", TargetType: "NODE", TargetID: "video", State: "QUEUED", Revision: 1, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(`{"nodes":[],"edges":[]}`), Plans: []domain.Plan{{NodeID: "video", ExecutionID: "exe_" + uuid.NewString(), State: "QUEUED", Request: json.RawMessage(`{}`)}}}
		if _, e = ordinary.Create(f.ctx, task, uuid.NewString(), strings.Repeat("c", 64), nil); status(e) != 409 {
			t.Fatal("active longform state did not guard node", state, e)
		}
		pending, e := f.store.Pending(f.ctx)
		if e != nil || len(pending) != 1 {
			t.Fatal("active state lost background recovery", state, e)
		}
	}
}

func TestLongformHandoffRejectsNewActionsButAcceptsExistingReceipts(t *testing.T) {
	f := setup(t)
	binding, req, err := f.store.PrepareCreate(f.ctx, f.caller, f.in, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE collaboration.canvas_edit_sessions SET client_id='replacement-page' WHERE project_id='lf-canvas'`); err != nil {
		t.Fatal(err)
	}
	// Creation was accepted before the handoff. Its response can still be
	// reconciled; a new action from the originating page must not be queued.
	binding.RemoteID = uuid.NewString()
	next := map[string]any{"id": binding.RemoteID, "revision": 1, "settings": map[string]any{}, "segments": []any{}}
	raw, _ := json.Marshal(next)
	if _, err = f.store.Save(f.ctx, binding, raw, nil, &req); err != nil {
		t.Fatal("accepted longform response lost", err)
	}
	action := json.RawMessage(`{"requestId":"` + uuid.NewString() + `","expectedRevision":1,"type":"retrySegment","segmentId":"s1"}`)
	_, _, err = f.store.PrepareAction(f.ctx, f.caller, binding.ID, action, strings.Repeat("c", 64))
	var denied *httpapi.Error
	if !errors.As(err, &denied) || denied.Code != "PROJECT_EDIT_OCCUPIED" {
		t.Fatal("old tab accepted a longform command", err)
	}
	var count int
	if err = f.pool.QueryRow(f.ctx, `SELECT count(*) FROM longform.requests WHERE project_id=$1`, binding.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("rejected longform action changed the request ledger", count, err)
	}
	if _, err = f.store.Get(f.ctx, f.caller.Identity.UserID, binding.ID, false); err != nil {
		t.Fatal("old page lost read access", err)
	}
}
