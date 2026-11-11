package pfhttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/agentrun/application"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testCredential() application.Credential {
	now := time.Now().UTC().Truncate(time.Second)
	a := application.Actor{OwnerID: "a", SessionID: "session", IssuedAt: now.Add(-time.Minute), AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour)}
	return application.Credential{Actor: a, Bearer: "private-token", ExpiresAt: a.AccessExpiresAt}
}
func TestExecutorUsesExactBearerCASAndUUIDWithoutCookieOrRedirect(t *testing.T) {
	cred := testCredential()
	var verifies atomic.Int32
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer private-token" || r.Header.Get("Cookie") != "" || r.Header.Get("If-Match") != `"12"` || r.Header.Get("Idempotency-Key") != "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" {
			t.Error("trusted headers not frozen")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"commandId": "cmd", "graphRevision": 13, "delta": map[string]any{"secret": "private"}}})
	}))
	defer srv.Close()
	e, err := New(srv.URL, srv.Client(), func(context.Context, string) (application.Actor, error) { verifies.Add(1); return cred.Actor, nil })
	if err != nil {
		t.Fatal(err)
	}
	response, err := e.Execute(context.Background(), cred, application.ToolRequest{Method: "POST", Path: "/api/v2/projects/p/canvas-commands", Body: json.RawMessage(`{"schemaVersion":"1","operations":[]}`), ExpectedRevision: 12, IdempotencyKey: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"})
	if err != nil || response.Status != 200 || strings.Contains(string(response.Data), "secret") || verifies.Load() != 1 || calls.Load() != 1 {
		t.Fatal(response, err)
	}
}
func TestExecutorRevalidatesOwnerAndStopsBeforeRequest(t *testing.T) {
	cred := testCredential()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer srv.Close()
	e, _ := New(srv.URL, nil, func(context.Context, string) (application.Actor, error) {
		other := cred.Actor
		other.OwnerID = "b"
		return other, nil
	})
	_, err := e.Execute(context.Background(), cred, application.ToolRequest{Method: "GET", Path: "/api/v2/tasks/t"})
	if !errors.Is(err, domain.ErrAuth) || calls.Load() != 0 {
		t.Fatal("cross user sent to API", err, calls.Load())
	}
	e.verify = func(context.Context, string) (application.Actor, error) {
		return application.Actor{}, httpapi.Retry(503, "IPAC_UNAVAILABLE", "private-provider-body")
	}
	var verification *application.VerificationFailure
	if err = e.Revalidate(context.Background(), cred); !errors.Is(err, domain.ErrUnavailable) || !errors.As(err, &verification) || strings.Contains(err.Error(), "private-provider-body") {
		t.Fatal("temporary authorization became revocation or retained private material", err)
	}
}
func TestExecutorRedactsSignedURLsAndUnknownCanvasFields(t *testing.T) {
	cred := testCredential()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"projectId": "p", "graphRevision": 1, "eventCursor": "0", "graph": map[string]any{"nodes": []any{map[string]any{"id": "n", "type": "rh-text", "position": map[string]any{"x": 1, "y": 2}, "data": map[string]any{"prompt": "draw /storage/a?token=SECRET and https://alice:pw@example.test/picture", "arbitrary": map[string]any{"private": "TOKEN2"}}}}, "edges": []any{}}}})
	}))
	defer srv.Close()
	e, _ := New(srv.URL, nil, func(context.Context, string) (application.Actor, error) { return cred.Actor, nil })
	out, err := e.Execute(context.Background(), cred, application.ToolRequest{Method: "GET", Path: "/api/v2/projects/p/live-snapshot"})
	if err != nil || strings.Contains(string(out.Data), "SECRET") || strings.Contains(string(out.Data), "TOKEN2") || strings.Contains(string(out.Data), "alice") || !strings.Contains(string(out.Data), "draw ") {
		t.Fatal("unsafe canvas tool context", string(out.Data), err)
	}
	nested := sanitize(json.RawMessage(`{"outputs":[{"text":"https://x/?%74oken=SECRET;ordinary=1","unknown":{"note":"/api/z?signature=SECRETB"}}]}`))
	if strings.Contains(string(nested), "SECRET") {
		t.Fatal("nested task text leaked signed credentials", string(nested))
	}
}
func TestExecutorRejectsRedirectAndArbitraryPath(t *testing.T) {
	cred := testCredential()
	var receiver atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { receiver.Add(1) }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 302) }))
	defer srv.Close()
	e, _ := New(srv.URL, nil, func(context.Context, string) (application.Actor, error) { return cred.Actor, nil })
	if _, err := e.Execute(context.Background(), cred, application.ToolRequest{Method: "GET", Path: "/api/v2/tasks/t"}); err == nil || receiver.Load() != 0 {
		t.Fatal("followed redirect with credential")
	}
	if _, err := e.Execute(context.Background(), cred, application.ToolRequest{Method: "GET", Path: "/api/v2/admin/secret"}); !errors.Is(err, domain.ErrToolRejected) {
		t.Fatal("unregistered API proxy accepted", err)
	}
}
func TestTaskWaitPollsRealStatusAndEveryPollReauthenticates(t *testing.T) {
	cred := testCredential()
	var calls, verifies atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := "RUNNING"
		if calls.Add(1) > 1 {
			state = "SUCCEEDED"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"id": "t", "state": state}})
	}))
	defer srv.Close()
	e, _ := New(srv.URL, nil, func(context.Context, string) (application.Actor, error) { verifies.Add(1); return cred.Actor, nil })
	out, err := e.Execute(context.Background(), cred, application.ToolRequest{Method: "GET", Path: "/api/v2/tasks/t", WaitSeconds: 2})
	if err != nil || !strings.Contains(string(out.Data), "SUCCEEDED") || calls.Load() != 2 || verifies.Load() != 2 {
		t.Fatal(out, err, calls.Load(), verifies.Load())
	}
}
