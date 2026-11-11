package core

import (
	"bytes"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"strings"
	"testing"
)

func legacySnapshot(t *testing.T, f *handoffFixture, p handoffBrowser, revision int64, graph map[string]any, want int) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("PUT", "/api/v1/projects/"+nodeLeaseProject+"/snapshot", bytes.NewReader(encode(map[string]any{"graph": graph})))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+p.token)
	r.Header.Set("If-Match", etag(int(revision)))
	if p.page != "" {
		r.Header.Set(collaboration.CanvasSessionHeader, p.page)
	}
	if p.proof != "" {
		r.Header.Set(collaboration.CanvasProofHeader, p.proof)
	}
	if p.lease != "" {
		r.Header.Set(collaboration.CanvasLeaseHeader, p.lease)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != want {
		t.Fatalf("PUT v1 got %d, wanted %d: %s", w.Code, want, w.Body.String())
	}
	return w
}
func expireSnapshotPage(t *testing.T, f *handoffFixture, p handoffBrowser) {
	t.Helper()
	if _, e := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_account_pages SET expires_at=now()-interval '1 second' WHERE project_id=$1 AND lease_id=$2`, nodeLeaseProject, p.lease); e != nil {
		t.Fatal(e)
	}
}
func TestPostgresV1SnapshotRecoversOnlyOnceFromAPreviouslyConfirmedBase(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	rev := f.state(t).Revision
	legacySnapshot(t, f, a, rev, f.edit(t, "n1", "first active snapshot"), 200)
	rev++
	expireSnapshotPage(t, f, a)
	f.writeWithLease(t, a, "ordinary mutation cannot reuse expired term", 409)
	wrong := a
	wrong.proof = uuid.NewString()
	late := f.edit(t, "n1", "preserve last pending edit")
	legacySnapshot(t, f, wrong, rev, late, 409)
	legacySnapshot(t, f, f.otherDevice, rev, late, 409)
	legacySnapshot(t, f, a, rev, late, 200)
	rev++
	if got := f.state(t); got.Revision != rev {
		t.Fatal("final edit not committed", got)
	}
	// A second write on the same expired page never accepts another mutation.
	legacySnapshot(t, f, a, rev, f.edit(t, "n2", "second stale write"), 409)
	readOnly := handoffBrowser{token: a.token}
	canonical := f.state(t)
	legacySnapshot(t, f, readOnly, rev, graphFrom(t, canonical.Graph), 200)
	if f.state(t) != canonical {
		t.Fatal("no-op acknowledgement performed a write")
	}
	f.accountMode = false
	fake := a
	fake.proof = uuid.NewString()
	f.call(t, fake, "POST", writerPath, map[string]any{"requireSync": true}, 403)
	restored := f.acquire(t, a)
	if restored.data.State != "SYNC_REQUIRED" || restored.data.LeaseID == a.lease {
		t.Fatal("legacy writer did not get fenced re-admission")
	}
	f.writeWithLease(t, a, "stale after rejoin", 409)
	a.lease = restored.data.LeaseID
	f.writeWithLease(t, a, "before confirming snapshot", 409)
	f.ready(t, a, a.lease)
	f.writeWithLease(t, a, "reconnected", 200)
}
func TestPostgresV1SnapshotCannotOverrideSiblingOrForeignHandoff(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	original := f.state(t)
	stale := f.edit(t, "n1", "old page")
	sibling := accountReady(t, f, f.otherDevice)
	expireSnapshotPage(t, f, a)
	legacySnapshot(t, f, a, original.Revision, stale, 409)
	f.writeWithLease(t, sibling, "new screen", 200)
	legacySnapshot(t, f, a, original.Revision, stale, 412)
	f.call(t, sibling, "DELETE", writerPath, map[string]any{"leaseId": sibling.lease}, 200)
	// Even a guessed new ETag cannot replace another page's committed edit.
	rev := f.state(t).Revision
	legacySnapshot(t, f, a, rev, stale, 409)
	a = accountReady(t, f, a)
	r := uuid.NewString()
	f.request(t, f.b, r)
	expireSnapshotPage(t, f, a)
	legacySnapshot(t, f, a, rev, stale, 409)
	f.accountMode = false
	f.call(t, a, "POST", writerPath, map[string]any{"requireSync": true}, 403)
	f.accountMode = true
	st := f.request(t, f.b, r)
	b := f.b
	b.lease = st.data.LeaseID
	f.ready(t, b, b.lease)
	legacySnapshot(t, f, a, rev, stale, 409)
}

func TestPostgresActiveV1PageCannotReplaceChangesFromASiblingWithALaterETag(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	stale := f.edit(t, "n1", "changed locally")
	sibling := accountReady(t, f, f.otherDevice)
	f.writeWithLease(t, sibling, "committed by sibling", 200)
	current := f.state(t)
	legacySnapshot(t, f, a, current.Revision, stale, 409)
	if f.state(t) != current {
		t.Fatal("an active legacy writer replaced another page's change")
	}
	// A matching full graph proves exactly which graph is installed on the
	// active page and records a new base. It does not increment the revision.
	legacySnapshot(t, f, a, current.Revision, graphFrom(t, current.Graph), 200)
	if f.state(t) != current {
		t.Fatal("read acknowledgement changed canonical graph")
	}
	legacySnapshot(t, f, a, current.Revision, f.edit(t, "n2", "independent edit"), 200)
}
func TestPostgresV1SnapshotRefusesUnknownBaseLongExpiryAndRevokedLogin(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	a := accountReady(t, f, f.a)
	state := f.state(t)
	candidate := graphFrom(t, state.Graph)
	candidate["viewport"].(map[string]any)["zoom"] = 1.5
	expireSnapshotPage(t, f, a)
	unauthenticated := a
	unauthenticated.proof = ""
	unauthenticated.lease = ""
	w := legacySnapshot(t, f, unauthenticated, state.Revision, candidate, 409)
	var out struct{ Code string }
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil || out.Code != "CANVAS_PAGE_UPDATE_REQUIRED" {
		t.Fatalf("legacy client did not receive actionable status: %s", w.Body.String())
	}
	for _, update := range []string{
		`UPDATE collaboration.canvas_account_pages SET snapshot_base=NULL WHERE lease_id=$1`,
		`UPDATE collaboration.canvas_account_pages SET snapshot_base=1,expires_at=now()-interval '2 minutes' WHERE lease_id=$1`,
		`UPDATE collaboration.canvas_account_pages SET expires_at=now()-interval '2 seconds' WHERE lease_id=$1`,
	} {
		if _, e := f.db.Exec(f.ctx, update, a.lease); e != nil {
			t.Fatal(e)
		}
		if strings.Contains(update, "2 seconds") {
			if _, e := f.db.Exec(f.ctx, `UPDATE public.sessions SET revoked_at=now() WHERE id=$1`, f.owner.SessionID); e != nil {
				t.Fatal(e)
			}
		}
		legacySnapshot(t, f, a, state.Revision, candidate, 409)
	}
	if f.state(t) != state {
		t.Fatal("unverified viewport or revoked session changed canvas")
	}
}

func TestPostgresOldPresencePageIsToldToUpgradeWithoutTakingANodeLease(t *testing.T) {
	f := handoffQA(t)
	f.accountMode = true
	_ = accountReady(t, f, f.a)
	old := f.a
	old.page = "old-presence-uuid"
	old.proof = ""
	router := chi.NewRouter()
	router.Use(collaboration.CanvasProofMiddleware)
	if e := collaboration.RegisterPresenceRoutes(router, f.presence, func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			if r.Header.Get("Authorization") != "Bearer "+old.token {
				return httpapi.Fail(401, "UNAUTHENTICATED", "login required")
			}
			return h(w, httpapi.WithIdentity(r, f.owner))
		})
	}); e != nil {
		t.Fatal(e)
	}
	f.handler = router
	f.accountMode = false
	f.call(t, old, "POST", "presence", nil, 200)
	denied := f.call(t, old, "POST", "node-leases", map[string]any{"nodeIds": []string{"n1"}}, 409)
	if denied.code != "CANVAS_PAGE_UPDATE_REQUIRED" {
		t.Fatal("wrong old-client error", denied.raw)
	}
	var count int
	if e := f.db.QueryRow(f.ctx, `SELECT count(*) FROM collaboration.canvas_node_leases WHERE project_id=$1`, nodeLeaseProject).Scan(&count); e != nil || count != 0 {
		t.Fatal("legacy client obtained an editing lease", e, count)
	}
}
