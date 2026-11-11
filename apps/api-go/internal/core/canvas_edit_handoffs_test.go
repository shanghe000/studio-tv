package core

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
)

type handoffBrowser struct{ token, page, proof, lease string }
type handoffFixture struct {
	prepared *Resources
	*nodeLeaseWriteFixture
	accountMode          bool
	handler              http.Handler
	a, b, c, otherDevice handoffBrowser
}
type handoffResponse struct {
	raw    string
	status int
	data   struct {
		State, LeaseID, ResumeToken       string
		Released, CanJoin, AccountHandoff bool
		Protocol                          string
		Holder                            *struct {
			UserID, DisplayName string
			CanApprove          bool
		}
		Incoming []struct {
			RequestID     string
			DrainRequired bool
			SameAccount   bool
		}
		Outgoing *struct {
			RequestID, State string
			SameAccount      bool
		}
	}
	code string
}

func handoffQA(t *testing.T) *handoffFixture {
	t.Helper()
	f := newNodeLeaseWriteFixture(t)
	third := integrationPrincipal("usr_c")
	third.AccessExpiresAt = f.owner.AccessExpiresAt
	third.SessionExpiresAt = f.owner.SessionExpiresAt
	if _, e := f.db.Exec(f.ctx, `INSERT INTO public.users(id,email,display_name)VALUES('usr_c','third@example.test','Third'); INSERT INTO collaboration.project_members(project_id,user_id,role,created_by)SELECT id,'usr_c','EDITOR','usr_a' FROM projects WHERE owner_id='usr_a';`); e != nil {
		t.Fatal(e)
	}
	identities := map[string]httpapi.Identity{}
	for _, entry := range []struct {
		key string
		id  httpapi.Identity
	}{{"first", f.owner}, {"second", f.editor}, {"third", third}, {"another-device", f.owner}} {
		id := entry.id
		if entry.key == "another-device" {
			id.SessionID = "second-login-a"
		}
		identities[entry.key] = id
		_, e := f.db.Exec(f.ctx, `INSERT INTO public.sessions(id,user_id,expires_at)VALUES($1,$2,now()+interval '1 hour') ON CONFLICT DO NOTHING`, id.SessionID, id.UserID)
		if e != nil {
			t.Fatal(e)
		}
	}
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		id, ok := identities[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		if !ok {
			return id, httpapi.Fail(401, "UNAUTHENTICATED", "测试会话无效")
		}
		return id, nil
	})
	cfg := testConfig(t)
	cfg.FFprobePath = "ffprobe"
	cfg.ChromiumSandboxMode = "sandbox"
	prepared, e := PrepareResources(cfg)
	if e != nil {
		t.Fatal(e)
	}
	mux, e := NewWithAuthorization(cfg, f.db, auth, authorization.New(&integrationRuntime{}, "cli_test", &integrationSessions{}), prepared)
	if e != nil {
		t.Fatal(e)
	}
	b := func(token string) handoffBrowser {
		return handoffBrowser{token: token, page: "page_" + token, proof: uuid.NewString()}
	}
	return &handoffFixture{prepared, f, false, mux, b("first"), b("second"), b("third"), b("another-device")}
}
func (f *handoffFixture) call(t *testing.T, b handoffBrowser, method, path string, body map[string]any, want int, headers ...string) handoffResponse {
	t.Helper()
	if body == nil {
		body = map[string]any{}
	}
	if method != "GET" && !strings.HasSuffix(path, "canvas-operations") {
		body["clientId"] = b.page
	}
	buf := bytes.NewReader(nil)
	if method != "GET" {
		buf = bytes.NewReader(encode(body))
	}
	req := httptest.NewRequest(method, "/api/v2/projects/"+nodeLeaseProject+"/"+path, buf)
	if f.accountMode {
		req.Header.Set(collaboration.AccountCanvasHeader, collaboration.AccountCanvasProtocol)
	}
	req.Header.Set("Authorization", "Bearer "+b.token)
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Add(headers[i], headers[i+1])
	}
	req.Header.Set(collaboration.CanvasSessionHeader, b.page)
	if b.lease != "" {
		req.Header.Set(collaboration.CanvasLeaseHeader, b.lease)
	}
	if b.proof != "" {
		req.Header.Set(collaboration.CanvasProofHeader, b.proof)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	out := handoffResponse{raw: w.Body.String(), status: w.Code}
	var record struct {
		Code  any
		Data  json.RawMessage
		Error struct{ Code string }
	}
	if e := json.Unmarshal(w.Body.Bytes(), &record); e != nil {
		t.Fatal(e)
	}
	if record.Data != nil {
		if e := json.Unmarshal(record.Data, &out.data); e != nil {
			t.Fatal(e)
		}
	}
	out.code = record.Error.Code
	if v, ok := record.Code.(string); ok && out.code == "" {
		out.code = v
	}
	if want > 0 && w.Code != want {
		t.Fatalf("%s %s %s: got %d %s, want %d", b.page, method, path, w.Code, out.code, want)
	}
	return out
}

const writerPath = "edit-session"

func (f *handoffFixture) acquire(t *testing.T, b handoffBrowser) handoffResponse {
	return f.call(t, b, "POST", writerPath, map[string]any{"requireSync": true}, 200)
}
func (f *handoffFixture) ready(t *testing.T, b handoffBrowser, lease string) handoffResponse {
	var rev int64
	if e := f.db.QueryRow(f.ctx, `SELECT revision FROM public.projects WHERE id=$1`, nodeLeaseProject).Scan(&rev); e != nil {
		t.Fatal(e)
	}
	return f.call(t, b, "POST", writerPath+"/ready", map[string]any{"revision": rev, "leaseId": lease}, 200)
}
func (f *handoffFixture) request(t *testing.T, b handoffBrowser, id string) handoffResponse {
	return f.call(t, b, "POST", writerPath+"/requests", map[string]any{"requestId": id}, 200)
}
func (f *handoffFixture) decide(t *testing.T, b handoffBrowser, id, decision string, want int) handoffResponse {
	return f.call(t, b, "POST", writerPath+"/requests/"+id+"/decision", map[string]any{"decision": decision, "leaseId": f.status(t, b).data.LeaseID}, want)
}
func (f *handoffFixture) write(t *testing.T, b handoffBrowser, value string, want int) handoffResponse {
	b.lease = f.status(t, b).data.LeaseID
	return f.writeWithLease(t, b, value, want)
}
func (f *handoffFixture) writeWithLease(t *testing.T, b handoffBrowser, value string, want int) handoffResponse {
	return f.call(t, b, "POST", "canvas-operations", map[string]any{"schemaVersion": "1", "batchId": uuid.NewString(), "clientId": b.page, "operations": []canvasOperation{operationPatch("n1", value)}}, want)
}
func (f *handoffFixture) status(t *testing.T, b handoffBrowser) handoffResponse {
	return f.call(t, b, "GET", writerPath, nil, 200)
}

func TestPostgresDirectedWriterHasNoUnownedWindowAndConfirmsLatestSnapshot(t *testing.T) {
	f := handoffQA(t)
	first := f.acquire(t, f.a)
	if first.data.State != "SYNC_REQUIRED" || first.data.ResumeToken == "" {
		t.Fatal("missing initial reservation/credential")
	}
	f.write(t, f.a, "too early", 409)
	f.ready(t, f.a, first.data.LeaseID)
	id1, id2 := uuid.NewString(), uuid.NewString()
	for _, item := range []struct {
		b  handoffBrowser
		id string
	}{{f.b, id1}, {f.c, id2}} {
		v := f.request(t, item.b, item.id)
		if v.data.State != "OCCUPIED" || v.data.Outgoing.State != "PENDING" {
			t.Fatal("waiting page should remain read-only")
		}
	}
	f.write(t, f.a, "flushed before transfer", 200)
	if len(f.status(t, f.a).data.Incoming) != 2 {
		t.Fatal("holder cannot see both requests")
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 6 {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; f.call(t, f.c, "POST", writerPath, nil, 409) }()
	}
	wg.Add(1)
	go func() { defer wg.Done(); <-start; f.decide(t, f.a, id1, "APPROVE", 200) }()
	close(start)
	wg.Wait()
	target := f.status(t, f.b)
	if target.data.State != "SYNC_REQUIRED" || target.data.Outgoing.State != "TRANSFERRED" || target.data.ResumeToken != "" {
		t.Fatal("transfer did not reserve specifically for recipient")
	}
	if f.status(t, f.c).data.Outgoing.State != "EXPIRED" {
		t.Fatal("losing request did not expire")
	}
	if got := f.call(t, f.a, "POST", writerPath, map[string]any{"leaseId": first.data.LeaseID}, 409); got.code != "EDIT_SESSION_EXPIRED" {
		t.Fatal(got.code)
	}
	if got := f.call(t, f.a, "DELETE", writerPath, map[string]any{"leaseId": first.data.LeaseID}, 200); got.data.Released {
		t.Fatal("stale release affected recipient")
	}
	if f.write(t, f.b, "not loaded yet", 409).code != "CANVAS_SYNC_REQUIRED" {
		t.Fatal("recipient prematurely enabled")
	}
	if f.call(t, f.b, "POST", writerPath+"/ready", map[string]any{"revision": 0, "leaseId": target.data.LeaseID}, 409).code != "CANVAS_SYNC_REQUIRED" {
		t.Fatal("accepted stale snapshot")
	}
	if !strings.Contains(f.state(t).Graph, "flushed before transfer") {
		t.Fatal("handoff lost source flush")
	}
	ready := f.ready(t, f.b, target.data.LeaseID)
	if ready.data.ResumeToken == "" || ready.data.State != "HELD" || f.ready(t, f.b, target.data.LeaseID).data.ResumeToken != ready.data.ResumeToken {
		t.Fatal("ready retry must recover the same credential")
	}
	f.write(t, f.b, "recipient edit", 200)
	f.write(t, f.a, "superseded write", 409)
	back := uuid.NewString()
	f.request(t, f.a, back)
	f.decide(t, f.b, back, "APPROVE", 200)
	reacquired := f.status(t, f.a)
	f.ready(t, f.a, reacquired.data.LeaseID)
	stale := f.a
	stale.lease = first.data.LeaseID
	before := f.state(t)
	if f.writeWithLease(t, stale, "late first A tenure", 409).code != "EDIT_SESSION_EXPIRED" {
		t.Fatal("old A request escaped the renewed A tenure fence")
	}
	if f.writeWithLease(t, f.a, "missing writer epoch", 409).code != "EDIT_SESSION_EXPIRED" {
		t.Fatal("modern write without its term was accepted")
	}
	for _, body := range []map[string]any{nil, {"leaseId": first.data.LeaseID}} {
		if f.call(t, f.a, "DELETE", writerPath, body, 200).data.Released {
			t.Fatal("missing or first A tenure released this page's second tenure")
		}
	}
	if f.state(t) != before {
		t.Fatal("rejected ABA write mutated the project")
	}
	f.write(t, f.a, "only new A tenure", 200)
	f.decide(t, f.a, id1, "APPROVE", 200)
	if f.status(t, f.a).data.LeaseID != reacquired.data.LeaseID {
		t.Fatal("old approval replay replaced A after A to B to A")
	}
}

func TestPostgresReloadRotatesSecretAndFencesOldPage(t *testing.T) {
	f := handoffQA(t)
	h := f.acquire(t, f.a)
	f.ready(t, f.a, h.data.LeaseID)
	copy := f.a
	copy.page = "reloaded"
	copy.proof = uuid.NewString()
	imp := f.a
	imp.proof = uuid.NewString()
	f.write(t, imp, "spoof", 409)
	if v := f.status(t, imp); v.data.State != "OCCUPIED" || v.data.LeaseID != "" || v.data.ResumeToken != "" || strings.Contains(v.raw, f.a.page) {
		t.Fatal("page ID alone disclosed owner details")
	}
	if v := f.call(t, imp, "POST", writerPath, map[string]any{"leaseId": h.data.LeaseID}, 409); strings.Contains(v.raw, f.a.page) {
		t.Fatal("conflict error disclosed holder's page ID")
	}
	f.call(t, f.otherDevice, "POST", writerPath, map[string]any{"resumeToken": h.data.ResumeToken}, 409)
	rr := f.call(t, copy, "POST", writerPath, map[string]any{"resumeToken": h.data.ResumeToken}, 200)
	if rr.data.State != "SYNC_REQUIRED" || rr.data.ResumeToken == h.data.ResumeToken || rr.data.LeaseID == h.data.LeaseID {
		t.Fatal("resume did not rotate")
	}
	f.call(t, f.a, "POST", writerPath, map[string]any{"resumeToken": h.data.ResumeToken}, 409)
	f.call(t, f.a, "POST", writerPath, map[string]any{"leaseId": h.data.LeaseID}, 409)
	if f.call(t, f.a, "DELETE", writerPath, nil, 200).data.Released {
		t.Fatal("late old page release")
	}
	f.ready(t, copy, rr.data.LeaseID)
	f.write(t, copy, "new page", 200)
	if !f.call(t, copy, "DELETE", writerPath, map[string]any{"leaseId": rr.data.LeaseID}, 200).data.Released {
		t.Fatal("current release lost")
	}
	f.call(t, f.a, "POST", writerPath, nil, 409)
}

func TestPostgresForegroundSelfRequestExpiresSupersedesAndCannotStealOnObservation(t *testing.T) {
	f := handoffQA(t)
	h := f.acquire(t, f.a)
	f.ready(t, f.a, h.data.LeaseID)
	sameDevice := f.a
	sameDevice.page = "another-tab"
	sameDevice.proof = uuid.NewString()
	first, last := uuid.NewString(), uuid.NewString()
	f.request(t, sameDevice, first)
	state := f.request(t, f.otherDevice, last)
	if !state.data.Outgoing.SameAccount {
		t.Fatal("other device is same account")
	}
	if f.status(t, sameDevice).data.Outgoing.State != "CANCELED" {
		t.Fatal("old foreground request still competes")
	}
	f.request(t, sameDevice, first)
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_requests SET created_at=clock_timestamp()-interval '31 seconds' WHERE request_id=$1`, last); e != nil {
		t.Fatal(e)
	}
	if f.status(t, f.otherDevice).data.State != "OCCUPIED" {
		t.Fatal("GET transferred ownership")
	}
	f.call(t, f.a, "POST", writerPath, map[string]any{"leaseId": h.data.LeaseID}, 200)
	if f.status(t, f.a).data.State != "HELD" {
		t.Fatal("waiting request froze original holder")
	}
	if st := f.request(t, f.otherDevice, last); st.data.State != "SYNC_REQUIRED" {
		t.Fatal("foreground retry did not progress after grace")
	}
	f.write(t, f.a, "late edit", 409)
}

func TestPostgresHandoffRejectCancelExpireAndPermissionRevocation(t *testing.T) {
	f := handoffQA(t)
	h := f.acquire(t, f.a)
	f.ready(t, f.a, h.data.LeaseID)
	declined := uuid.NewString()
	f.request(t, f.b, declined)
	f.decide(t, f.a, declined, "DECLINE", 200)
	if f.request(t, f.b, declined).data.Outgoing.State != "DECLINED" {
		t.Fatal("declined request revived")
	}
	canceled := uuid.NewString()
	f.request(t, f.b, canceled)
	f.call(t, f.b, "DELETE", writerPath+"/requests/"+canceled, nil, 200)
	f.decide(t, f.a, canceled, "APPROVE", 200)
	if f.status(t, f.a).data.State != "HELD" {
		t.Fatal("canceled request transferred")
	}
	expired := uuid.NewString()
	f.request(t, f.b, expired)
	_, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1`, expired)
	if e != nil {
		t.Fatal(e)
	}
	f.decide(t, f.a, expired, "APPROVE", 409)
	req := uuid.NewString()
	f.request(t, f.b, req)
	if _, e = f.db.Exec(f.ctx, `UPDATE collaboration.project_members SET role='VIEWER' WHERE project_id=$1 AND user_id='usr_b'`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	f.decide(t, f.a, req, "APPROVE", 409)
	f.call(t, f.b, "POST", writerPath+"/requests", map[string]any{"requestId": uuid.NewString()}, 403)
	if old := f.status(t, f.a); old.data.State != "HELD" || len(old.data.Incoming) != 0 {
		t.Fatal("revoked applicant remains eligible")
	}
	if _, e = f.db.Exec(f.ctx, `UPDATE collaboration.project_members SET role='EDITOR' WHERE project_id=$1 AND user_id='usr_b'`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	// The public membership APIs bump this project counter on each change.
	if _, e = f.db.Exec(f.ctx, `UPDATE public.projects SET collaboration_revision=collaboration_revision+2 WHERE id=$1`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	f.decide(t, f.a, req, "APPROVE", 409)
	loggedOut := uuid.NewString()
	f.request(t, f.b, loggedOut)
	if _, e = f.db.Exec(f.ctx, `UPDATE public.sessions SET revoked_at=now() WHERE id=$1`, f.editor.SessionID); e != nil {
		t.Fatal(e)
	}
	f.decide(t, f.a, loggedOut, "APPROVE", 409)
	if f.status(t, f.a).data.State != "HELD" {
		t.Fatal("unavailable recipient displaced original")
	}
}

func TestPostgresExpiredHolderNeedsExplicitApplicantAndForeignTimeoutCannotForce(t *testing.T) {
	f := handoffQA(t)
	source := f.acquire(t, f.a)
	f.ready(t, f.a, source.data.LeaseID)
	id := uuid.NewString()
	f.request(t, f.b, id)
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_requests SET created_at=clock_timestamp()-interval '45 seconds' WHERE request_id=$1`, id); e != nil {
		t.Fatal(e)
	}
	if st := f.request(t, f.b, id); st.data.State != "OCCUPIED" || st.data.Outgoing.State != "PENDING" {
		t.Fatal("another account could force a live writer after grace")
	}
	f.write(t, f.a, "another member is waiting", 200)
	// Neither observer extends the holder's deadline, even if the viewer asks
	// repeatedly. Once expired, a foreground request may claim without a reply.
	var before, after string
	const deadline = `SELECT expires_at::text FROM collaboration.canvas_edit_sessions WHERE project_id=$1`
	if e := f.db.QueryRow(f.ctx, deadline, nodeLeaseProject).Scan(&before); e != nil {
		t.Fatal(e)
	}
	for range 2 {
		f.status(t, f.a)
		f.status(t, f.b)
	}
	if e := f.db.QueryRow(f.ctx, deadline, nodeLeaseProject).Scan(&after); e != nil || before != after {
		t.Fatal("observing extended the lease", e)
	}
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	if st := f.status(t, f.b); st.data.State != "FREE" || st.data.Outgoing.State != "PENDING" {
		t.Fatal("status poll silently moved expired lease")
	}
	reservation := f.request(t, f.b, id)
	if reservation.data.State != "SYNC_REQUIRED" {
		t.Fatal("abandoned owner blocked explicit request")
	}
	// A closed or stuck recipient cannot renew its pre-confirmation reservation.
	if e := f.db.QueryRow(f.ctx, deadline, nodeLeaseProject).Scan(&before); e != nil {
		t.Fatal(e)
	}
	f.call(t, f.b, "POST", writerPath, map[string]any{"leaseId": reservation.data.LeaseID}, 200)
	if e := f.db.QueryRow(f.ctx, deadline, nodeLeaseProject).Scan(&after); e != nil || after != before {
		t.Fatal("unconfirmed reservation extends indefinitely", e)
	}
}

func TestPostgresLegacyWaitersCannotAcquireAnUpgradedCanvas(t *testing.T) {
	f := handoffQA(t)
	oldHolder, oldWaiter := f.a, f.c
	oldHolder.proof, oldWaiter.proof = "", ""
	f.call(t, oldHolder, "POST", writerPath, nil, 200)
	// Passive observation does not force a protocol upgrade.
	if status := f.status(t, f.b); status.data.State != "OCCUPIED" || status.data.Holder == nil || status.data.Holder.CanApprove {
		t.Fatal("the waiting user lacked an accurate legacy-holder capability")
	}
	f.call(t, oldWaiter, "POST", writerPath, nil, 409)
	id := uuid.NewString()
	f.request(t, f.b, id)
	if got := f.call(t, oldWaiter, "POST", writerPath, nil, 403); got.code != "CANVAS_CLIENT_UPGRADE_REQUIRED" || !strings.Contains(got.raw, "刷新") {
		t.Fatal("deployed legacy client needs a permanent refresh instruction")
	}
	f.call(t, oldHolder, "POST", writerPath, nil, 200)
	f.put(t, f.owner, oldHolder.page, f.edit(t, "n1", "original holder finished saving"), 200)
	if _, err := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_requests SET created_at=clock_timestamp()-interval '45 seconds' WHERE request_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if got := f.request(t, f.b, id); got.data.State != "OCCUPIED" || got.data.Outgoing.State != "PENDING" {
		t.Fatal("foreign modern page took an active legacy writer")
	}
	if !f.call(t, oldHolder, "DELETE", writerPath, nil, 200).data.Released {
		t.Fatal("original legacy writer could not exit")
	}
	before := f.state(t)
	f.put(t, f.owner, oldHolder.page, f.edit(t, "n1", "late legacy snapshot"), 403)
	if f.state(t) != before {
		t.Fatal("a legacy snapshot escaped the free-project fence")
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			f.call(t, oldWaiter, "POST", writerPath, nil, 403)
		}()
	}
	close(start)
	got := f.request(t, f.b, id)
	wg.Wait()
	if got.data.State != "SYNC_REQUIRED" || got.data.Holder == nil || !got.data.Holder.CanApprove {
		t.Fatal("only the modern foreground applicant should own the reservation")
	}
	f.ready(t, f.b, got.data.LeaseID)
	f.write(t, f.b, "new writer confirmed", 200)
	if !f.call(t, f.b, "DELETE", writerPath, map[string]any{"leaseId": got.data.LeaseID}, 200).data.Released {
		t.Fatal("current modern writer could not exit")
	}
	f.call(t, oldWaiter, "POST", writerPath, nil, 403)
}

func TestPostgresModernAcquirePermanentlyFencesLegacyAfterExpiry(t *testing.T) {
	f := handoffQA(t)
	f.acquire(t, f.a)
	if _, err := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	legacy := f.b
	legacy.proof = ""
	if got := f.call(t, legacy, "POST", writerPath, nil, 403); got.code != "CANVAS_CLIENT_UPGRADE_REQUIRED" {
		t.Fatal(got.code)
	}
	if f.acquire(t, f.b).data.State != "SYNC_REQUIRED" {
		t.Fatal("modern foreground page could not take the free canvas")
	}
}

func TestPostgresBusyCanvasWaitsForGestureAndRecoversAfterOwnerVanishes(t *testing.T) {
	f := handoffQA(t)
	h := f.acquire(t, f.a)
	f.ready(t, f.a, h.data.LeaseID)
	if result := f.call(t, f.otherDevice, "POST", writerPath+"/requests", map[string]any{"requestId": uuid.NewString(), "onlyIfFree": true}, 200); result.data.Outgoing != nil || result.data.State != "OCCUPIED" {
		t.Fatal("vacancy check requested a takeover")
	}
	req := uuid.NewString()
	f.request(t, f.otherDevice, req)
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_requests SET created_at=clock_timestamp()-interval '45 seconds' WHERE request_id=$1`, req); e != nil {
		t.Fatal(e)
	}
	if v := f.call(t, f.otherDevice, "POST", writerPath+"/requests", map[string]any{"requestId": req, "onlyIfFree": true}, 200); v.data.State != "OCCUPIED" {
		t.Fatal("onlyIfFree forced takeover on an existing request")
	}
	f.decide(t, f.a, req, "DEFER", 200)
	if v := f.request(t, f.otherDevice, req); v.data.State != "OCCUPIED" || v.data.Outgoing.State != "PENDING" {
		t.Fatal("active gesture lost lease")
	}
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_edit_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	v := f.request(t, f.otherDevice, req)
	if v.data.State != "SYNC_REQUIRED" {
		t.Fatal("deferral outlived disconnected holder")
	}
	f.ready(t, f.otherDevice, v.data.LeaseID)
	f.write(t, f.otherDevice, "confirmed", 200)
	f.write(t, f.a, "late", 409)
}
