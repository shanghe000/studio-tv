package http

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

type credentialGateway struct {
	catalogGateway
	provider, key, region, operation string
	item                             application.ProviderCredential
	credentialErr                    error
}

func (g *credentialGateway) ProviderCredentials(_ context.Context, actor application.Actor) ([]application.ProviderCredential, error) {
	g.seen, g.operation = actor, "list"
	g.calls++
	return []application.ProviderCredential{g.item}, g.credentialErr
}
func (g *credentialGateway) SaveProviderCredential(_ context.Context, actor application.Actor, provider, key, region string) (application.ProviderCredential, error) {
	g.seen, g.provider, g.key, g.region, g.operation = actor, provider, key, region, "save"
	g.calls++
	return g.item, g.credentialErr
}
func (g *credentialGateway) DeleteProviderCredential(_ context.Context, actor application.Actor, provider string) (application.ProviderCredential, error) {
	g.seen, g.provider, g.operation = actor, provider, "delete"
	g.calls++
	return g.item, g.credentialErr
}

func TestPersonalCredentialsUseAuthenticatedActorAndWriteOnlyKey(t *testing.T) {
	updated := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	g := &credentialGateway{item: application.ProviderCredential{ProviderRef: "minimax-official", Configured: true, MaskedKey: "********abcd", UpdatedAt: &updated}}
	h := catalogHandler(t, g, "usr_verified")
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		path, body := providerCredentialsPath, ""
		if method != http.MethodGet {
			path += "/minimax-official"
		}
		if method == http.MethodPut {
			body = `{"apiKey":"  TEST_ONLY_opaque_abcd  ","region":"cn"}`
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Router-Subject-Ref", "usr_forged")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || g.seen.SubjectRef != "usr_verified" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("personal credential boundary failed: status=%d", w.Code)
		}
		if strings.Contains(w.Body.String(), "TEST_ONLY_opaque") || strings.Contains(w.Body.String(), `"apiKey"`) || strings.Contains(w.Body.String(), "usr_verified") {
			t.Fatal("personal credential response exposed private input")
		}
		if method == http.MethodPut && (g.key != "TEST_ONLY_opaque_abcd" || g.provider != "minimax-official" || g.region != "cn") {
			t.Fatal("personal key was not normalized for the selected provider")
		}
	}
}

func TestPersonalCredentialsRejectUntrustedScopeAndInvalidBodies(t *testing.T) {
	for _, tc := range []struct{ method, suffix, body string }{
		{"GET", "?subjectRef=other", ""},
		{"PUT", "/arbitrary", `{"apiKey":"TEST_ONLY"}`},
		{"PUT", "/minimax-official", `{"apiKey":"TEST_ONLY","subjectRef":"other"}`},
		{"PUT", "/minimax-official", `{"apiKey":""}`},
		{"PUT", "/minimax-official", `{"apiKey":"foo\nbar"}`},
		{"PUT", "/minimax-official", `{"apiKey":"foo bar"}`},
		{"PUT", "/minimax-official", `{"apiKey":"TEST_ONLY","region":""}`},
		{"PUT", "/minimax-official", `{"apiKey":"TEST_ONLY","region":"elsewhere"}`},
		{"PUT", "/volcengine-official", `{"apiKey":"TEST_ONLY","region":"cn"}`},
		{"PUT", "/minimax-official", `{"apiKey":"` + strings.Repeat("k", 4097) + `"}`},
		{"DELETE", "/minimax-official", `{"subjectRef":"other"}`},
	} {
		g := &credentialGateway{}
		r := httptest.NewRequest(tc.method, providerCredentialsPath+tc.suffix, strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		catalogHandler(t, g, "usr_verified").ServeHTTP(w, r)
		if w.Code < 400 || w.Code >= 500 || g.calls != 0 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid personal credential input reached infrastructure: method=%s status=%d", tc.method, w.Code)
		}
	}
}

func TestPersonalCredentialsRequireIdentityAndDoNotExposeUpstreamErrors(t *testing.T) {
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		path := providerCredentialsPath
		if method != "GET" {
			path += "/minimax-official"
		}
		g := &credentialGateway{}
		w := httptest.NewRecorder()
		catalogHandler(t, g, "").ServeHTTP(w, httptest.NewRequest(method, path, nil))
		if w.Code != 401 || g.calls != 0 {
			t.Fatal("personal credential request accepted missing identity")
		}
	}
	g := &credentialGateway{credentialErr: errors.New("private provider credential diagnostic")}
	w := httptest.NewRecorder()
	catalogHandler(t, g, "usr_verified").ServeHTTP(w, httptest.NewRequest("GET", providerCredentialsPath, nil))
	if w.Code != 503 || strings.Contains(w.Body.String(), "private provider") {
		t.Fatal("credential infrastructure details escaped")
	}
	w = httptest.NewRecorder()
	catalogHandler(t, &catalogGateway{}, "usr_verified").ServeHTTP(w, httptest.NewRequest("GET", providerCredentialsPath, nil))
	if w.Code != 501 || !strings.Contains(w.Body.String(), "PROVIDER_CREDENTIALS_DISABLED") {
		t.Fatal("unsupported credential gateway fabricated success")
	}
}
