package postgres_test

import (
	"bytes"
	"context"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/observability"
	"studiotv.local/service/api/internal/principal"
	"strings"
	"testing"
)

func TestGenerationLogAfterCommitAndAsyncFailure(t *testing.T) {
	f := newHistoryInputFixture(t)
	var logs bytes.Buffer
	sent := 0
	var notification string
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent++
		body, _ := io.ReadAll(r.Body)
		notification = string(body)
		w.Write([]byte(`{"code":0}`))
	}))
	defer endpoint.Close()
	o, e := observability.New(observability.Config{Output: &logs, WebhookURL: endpoint.URL})
	if e != nil {
		t.Fatal(e)
	}
	defer o.Close(context.Background())
	o.SetActorNameResolver(func(ctx context.Context, id string) (string, error) {
		var name string
		err := f.pool.QueryRow(ctx, "SELECT display_name FROM public.users WHERE id=$1", id).Scan(&name)
		return name, err
	})
	f.store.WithObserver(o)
	if _, e = f.pool.Exec(f.ctx, `UPDATE public.users SET display_name='协作成员' WHERE id='input-other';
	 INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('input-project','input-other','EDITOR','input-owner')`); e != nil {
		t.Fatal(e)
	}
	requestContext := f.ctx
	f.ctx = principal.WithActor(f.ctx, "input-other")
	created := f.history(t, "input-owner", "input-project", "result", "QUEUED", []domain.Output{})
	// The worker has no initiating HTTP context; attribution must survive SQL reload.
	f.ctx = requestContext
	lease := uuid.NewString()
	task, ok, e := f.store.Claim(f.ctx, lease)
	if e != nil || !ok || task.ID != created.ID {
		t.Fatal("claim", e, ok)
	}
	if task.InitiatedBy != "input-other" || task.OwnerID != "input-owner" {
		t.Fatal("persisted collaborator lost")
	}
	task.State = "RUNNING"
	if ok, e = f.store.Save(f.ctx, task, lease); e != nil || !ok {
		t.Fatal(e)
	}
	task.State = "FAILED"
	code := "PROVIDER_FAILED"
	task.ErrorCode = &code
	// A stale worker must not log or notify a failure that was not persisted.
	before := logs.Len()
	if ok, e = f.store.Save(f.ctx, task, uuid.NewString()); e != nil || ok {
		t.Fatal("stale save", e, ok)
	}
	if logs.Len() != before {
		t.Fatal("uncommitted outcome logged")
	}
	if ok, e = f.store.Save(f.ctx, task, lease); e != nil || !ok {
		t.Fatal(e)
	}
	if ok, e = f.store.Save(f.ctx, task, lease); e != nil || ok {
		t.Fatal("duplicate terminal save", e, ok)
	}
	if e = o.Close(context.Background()); e != nil {
		t.Fatal(e)
	}
	if sent != 1 {
		t.Fatal("async failure alert count", sent)
	}
	if !strings.Contains(notification, "协作成员") || !strings.Contains(notification, "input-other") || strings.Contains(notification, "input-owner") {
		t.Fatal("alert attributed to storage owner instead of initiator", notification)
	}
	body := logs.String()
	if !strings.Contains(body, observability.TaskLogID(task.ID)) || !strings.Contains(body, `"stage":"ACCEPTED"`) || !strings.Contains(body, `"state":"FAILED"`) {
		t.Fatal("missing lifecycle evidence", body)
	}
	if !strings.Contains(body, `"actor_id":"input-other"`) || !strings.Contains(body, `"actor_name":"协作成员"`) {
		t.Fatal("actor missing from persisted failure log")
	}
}
