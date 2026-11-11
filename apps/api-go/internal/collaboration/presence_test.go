package collaboration

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/testdb"
)

func TestChangedNodeLeaseScopeIncludesDataLayoutAndConnectionMetadata(t *testing.T) {
	base := `{"schemaVersion":"1","nodes":[{"id":"n1","type":"rh-image","position":{"x":0,"y":0},"data":{"text":"private-content"}},{"id":"n2","type":"rh-video","data":{}},{"id":"rhtv_meta_v1","type":"__rhtv_meta","data":{"edges":{"e1":{"conditioningRole":"FIRST_FRAME"}}}}],"edges":[{"id":"e1","source":"n1","target":"n2"}]}`
	for _, row := range []struct {
		name, after string
		want        []string
	}{
		{"data", strings.Replace(base, "private-content", "new-private-content", 1), []string{"n1"}},
		{"layout", strings.Replace(base, `"x":0`, `"x":30`, 1), []string{"n1"}},
		{"connection metadata", strings.Replace(base, "FIRST_FRAME", "LAST_FRAME", 1), []string{"n1", "n2"}},
		{"connection remove", strings.Replace(base, `[{"id":"e1","source":"n1","target":"n2"}]`, `[]`, 1), []string{"n1", "n2"}},
		{"unchanged", base, []string{}},
	} {
		t.Run(row.name, func(t *testing.T) {
			got, err := ChangedNodeIDs(json.RawMessage(base), json.RawMessage(row.after))
			if err != nil || !reflect.DeepEqual(got, row.want) {
				t.Fatal(got, row.want, err)
			}
			if strings.Contains(strings.Join(got, ","), "private") {
				t.Fatal("content entered scope")
			}
		})
	}
	if got, err := ChangedNodeIDs(json.RawMessage(`{"nodes":[{"id":"n1","data":{"n":9007199254740992}}]}`), json.RawMessage(`{"nodes":[{"id":"n1","data":{"n":9007199254740993}}]}`)); err != nil || !reflect.DeepEqual(got, []string{"n1"}) {
		t.Fatal("large numeric edits escaped ownership scope", got, err)
	}
	if _, err := ChangedNodeIDs(json.RawMessage(`{"nodes":[{"id":"a"},{"id":"a"}]}`), json.RawMessage(base)); err == nil {
		t.Fatal("duplicate identities accepted")
	}
}

type presenceFixture struct {
	db                    *pgxpool.Pool
	ctx                   context.Context
	s                     *PresenceService
	owner, editor, viewer httpapi.Identity
}

func newPresenceFixture(t *testing.T) *presenceFixture {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	_, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('pa','a@example.test','甲'),('pb','b@example.test','乙'),('pc','c@example.test','查看者');
 INSERT INTO public.projects(id,owner_id,name,graph) VALUES('presence_project','pa','Presence','{"schemaVersion":"1","nodes":[{"id":"n1","type":"rh-image","position":{"x":0,"y":0},"data":{}},{"id":"n2","type":"rh-video","position":{"x":0,"y":0},"data":{}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}'),('presence_private','pa','Private','{"schemaVersion":"1","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}');
 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('presence_project','pb','EDITOR','pa'),('presence_project','pc','VIEWER','pa');`)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewPresenceService(db)
	if err != nil {
		t.Fatal(err)
	}
	id := func(user string) httpapi.Identity {
		return httpapi.Identity{UserID: user, SessionID: "private-session-" + user, IPACIssuer: "fixture", IPACSubjectID: user, IPACSessionID: "ipac-" + user, IPACSessionVersion: 1, AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	}
	return &presenceFixture{db: db, ctx: ctx, s: s, owner: id("pa"), editor: id("pb"), viewer: id("pc")}
}
func (f *presenceFixture) join(t *testing.T, id httpapi.Identity, client string) {
	t.Helper()
	if _, err := f.s.Heartbeat(f.ctx, id, "presence_project", client, &CanvasCursor{12, 34}, []string{"n1"}); err != nil {
		t.Fatal(err)
	}
}
func presenceStatus(t *testing.T, err error, status int) {
	t.Helper()
	var e *httpapi.Error
	if !errors.As(err, &e) || e.Status != status {
		t.Fatalf("want %d got %v", status, err)
	}
}
func (f *presenceFixture) check(id httpapi.Identity, client string, nodes []string) error {
	_, err := database.Transaction(f.ctx, f.db, func(tx pgx.Tx) (bool, error) {
		if _, err := RequireProject(f.ctx, tx, id.UserID, "presence_project", EDITOR, true); err != nil {
			return false, err
		}
		err := CheckNodeLeases(f.ctx, tx, "presence_project", id, client, nodes)
		return err == nil, err
	})
	return err
}

func TestPostgresCanvasPresenceAndAtomicExclusiveNodeLeases(t *testing.T) {
	f := newPresenceFixture(t)
	f.join(t, f.owner, "page-a")
	f.join(t, f.editor, "page-b")
	start := make(chan struct{})
	results := make(chan struct {
		id     httpapi.Identity
		client string
		err    error
	}, 2)
	var wg sync.WaitGroup
	for _, row := range []struct {
		id     httpapi.Identity
		client string
	}{{f.owner, "page-a"}, {f.editor, "page-b"}} {
		row := row
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := f.s.Acquire(f.ctx, row.id, "presence_project", row.client, []string{"n1"})
			results <- struct {
				id     httpapi.Identity
				client string
				err    error
			}{row.id, row.client, err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	var winner httpapi.Identity
	client := ""
	for result := range results {
		if result.err == nil {
			winners++
			winner = result.id
			client = result.client
		} else {
			presenceStatus(t, result.err, 409)
		}
	}
	if winners != 1 {
		t.Fatal("ownership was not exclusive", winners)
	}
	if err := f.check(winner, client, []string{"n1"}); err != nil {
		t.Fatal("owner rejected", err)
	}
	presenceStatus(t, f.check(winner, "", []string{"n1"}), 409)
	other := f.editor
	otherClient := "page-b"
	if winner.UserID == f.editor.UserID {
		other = f.owner
		otherClient = "page-a"
	}
	presenceStatus(t, f.check(other, otherClient, []string{"n1"}), 409)
	presenceStatus(t, f.check(winner, "other-page", []string{"n1"}), 409)
	if err := f.check(other, otherClient, []string{"n2"}); err != nil {
		t.Fatal("unrelated node blocked", err)
	}
	_, err := f.s.Acquire(f.ctx, other, "presence_project", otherClient, []string{"n1", "n2"})
	presenceStatus(t, err, 409)
	var n int
	if err = f.db.QueryRow(f.ctx, `SELECT count(*) FROM collaboration.canvas_node_leases WHERE project_id='presence_project' AND node_id='n2'`).Scan(&n); err != nil || n != 0 {
		t.Fatal("failed batch partly claimed", n, err)
	}
	snapshot, err := f.s.Snapshot(f.ctx, f.owner, "presence_project")
	if err != nil || len(snapshot.Members) != 2 || len(snapshot.Leases) != 1 || snapshot.Leases[0].ClientID != client {
		t.Fatal(snapshot, err)
	}
	raw, _ := json.Marshal(snapshot)
	if strings.Contains(string(raw), "private-session") || strings.Contains(string(raw), "@example.test") {
		t.Fatal("private identity leaked")
	}
}

func TestPostgresCanvasLeaseExpiryReleaseAndRevocation(t *testing.T) {
	f := newPresenceFixture(t)
	f.join(t, f.owner, "page-a")
	f.join(t, f.editor, "page-b")
	f.join(t, f.viewer, "page-c")
	if _, err := f.s.Acquire(f.ctx, f.editor, "presence_project", "page-b", []string{"n1"}); err != nil {
		t.Fatal(err)
	}
	// Another account cannot release the holder, even with its visible client id.
	if _, err := f.s.Release(f.ctx, f.owner, "presence_project", "page-b", []string{"n1"}, false); err != nil {
		t.Fatal(err)
	}
	presenceStatus(t, f.check(f.owner, "page-a", []string{"n1"}), 409)
	_, err := f.s.Acquire(f.ctx, f.viewer, "presence_project", "page-c", []string{"n2"})
	presenceStatus(t, err, 403)
	_, err = f.s.Snapshot(f.ctx, f.editor, "presence_private")
	presenceStatus(t, err, 404)
	if _, err = f.db.Exec(f.ctx, `UPDATE collaboration.canvas_node_leases SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Acquire(f.ctx, f.owner, "presence_project", "page-a", []string{"n1"}); err != nil {
		t.Fatal("expired lease did not release", err)
	}
	if _, err = f.s.Release(f.ctx, f.owner, "presence_project", "page-a", nil, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Acquire(f.ctx, f.editor, "presence_project", "page-b", []string{"n1"}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id='presence_project' AND user_id='pb'`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.s.Snapshot(f.ctx, f.owner, "presence_project")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range snapshot.Members {
		if m.UserID == "pb" {
			t.Fatal("revoked participant stayed visible")
		}
	}
	if len(snapshot.Leases) != 0 {
		t.Fatal("revoked holder stayed active")
	}
	f.join(t, f.owner, "page-new")
	if _, err = f.s.Acquire(f.ctx, f.owner, "presence_project", "page-new", []string{"n1"}); err != nil {
		t.Fatal("revoked holder blocked replacement", err)
	}
	f.s.mu.Lock()
	p := f.s.projects["presence_project"]
	m := p.members["page-c"]
	m.LastSeenAt = time.Now().Add(-PresenceTTL - time.Second)
	p.members["page-c"] = m
	f.s.mu.Unlock()
	snapshot, err = f.s.Snapshot(f.ctx, f.owner, "presence_project")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range snapshot.Members {
		if m.ClientID == "page-c" {
			t.Fatal("disconnected participant stayed visible")
		}
	}
}

func TestPostgresCanvasPresenceHTTPBoundariesAndHeartbeatRenewal(t *testing.T) {
	f := newPresenceFixture(t)
	router := chi.NewRouter()
	protect := func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			if r.Header.Get("Authorization") != "fixture" {
				return httpapi.Fail(401, "UNAUTHENTICATED", "login required")
			}
			return h(w, httpapi.WithIdentity(r, f.owner))
		})
	}
	if err := RegisterPresenceRoutes(router, f.s, protect); err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string, want int) {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "fixture")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s got%d want%d %s", path, w.Code, want, w.Body.String())
		}
	}
	missingType := httptest.NewRequest("POST", "/api/v2/projects/presence_project/presence", strings.NewReader(`{"clientId":"page-a","cursor":null,"selectedNodeIds":[]}`))
	missingType.Header.Set("Authorization", "fixture")
	missingTypeResponse := httptest.NewRecorder()
	router.ServeHTTP(missingTypeResponse, missingType)
	if missingTypeResponse.Code != 415 {
		t.Fatalf("missing content type returned %d, want415", missingTypeResponse.Code)
	}
	call("POST", "/api/v2/projects/presence_project/presence", `{"clientId":"page-a","cursor":{"x":1,"y":2},"selectedNodeIds":["n1"],"userId":"pb"}`, 400)
	call("POST", "/api/v2/projects/presence_project/presence", `{"clientId":"page-a","cursor":{"x":10000001,"y":2},"selectedNodeIds":[]}`, 422)
	call("POST", "/api/v2/projects/presence_project/presence", `{"clientId":"page-a","cursor":{"x":1},"selectedNodeIds":[]}`, 400)
	call("GET", "/api/v2/projects/presence_project/presence?clientId=%zz", "", 422)
	call("POST", "/api/v2/projects/presence_project/presence", `{"clientId":"page-a","cursor":null,"selectedNodeIds":["n1","n1"]}`, 422)
	call("GET", "/api/v2/projects/presence_project/presence?token=private", "", 422)
	call("POST", "/api/v2/projects/presence_project/presence", `{"clientId":"page-a","cursor":{"x":1,"y":2},"selectedNodeIds":[]}`, 200)
	call("POST", "/api/v2/projects/presence_project/presence", `{"clientId":"page-a","cursor":null,"selectedNodeIds":[]}`, 429)
	call("POST", "/api/v2/projects/presence_project/node-leases", `{"clientId":"page-a","nodeIds":["n1"]}`, 200)
	if _, err := f.db.Exec(f.ctx, `UPDATE collaboration.canvas_node_leases SET expires_at=clock_timestamp()+interval '2 seconds'`); err != nil {
		t.Fatal(err)
	}
	f.s.mu.Lock()
	m := f.s.projects["presence_project"].members["page-a"]
	m.lastUpdate = time.Now().Add(-time.Second)
	f.s.projects["presence_project"].members["page-a"] = m
	f.s.mu.Unlock()
	call("POST", "/api/v2/projects/presence_project/presence", `{"clientId":"page-a","cursor":null,"selectedNodeIds":[]}`, 200)
	var ttl float64
	if err := f.db.QueryRow(f.ctx, `SELECT extract(epoch FROM expires_at-clock_timestamp()) FROM collaboration.canvas_node_leases WHERE node_id='n1'`).Scan(&ttl); err != nil || ttl < 13 {
		t.Fatal("heartbeat did not renew", ttl, err)
	}
	call("DELETE", "/api/v2/projects/presence_project/presence/page-a", "", 200)
	if err := f.check(f.owner, "", []string{"n1"}); err != nil {
		t.Fatal("leave did not release", err)
	}
}

func TestPostgresCanvasPresenceSSERevalidatesAndBoundsConnections(t *testing.T) {
	f := newPresenceFixture(t)
	f.join(t, f.owner, "page-a")
	f.s.streamLifetime = 2 * time.Second
	f.s.streamReauthorize = time.Millisecond
	var denied atomic.Bool
	router := chi.NewRouter()
	protect := func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			r = httpapi.WithIdentity(r, f.owner)
			r = httpapi.WithLiveAuthorization(r, httpapi.LiveAuthorization{Revalidate: func(context.Context) (httpapi.Identity, error) {
				if denied.Load() {
					return httpapi.Identity{}, httpapi.Fail(403, "FORBIDDEN", "access removed")
				}
				return f.owner, nil
			}})
			return h(w, r)
		})
	}
	if err := RegisterPresenceRoutes(router, f.s, protect); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(router)
	defer server.Close()
	// The JSON snapshot path stays a normal API request; only /events is a
	// long-lived route, matching the existing latency/slow-request exclusions.
	request, _ := http.NewRequest("GET", server.URL+"/api/v2/projects/presence_project/presence", nil)
	request.Header.Set("Accept", "text/event-stream")
	deniedRoute, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	deniedRoute.Body.Close()
	if deniedRoute.StatusCode != 406 {
		t.Fatal("old snapshot route opened a stream", deniedRoute.StatusCode)
	}
	request, _ = http.NewRequest("GET", server.URL+"/api/v2/projects/presence_project/presence/events?clientId=page-a", nil)
	request.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	seen := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			if !strings.Contains(line, `"members"`) || strings.Contains(line, "private-session") {
				t.Fatal("invalid first snapshot", line)
			}
			seen = true
			break
		}
	}
	if !seen {
		t.Fatal("no realtime snapshot", scanner.Err())
	}
	denied.Store(true)
	f.s.bump("presence_project")
	control := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: presence.snapshot") {
			t.Fatal("snapshot emitted after failed revalidation")
		}
		if line == "event: stream.error" {
			control = true
		}
	}
	if !control {
		t.Fatal("no authorization control error", scanner.Err())
	}
	// Capacity is independent of the existing graph content stream budget.
	closers := []func(){}
	for i := 0; i < 2; i++ {
		_, close, err := f.s.subscribeStream("presence_project", "pa")
		if err != nil {
			t.Fatal(err)
		}
		closers = append(closers, close)
	}
	if _, _, err := f.s.subscribeStream("presence_project", "pa"); err == nil {
		t.Fatal("unbounded account streams")
	}
	for _, close := range closers {
		close()
	}
}

func TestPostgresCanvasPresenceSupportsLongNativeNodeIDs(t *testing.T) {
	f := newPresenceFixture(t)
	node := "entity_" + strings.Repeat("a", 170)
	raw, _ := json.Marshal(map[string]any{"id": node, "type": "rh-text", "position": map[string]any{"x": 0, "y": 0}, "data": map[string]any{}})
	if _, err := f.db.Exec(f.ctx, `UPDATE public.projects SET graph=jsonb_set(graph,'{nodes}',(graph->'nodes')||jsonb_build_array($1::jsonb)) WHERE id='presence_project'`, string(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Heartbeat(f.ctx, f.owner, "presence_project", "page-long", nil, []string{node}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.s.Acquire(f.ctx, f.owner, "presence_project", "page-long", []string{node})
	if err != nil || len(snapshot.Leases) != 1 || snapshot.Leases[0].NodeID != node {
		t.Fatal(snapshot, err)
	}
	if _, err = f.s.Heartbeat(f.ctx, f.editor, "presence_project", "page-b", nil, []string{strings.Repeat("a", 201)}); err == nil {
		t.Fatal("unbounded node id accepted")
	}
}
