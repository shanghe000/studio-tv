package core

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	canvasPG "studiotv.local/service/api/internal/modules/canvasagent/adapters/postgres"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
	"studiotv.local/service/api/internal/testdb"
)

func TestPostgresCoreProjectEventWritersAndDeletedAssetSource(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name)VALUES('usr_a','legacy-event-a@example.test','A'),('usr_b','legacy-event-b@example.test','B');
	 INSERT INTO public.projects(id,owner_id,name)VALUES('prj_target','usr_a','Target'),('prj_source','usr_a','Source');
	 INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state)VALUES('asset_source','usr_a','prj_source','source.png','IMAGE','image/png',4,'sha','READY');`); err != nil {
		t.Fatal(err)
	}
	runtime, sessions := &integrationRuntime{}, &integrationSessions{}
	authorizer := authorization.New(runtime, "cli_test", sessions)
	auth := httpapi.AuthFunc(func(context.Context, *http.Request) (httpapi.Identity, error) {
		return integrationPrincipal("usr_a"), nil
	})
	router, err := NewWithAuthorization(testConfig(t), db, auth, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body, revision string, status int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("If-Match", revision)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, request)
		if w.Code != status {
			t.Fatal(path, w.Code, w.Body.String())
		}
		return w
	}
	service, _ := application.NewLiveService(canvasPG.New(db))
	call("PATCH", "/api/v1/projects/prj_target", `{"name":"Rename"}`, "", 200)
	call("PUT", "/api/v1/projects/prj_target/pin", "", "", 200)
	metadata, err := service.Snapshot(ctx, "usr_a", "prj_target")
	if err != nil || metadata.GraphRevision != 1 || metadata.EventCursor != "0" {
		t.Fatal("legacy rename/pin unexpectedly changed graph CAS", metadata, err)
	}
	if _, err := db.Exec(ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='prj_source'`); err != nil {
		t.Fatal(err)
	}
	assetGraph := `{"graph":{"schemaVersion":"1","nodes":[{"id":"image","type":"image","position":{"x":0,"y":0},"data":{"url":"rhtv-asset:asset_source"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}}`
	call("PUT", "/api/v1/projects/prj_target/snapshot", assetGraph, `"1"`, 422)
	call("PATCH", "/api/v1/projects/prj_target", `{"coverAssetId":"asset_source"}`, "", 422)
	unmodified, err := service.Snapshot(ctx, "usr_a", "prj_target")
	if err != nil || unmodified.GraphRevision != 1 || unmodified.EventCursor != "0" {
		t.Fatal("denied source asset write changed target", unmodified, err)
	}
	graph := `{"graph":{"schemaVersion":"1","nodes":[{"id":"text","type":"text","position":{"x":0,"y":0},"data":{"text":"legacy persisted input"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}}`
	saved := call("PUT", "/api/v1/projects/prj_target/snapshot", graph, `"1"`, 200)
	if saved.Header().Get("ETag") != `"2"` {
		t.Fatal("legacy save lost existing strong CAS")
	}
	call("PUT", "/api/v1/projects/prj_target/snapshot", graph, `"1"`, 412)
	page, err := service.Events(ctx, "usr_a", "prj_target", 0, 100)
	if err != nil || len(page.Events) != 1 || page.NextCursor != "1" {
		t.Fatal("legacy write/rejection event transaction incorrect", page, err)
	}
	var event map[string]any
	_ = json.Unmarshal(page.Events[0], &event)
	if event["type"] != "canvas.invalidated" || event["data"].(map[string]any)["reason"] != "LEGACY_GRAPH_WRITE" {
		t.Fatal("legacy full graph was incorrectly published as delta")
	}
	call("DELETE", "/api/v1/projects/prj_target", "", "", 200)
	if _, err := service.Snapshot(ctx, "usr_a", "prj_target"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted graph remained public", err)
	}
	if _, err := service.Events(ctx, "usr_a", "prj_target", 0, 100); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted event content remained public", err)
	}
	var sequence int64
	var reason string
	if err := db.QueryRow(ctx, `SELECT p.event_sequence,e.payload->'data'->>'reason' FROM public.projects p JOIN canvas.project_events e ON e.project_id=p.id AND e.sequence=p.event_sequence WHERE p.id='prj_target'`).Scan(&sequence, &reason); err != nil || sequence != 2 || reason != "PROJECT_DELETED" {
		t.Fatal("legacy delete did not preserve durable evidence", sequence, reason, err)
	}
}
