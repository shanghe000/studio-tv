package http

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/canvasdelta"
	"studiotv.local/service/api/internal/httpapi"
	app "studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	"strings"
	"testing"
	"time"
)

const deltaOld = `{"schemaVersion":"1","nodes":[{"id":"n","type":"rh-text","position":{"x":1,"y":1},"data":{"text":"private-untouched"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`

var deltaNew = strings.Replace(deltaOld, `"x":1`, `"x":222`, 1)

type deltaRepo struct {
	head          string
	snapshotCalls int
	denied        bool
	multi         bool
}

func (r *deltaRepo) OwnedLiveSnapshot(_ context.Context, owner, project string) (domain.LiveSnapshot, error) {
	r.snapshotCalls++
	if r.denied || owner != "user-a" || project != "owned" {
		return domain.LiveSnapshot{}, domain.ErrNotFound
	}
	return domain.LiveSnapshot{SchemaVersion: "1", ProjectID: project, Graph: json.RawMessage(deltaNew), GraphRevision: 2, EventCursor: r.head, UpdatedAt: time.Unix(100, 0).UTC(), NodeExecutionAvailable: true, NodeStates: []domain.NodeExecutionState{}}, nil
}
func (r *deltaRepo) OwnedProjectEvents(_ context.Context, owner, project string, after int64, _ int) (domain.EventPage, error) {
	if after == 0 {
		if r.multi {
			return domain.EventPage{ProjectID: project, Events: []json.RawMessage{eventRaw(project, 1), eventRaw(project, 2)}, NextCursor: "2", EventCursor: "2"}, nil
		}
		return domain.EventPage{ProjectID: project, Events: []json.RawMessage{eventRaw(project, 1)}, NextCursor: "1", EventCursor: "1"}, nil
	}
	return emptyStreamPage(project, after), nil
}
func TestOptInStreamDeltasRequireExactHeadAndFreshAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name, header, head             string
		seed, multi, revoke, wantDelta bool
	}{
		{"exact", "delta-v1", "1", true, false, false, true}, {"newer-head", "delta-v1", "2", true, false, false, false}, {"multi", "delta-v1", "2", true, true, false, false}, {"missing", "delta-v1", "1", false, false, false, false}, {"legacy", "", "1", true, false, false, false}, {"revoked", "delta-v1", "1", true, false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &deltaRepo{head: tc.head, multi: tc.multi}
			cache := canvasdelta.New()
			if tc.seed {
				cache.Record("owned", 1, 2, []byte(deltaOld), []byte(deltaNew))
			}
			service, _ := app.NewLiveService(r, cache)
			s := newProjectStream(service)
			s.lifetime = 45 * time.Millisecond
			s.poll = time.Millisecond * 4
			id := streamIdentity()
			checks := 0
			req := streamRequest(id, func(context.Context) (httpapi.Identity, error) {
				checks++
				if tc.revoke {
					return id, httpapi.Fail(403, "FORBIDDEN", "denied")
				}
				return id, nil
			})
			req.Header.Set("X-STUDIO-Canvas-Update", tc.header)
			w := &streamWriter{ResponseRecorder: httptest.NewRecorder()}
			err := s.serve(w, req, id, "owned", 0, 5)
			waitStreamIdle(t, s)
			body := w.Body.String()
			if tc.revoke {
				if err == nil || body != "" || r.snapshotCalls != 1 {
					t.Fatal("unverified delta sent", body)
				}
				return
			}
			if err != nil || checks == 0 {
				t.Fatal(err, checks)
			}
			if got := strings.Contains(body, "id: 1\nevent: canvas.delta\n"); got != tc.wantDelta {
				t.Fatal(body)
			}
			if tc.wantDelta {
				if strings.Contains(body, "private-untouched") || !strings.Contains(body, `"x":222`) || !strings.Contains(body, `"eventCursor":"1"`) || strings.Count(body, "id: 1\n") != 1 {
					t.Fatal(body)
				}
			} else if !strings.Contains(body, "id: 1\nevent: canvas.invalidated\n") {
				t.Fatal(body)
			}
		})
	}
}
func TestLiveUpdateProtocolHTTPCompatibilityAndInputValidation(t *testing.T) {
	r := &deltaRepo{head: "1"}
	cache := canvasdelta.New()
	cache.Record("owned", 1, 2, []byte(deltaOld), []byte(deltaNew))
	service, _ := app.NewLiveService(r, cache)
	router := chi.NewRouter()
	protect := func(cap string, next httpapi.Handler) http.HandlerFunc {
		if cap != "tv.access" {
			t.Fatal("wrong capability")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: r.Header.Get("Actor")}))
		})
	}
	if e := RegisterLiveRoutes(router, service, protect); e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		path, user string
		code       int
		kind       string
	}{{"live-snapshot", "user-a", 200, ""}, {"live-snapshot?fromRevision=1", "user-a", 400, ""}, {"live-update?fromRevision=1", "user-a", 200, "DELTA"}, {"live-update?fromRevision=2", "user-a", 200, "SNAPSHOT"}, {"live-update?fromRevision=1", "unauthorized", 404, ""}, {"live-update?fromRevision=1", "", 401, ""}, {"live-update", "user-a", 400, ""}, {"live-update?fromRevision=0", "user-a", 400, ""}, {"live-update?fromRevision=01", "user-a", 400, ""}, {"live-update?fromRevision=1&fromRevision=2", "user-a", 400, ""}, {"live-update?fromRevision=1&owner=other", "user-a", 400, ""}} {
		q := httptest.NewRequest("GET", "/api/v2/projects/owned/"+tc.path, nil)
		q.Header.Set("Actor", tc.user)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, q)
		if w.Code != tc.code {
			t.Fatal(tc, w.Code, w.Body.String())
		}
		if tc.code != 200 {
			continue
		}
		var env struct{ Data map[string]json.RawMessage }
		if json.Unmarshal(w.Body.Bytes(), &env) != nil {
			t.Fatal("malformed response")
		}
		if w.Header().Get("X-STUDIO-Canvas-Update") != "delta-v1" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("missing negotiation")
		}
		if tc.kind == "" {
			if env.Data["kind"] != nil || env.Data["graph"] == nil {
				t.Fatal("legacy contract changed")
			}
		} else if string(env.Data["kind"]) != "\""+tc.kind+"\"" || ((env.Data["graph"] == nil) != (tc.kind == "DELTA")) {
			t.Fatal(tc, w.Body.String())
		}
	}
}
