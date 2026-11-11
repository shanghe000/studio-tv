package core

import (
	"encoding/json"
	"github.com/google/uuid"
	"sync"
	"testing"
	"time"
)

func TestPostgresOpeningAccountPageRenewsWithoutGrantingWrites(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	p := f.a
	p.lease = f.acquire(t, p).data.LeaseID
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_account_pages SET expires_at=clock_timestamp()+interval '2 seconds' WHERE project_id=$1 AND lease_id=$2`, nodeLeaseProject, p.lease); e != nil {
		t.Fatal(e)
	}
	r := f.call(t, p, "POST", writerPath, map[string]any{"leaseId": p.lease}, 200)
	if r.data.State != "SYNC_REQUIRED" || r.data.LeaseID != p.lease {
		t.Fatal("renewal granted an unconfirmed writer", r.raw)
	}
	var remaining float64
	if e := f.db.QueryRow(f.ctx, `SELECT extract(epoch from expires_at-clock_timestamp()) FROM collaboration.canvas_account_pages WHERE project_id=$1 AND lease_id=$2`, nodeLeaseProject, p.lease).Scan(&remaining); e != nil || remaining < 25 || remaining > 30 {
		t.Fatal("opening page did not receive bounded renewal", remaining, e)
	}
	f.writeWithLease(t, p, "not ready", 409)
	f.ready(t, p, p.lease)
	f.writeWithLease(t, p, "confirmed", 200)
}

func TestPostgresOpeningPageCannotExtendAnApprovedAccountHandoff(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	_ = accountReady(t, f, f.otherDevice) // keep a ready sibling draining
	opening := f.a
	opening.page, opening.proof = "slow-opening-page", uuid.NewString()
	opening.lease = f.acquire(t, opening).data.LeaseID
	req := uuid.NewString()
	f.request(t, f.b, req)
	f.decide(t, a, req, "APPROVE", 200)
	var before, after time.Time
	const expiry = `SELECT expires_at FROM collaboration.canvas_account_pages WHERE project_id=$1 AND lease_id=$2`
	if e := f.db.QueryRow(f.ctx, expiry, nodeLeaseProject, opening.lease).Scan(&before); e != nil {
		t.Fatal(e)
	}
	f.call(t, opening, "POST", writerPath, map[string]any{"leaseId": opening.lease}, 200)
	if e := f.db.QueryRow(f.ctx, expiry, nodeLeaseProject, opening.lease).Scan(&after); e != nil || !after.Equal(before) {
		t.Fatal("unconfirmed heartbeat prolonged approved handoff", before, after, e)
	}
	f.call(t, opening, "POST", writerPath+"/ready", map[string]any{"revision": 1, "leaseId": opening.lease}, 409)
	f.writeWithLease(t, opening, "opening during handoff", 409)
}

func accountReady(t *testing.T, f *handoffFixture, b handoffBrowser) handoffBrowser {
	t.Helper()
	r := f.acquire(t, b)
	if r.data.Protocol != "account-pages-v1" || r.data.State != "SYNC_REQUIRED" {
		t.Fatal("unconfirmed page", r.raw)
	}
	b.lease = r.data.LeaseID
	f.ready(t, b, b.lease)
	return b
}
func TestPostgresAccountPagesSimultaneousEditsReconnectAndRelease(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	if st := f.status(t, f.otherDevice); !st.data.CanJoin || st.data.State != "FREE" || len(st.data.Incoming) != 0 {
		t.Fatal("same actor could not join without a request", st.raw)
	}
	second := accountReady(t, f, f.otherDevice)
	tab := f.a
	tab.page = "sibling-tab"
	tab.proof = uuid.NewString()
	tab = accountReady(t, f, tab)
	if a.lease == second.lease || a.lease == tab.lease || len(f.status(t, a).data.Incoming) > 0 {
		t.Fatal("shared or competing page terms")
	}
	batch := func(p handoffBrowser, node, text, batch string) map[string]any {
		return map[string]any{"schemaVersion": "1", "clientId": p.page, "batchId": batch, "operations": []canvasOperation{operationPatch(node, text)}}
	}
	first := batch(a, "n1", "first screen", uuid.NewString())
	last := batch(second, "n2", "second screen", uuid.NewString())
	var wg sync.WaitGroup
	wg.Add(2)
	start := make(chan struct{})
	go func() { defer wg.Done(); <-start; f.call(t, a, "POST", "canvas-operations", first, 200) }()
	go func() { defer wg.Done(); <-start; f.call(t, second, "POST", "canvas-operations", last, 200) }()
	close(start)
	wg.Wait()
	var raw []byte
	if err := f.db.QueryRow(f.ctx, `SELECT graph FROM projects WHERE id=$1`, nodeLeaseProject).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var graph struct {
		Nodes []struct {
			ID   string
			Data map[string]any
		}
	}
	if err := json.Unmarshal(raw, &graph); err != nil {
		t.Fatal(err)
	}
	for _, n := range graph.Nodes {
		if n.ID == "n1" && n.Data["text"] != "first screen" || n.ID == "n2" && n.Data["text"] != "second screen" {
			t.Fatal("disjoint changes lost", n)
		}
	}
	f.call(t, a, "POST", "canvas-operations", first, 200)
	spoof := tab
	spoof.lease = a.lease
	f.writeWithLease(t, spoof, "wrong page", 409)
	impostor := a
	impostor.proof = uuid.NewString()
	f.writeWithLease(t, impostor, "wrong proof", 409)
	f.call(t, impostor, "POST", writerPath, map[string]any{"requireSync": true}, 409)
	f.call(t, a, "DELETE", writerPath, map[string]any{"leaseId": a.lease}, 200)
	f.writeWithLease(t, a, "after close", 409)
	if f.status(t, second).data.State != "HELD" {
		t.Fatal("closing sibling stopped writer")
	}
	reload := f.a
	reload.page = "reload"
	reload.proof = uuid.NewString()
	reload = accountReady(t, f, reload)
	f.call(t, a, "DELETE", writerPath, map[string]any{"leaseId": a.lease}, 200)
	f.writeWithLease(t, reload, "fresh", 200)
	f.writeWithLease(t, second, "elsewhere", 200)
	f.call(t, f.b, "POST", writerPath, map[string]any{"requireSync": true}, 409)
}
func TestPostgresAccountHandoffDrainsEveryActivePageAndFencesDelayedWrites(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	sibling := accountReady(t, f, f.otherDevice)
	b := f.b
	req := uuid.NewString()
	f.request(t, b, req)
	if len(f.status(t, sibling).data.Incoming) != 1 {
		t.Fatal("sibling cannot see request")
	}
	st := f.decide(t, a, req, "APPROVE", 200)
	if !st.data.AccountHandoff || st.data.State != "OCCUPIED" {
		t.Fatal("drained page should wait", st.raw)
	}
	if ready := f.status(t, sibling); ready.data.State != "HELD" || !ready.data.AccountHandoff || !ready.data.Incoming[0].DrainRequired {
		t.Fatal("sibling was not asked to flush", ready.raw)
	}
	if st := f.request(t, b, req); st.data.State != "OCCUPIED" || st.data.AccountHandoff || st.data.Outgoing == nil || st.data.Outgoing.State != "PENDING" {
		t.Fatal("foreign page entered before drain")
	}
	f.writeWithLease(t, a, "late", 409)
	f.writeWithLease(t, sibling, "last authorised save", 200)
	newA := f.a
	newA.page = "new-alice"
	newA.proof = uuid.NewString()
	f.call(t, newA, "POST", writerPath, map[string]any{"requireSync": true}, 409)
	f.decide(t, sibling, req, "APPROVE", 200)
	f.writeWithLease(t, sibling, "too late", 409)
	st = f.status(t, b)
	if st.data.State != "SYNC_REQUIRED" {
		t.Fatal("target was not directed", st.raw)
	}
	b.lease = st.data.LeaseID
	f.ready(t, b, b.lease)
	f.writeWithLease(t, b, "next editor", 200)
	f.call(t, a, "DELETE", writerPath, map[string]any{"leaseId": a.lease}, 200)
	if f.status(t, b).data.State != "HELD" {
		t.Fatal("stale release affected recipient")
	}
}
func TestPostgresAccountCanceledHandoffAndCrashedSiblingDoNotParkEveryone(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	sibling := accountReady(t, f, f.otherDevice)
	req := uuid.NewString()
	f.request(t, f.b, req)
	f.decide(t, a, req, "APPROVE", 200)
	f.call(t, f.b, "DELETE", writerPath+"/requests/"+req, nil, 200)
	if f.status(t, sibling).data.AccountHandoff {
		t.Fatal("canceled request left drain active")
	}
	a = accountReady(t, f, a)
	req = uuid.NewString()
	f.request(t, f.b, req)
	f.decide(t, a, req, "APPROVE", 200)
	if _, err := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_account_pages SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1 AND lease_id=$2`, nodeLeaseProject, sibling.lease); err != nil {
		t.Fatal(err)
	}
	v := f.request(t, f.b, req)
	if v.data.State != "SYNC_REQUIRED" {
		t.Fatal("expired page parked request", v.raw)
	}
	f.writeWithLease(t, sibling, "zombie", 409)
}
func TestPostgresAccountMigratesActiveFencedPageWithoutLosingItsTerm(t *testing.T) {
	f := handoffQA(t)
	a := f.a
	v := f.acquire(t, a)
	a.lease = v.data.LeaseID
	f.ready(t, a, a.lease)
	f.accountMode = true
	sibling := accountReady(t, f, f.otherDevice)
	if a.lease == sibling.lease {
		t.Fatal("migration gave out incumbent proof")
	}
	f.accountMode = false
	f.writeWithLease(t, a, "pre-upgrade tab", 200)
	unknown := f.a
	unknown.page = "legacy-unopened"
	f.call(t, unknown, "POST", writerPath, nil, 403)
	f.accountMode = true
	f.writeWithLease(t, sibling, "new tab", 200)
}

func TestPostgresAccountRevokedApplicantCannotLeaveDrainedPagesStuck(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	sibling := accountReady(t, f, f.otherDevice)
	req := uuid.NewString()
	f.request(t, f.b, req)
	f.decide(t, a, req, "APPROVE", 200)
	if _, e := f.db.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id=$1 AND user_id='usr_b'`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_account_pages SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1 AND lease_id=$2`, nodeLeaseProject, sibling.lease); e != nil {
		t.Fatal(e)
	}
	st := f.status(t, a)
	if st.data.AccountHandoff || !st.data.CanJoin || st.data.State != "FREE" {
		t.Fatal("failed applicant left everyone waiting", st.raw)
	}
	a = accountReady(t, f, a)
	f.writeWithLease(t, a, "still usable", 200)
	f.call(t, f.b, "POST", writerPath, map[string]any{"requireSync": true}, 404)
}

func TestPostgresAccountCanUpgradeAfterOldHolderWasRemoved(t *testing.T) {
	f := handoffQA(t)
	legacy := f.acquire(t, f.b)
	f.ready(t, f.b, legacy.data.LeaseID)
	if _, e := f.db.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id=$1 AND user_id='usr_b'`, nodeLeaseProject); e != nil {
		t.Fatal(e)
	}
	f.accountMode = true
	a := accountReady(t, f, f.a)
	f.writeWithLease(t, a, "owner regained canvas", 200)
}
