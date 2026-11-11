package router

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func TestPersonalCredentialRequestsSignVerifiedActorAndExactWriteBody(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Router-Subject-Ref") != "usr_a" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
			t.Error("credential request lost authenticated actor")
		}
		want := proofSignature(bytes.Repeat([]byte("k"), 32), r.Method, r.URL.RequestURI(), "studio-tv", "usr_a", r.Header.Get("X-Router-Actor-Timestamp"), r.Header.Get("X-Router-Actor-Nonce"), body)
		if r.Header.Get("X-Router-Actor-Signature") != want {
			t.Error("credential request body was not signed")
		}
		switch r.Method {
		case http.MethodGet:
			if r.URL.Path != "/v1/provider-credentials" || len(body) != 0 {
				t.Error("credential listing request expanded scope")
			}
			respond(w, 200, `{"items":[{"providerRef":"minimax-official","title":"MiniMax","configured":false,"maskedKey":"","updatedAt":null,"configurable":true},{"providerRef":"volcengine-official","title":"Seedance","configured":false,"maskedKey":"","updatedAt":null,"configurable":true}],"protocolVersion":"1"}`)
		case http.MethodPut:
			if r.URL.Path != "/v1/provider-credentials/minimax-official" || string(body) != `{"apiKey":"TEST_ONLY_key_abcd","region":"cn"}` {
				t.Error("write-only credential body changed")
			}
			respond(w, 200, `{"providerRef":"minimax-official","title":"MiniMax","configured":true,"maskedKey":"********abcd","region":"cn","updatedAt":"2026-11-01T00:00:00Z","configurable":true,"protocolVersion":"1"}`)
		case http.MethodDelete:
			if r.URL.Path != "/v1/provider-credentials/minimax-official" || len(body) != 0 {
				t.Error("credential delete request expanded scope")
			}
			respond(w, 200, `{"providerRef":"minimax-official","title":"MiniMax","configured":false,"maskedKey":"","updatedAt":"2026-11-01T00:00:00Z","configurable":true,"protocolVersion":"1"}`)
		}
	}))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	actor := application.Actor{SubjectRef: "usr_a"}
	items, err := c.ProviderCredentials(context.Background(), actor)
	if err != nil || len(items) != 2 || items[0].Configured {
		t.Fatal("credential listing failed", err)
	}
	item, err := c.SaveProviderCredential(context.Background(), actor, "minimax-official", " TEST_ONLY_key_abcd ", "cn")
	if err != nil || !item.Configured || item.MaskedKey != "********abcd" {
		t.Fatal("credential save failed", err)
	}
	item, err = c.DeleteProviderCredential(context.Background(), actor, "minimax-official")
	if err != nil || item.Configured || item.MaskedKey != "" || calls != 3 {
		t.Fatal("credential delete failed", err)
	}
}

func TestPersonalCredentialAdapterFailsClosedOnUnsafeMetadata(t *testing.T) {
	for _, response := range []string{
		`{"items":[{"providerRef":"minimax-official","configured":true,"maskedKey":"TEST_ONLY_full_key","updatedAt":"2026-11-01T00:00:00Z"}],"protocolVersion":"1"}`,
		`{"items":[{"providerRef":"minimax-official","configured":true,"maskedKey":"********suffix_too_long","updatedAt":"2026-11-01T00:00:00Z"}],"protocolVersion":"1"}`,
		`{"items":[{"providerRef":"minimax-official","configured":false,"maskedKey":"TEST_ONLY_full_key","updatedAt":null}],"protocolVersion":"1"}`,
		`{"items":[{"providerRef":"arbitrary","configured":false,"maskedKey":"","updatedAt":null}],"protocolVersion":"1"}`,
		`{"items":[],"protocolVersion":"2"}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { respond(w, 200, response) }))
		c, _ := New(configFor(server.URL))
		_, err := c.ProviderCredentials(context.Background(), application.Actor{SubjectRef: "usr_a"})
		server.Close()
		var fault *application.Fault
		if !errors.As(err, &fault) || fault.Code != "PROTOCOL_MISMATCH" {
			t.Fatal("unsafe credential metadata accepted")
		}
	}
}

func TestPersonalCredentialAdapterRejectsInvalidMutationBeforeHTTP(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++ }))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	actor := application.Actor{SubjectRef: "usr_a"}
	for _, tc := range []struct{ provider, key string }{{"arbitrary", "TEST_ONLY"}, {"minimax-official", ""}, {"volcengine-official", "with whitespace"}} {
		_, err := c.SaveProviderCredential(context.Background(), actor, tc.provider, tc.key, "")
		if err == nil {
			t.Fatal("invalid provider credential accepted")
		}
	}
	if calls != 0 {
		t.Fatal("invalid provider credential reached HTTP")
	}
}

func TestPersonalCredentialDisplayStatusNeverAcceptsAnUnmaskedKey(t *testing.T) {
	updated := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	base := application.ProviderCredential{ProviderRef: "minimax-official", Title: "MiniMax", Configured: true, MaskedKey: "********abcd", UpdatedAt: &updated, Configurable: true}
	if !validCredentialStatus(base) {
		t.Fatal("valid credential metadata rejected")
	}
	for _, mask := range []string{"TEST_ONLY_full_key", "********too_many_suffix_chars", "********a\nb", "********a b", ""} {
		item := base
		item.MaskedKey = mask
		if validCredentialStatus(item) {
			t.Fatal("unsafe key display accepted")
		}
	}
	item := base
	item.Configured = false
	if validCredentialStatus(item) {
		t.Fatal("unconfigured status exposed key suffix")
	}
	region := "cn"
	item = base
	item.ProviderRef, item.Region = "volcengine-official", &region
	if validCredentialStatus(item) {
		t.Fatal("Seedance credential accepted MiniMax region")
	}
}
