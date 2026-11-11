package postgres

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	"studiotv.local/service/api/internal/observability"
	"strings"
	"testing"
	"time"
)

func TestAgentCommittedFailureLogsAndNotifies(t *testing.T) {
	s, _, record := agentDB(t)
	var logs bytes.Buffer
	sent := 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sent++; w.Write([]byte(`{"code":0}`)) }))
	defer endpoint.Close()
	o, e := observability.New(observability.Config{Output: &logs, WebhookURL: endpoint.URL})
	if e != nil {
		t.Fatal(e)
	}
	defer o.Close(context.Background())
	s.WithObserver(o)
	ctx := context.Background()
	if _, e = s.Create(ctx, record); e != nil {
		t.Fatal(e)
	}
	r, e := s.Claim(ctx, 30*time.Second)
	if e != nil || r == nil {
		t.Fatal(e)
	}
	if e = s.Finish(ctx, *r, domain.Failed, "RUNTIME_FAILED", application.RuntimeResult{}); e != nil {
		t.Fatal(e)
	}
	o.Close(ctx)
	if sent != 1 || !strings.Contains(logs.String(), observability.TaskLogID(r.ID)) || !strings.Contains(logs.String(), `"stage":"RUNNING"`) {
		t.Fatal("missing agent lifecycle")
	}
}
