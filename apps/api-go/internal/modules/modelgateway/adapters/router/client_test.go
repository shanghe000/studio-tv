package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

const sessionRef = "sess_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func configFor(origin string) Config {
	return Config{BaseURL: origin, ClientApp: "studio-tv", ServiceToken: strings.Repeat("t", 32), SigningKey: bytes.Repeat([]byte("k"), 32)}
}
func respond(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Models-Router-Version", "1")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func TestActorProofProtocolVector(t *testing.T) {
	// Fixed independently generated protocol-v1 vector, including raw query.
	got := proofSignature(bytes.Repeat([]byte("k"), 32), "GET", "/v1/capabilities?kind=LLM&limit=20", "studio-tv", "usr_a", "1700000000", "ABCDEFGHIJKLMNOPQRSTUVWX", nil)
	if got != "v1=frRUM-uYJqtV-HI7se3m2X-Z_0pdX1cg1PB0kq_0Fzw" {
		t.Fatal("actor proof differs from protocol vector")
	}
}
func TestSessionBindsActorAndRotatesNonce(t *testing.T) {
	seen := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.RequestURI() != "/v1/sessions" || string(body) != `{"conversationRef":"conversation_1"}` || r.Header.Get("X-Router-Client-App") != "studio-tv" || r.Header.Get("X-Router-Subject-Ref") != "usr_a" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
			t.Error("request lost scope or input")
		}
		if r.Header.Get("Idempotency-Key") != "" {
			t.Error("naturally idempotent session must not receive invocation key")
		}
		nonce := r.Header.Get("X-Router-Actor-Nonce")
		if seen[nonce] || len(nonce) < 22 {
			t.Error("actor proof nonce reused")
		}
		seen[nonce] = true
		want := proofSignature(bytes.Repeat([]byte("k"), 32), r.Method, r.URL.RequestURI(), "studio-tv", "usr_a", r.Header.Get("X-Router-Actor-Timestamp"), nonce, body)
		if r.Header.Get("X-Router-Actor-Signature") != want {
			t.Error("request bytes not signed")
		}
		respond(w, 201, `{"sessionRef":"`+sessionRef+`","conversationRef":"conversation_1","state":"OPEN","createdAt":"2026-10-05T00:00:00Z","updatedAt":"2026-10-05T00:00:00Z","contextCheckpoint":null,"runtimeMetadata":null}`)
	}))
	defer server.Close()
	c, err := New(configFor(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		value, err := c.EnsureSession(context.Background(), application.Actor{SubjectRef: "usr_a"}, "conversation_1")
		if err != nil || value.Ref != sessionRef {
			t.Fatalf("session: %v", err)
		}
	}
}
func TestCapabilitiesAreTypedAndUnavailableIsNotSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/capabilities" {
			respond(w, 200, `{"items":[{"capabilityRef":"chat.general","version":"1","kind":"LLM","executionKind":"AGENT","model":{"providerRef":"supplier","modelRef":"public-chat","title":"Public chat","version":"6.1"},"parameterSchemaVersion":"1","parameterSchema":{"type":"object"},"inputKinds":["TEXT"],"outputKinds":["TEXT"],"supportsSession":true,"supportsStream":true,"supportsCancel":true,"available":false,"reason":"UNCONFIGURED"}],"nextCursor":null,"protocolVersion":"1"}`)
			return
		}
		respond(w, 501, `{"error":{"code":"ADAPTER_NOT_CONFIGURED","message":"secret should not escape","retryable":false},"requestId":"req_1","protocolVersion":"1"}`)
	}))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	page, err := c.Capabilities(context.Background(), application.Actor{SubjectRef: "usr_a"}, application.CapabilityQuery{Kind: "LLM", Limit: 20})
	if err != nil || len(page.Items) != 1 || page.Items[0].ExecutionKind != "AGENT" || page.Items[0].Available || page.Items[0].Model == nil || page.Items[0].Model.ModelRef != "public-chat" {
		t.Fatalf("capability projection: %v", err)
	}
	_, err = c.Session(context.Background(), application.Actor{SubjectRef: "usr_a"}, sessionRef)
	if !errors.Is(err, application.ErrNotConfigured) || strings.Contains(err.Error(), "secret") {
		t.Fatal("unconfigured call must remain a sanitized failure")
	}
}

func TestSessionKeepsMeasurementProvenanceAndUnknownCosts(t *testing.T) {
	// Explicit future-protocol fixture, not a claim that inference is enabled.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		respond(w, 200, `{"sessionRef":"`+sessionRef+`","conversationRef":"conversation_1","state":"OPEN","createdAt":"2026-10-05T00:00:00Z","updatedAt":"2026-10-05T00:00:00Z","contextCheckpoint":null,"runtimeMetadata":{"usage":{"scope":"SESSION","source":"REPORTED","coverage":"PRIMARY_THREAD","inputTokens":42,"cachedInputTokens":0,"cacheWriteInputTokens":null,"outputTokens":null,"reasoningOutputTokens":null,"totalTokens":null,"units":[{"unit":"VIDEO_SECOND","quantity":"5.5","source":"REPORTED"}],"status":"PARTIAL","observedAt":"2026-10-05T00:00:00Z"},"context":{"windowTokens":null,"usedTokens":null,"remainingTokensEstimate":null,"reservedOutputTokens":null,"measurement":"UNAVAILABLE","compactionCount":null,"observedAt":null},"billing":{"mode":"UNKNOWN","currency":null,"actualAmount":null,"estimatedAmount":null,"pricingRevision":null}}}`)
	}))
	defer server.Close()
	client, _ := New(configFor(server.URL))
	session, err := client.Session(context.Background(), application.Actor{SubjectRef: "usr_a"}, sessionRef)
	if err != nil || session.RuntimeMetadata == nil {
		t.Fatalf("runtime observations lost: %v", err)
	}
	m := session.RuntimeMetadata
	if m.Usage == nil || m.Usage.Coverage != "PRIMARY_THREAD" || m.Usage.InputTokens == nil || *m.Usage.InputTokens != 42 || m.Usage.CachedInputTokens == nil || *m.Usage.CachedInputTokens != 0 || m.Usage.TotalTokens != nil || len(m.Usage.Units) != 1 || m.Usage.Units[0].Quantity != "5.5" || m.Usage.ObservedAt == nil {
		t.Fatal("usage nulls, zero, units or provenance changed")
	}
	if m.Context == nil || m.Context.WindowTokens != nil || m.Context.RemainingTokensEstimate != nil || m.Context.Measurement != "UNAVAILABLE" || m.Billing == nil || m.Billing.Mode != "UNKNOWN" || m.Billing.ActualAmount != nil {
		t.Fatal("unknown context or charges must not become zero")
	}
}
func TestRejectsMismatchedSessionAndProtocol(t *testing.T) {
	for _, body := range []string{`{"sessionRef":"` + sessionRef + `","conversationRef":"other","state":"OPEN","createdAt":"2026-10-05T00:00:00Z","updatedAt":"2026-10-05T00:00:00Z"}`, `{"sessionRef":"invalid"}`, `{}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respond(w, 200, body) }))
		c, _ := New(configFor(server.URL))
		_, err := c.EnsureSession(context.Background(), application.Actor{SubjectRef: "usr_a"}, "conversation_1")
		server.Close()
		var fault *application.Fault
		if !errors.As(err, &fault) || fault.Code != "PROTOCOL_MISMATCH" {
			t.Fatal("invalid upstream session accepted")
		}
	}
}
func TestRedirectCannotForwardCredentials(t *testing.T) {
	called := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	c, _ := New(configFor(source.URL))
	_, err := c.EnsureSession(context.Background(), application.Actor{SubjectRef: "usr_a"}, "conversation_1")
	if err == nil || called {
		t.Fatal("credential-bearing request followed redirect")
	}
}
func TestConfigAndActorFailuresDoNotCallUpstream(t *testing.T) {
	for _, origin := range []string{"https://user:pass@example.test", "https://example.test/path", "https://example.test?secret=yes", "file:///tmp/router"} {
		if _, err := New(configFor(origin)); err == nil {
			t.Fatal("invalid router origin accepted")
		}
	}
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	_, err := c.EnsureSession(context.Background(), application.Actor{SubjectRef: "bad\nactor"}, "conversation_1")
	if err == nil || called {
		t.Fatal("invalid actor reached upstream")
	}
}
func TestUnconfiguredGatewayNeverInventsData(t *testing.T) {
	var gateway application.Gateway = application.Unconfigured{}
	_, err := gateway.Capabilities(context.Background(), application.Actor{SubjectRef: "usr_a"}, application.CapabilityQuery{})
	if !errors.Is(err, application.ErrNotConfigured) {
		t.Fatal("unconfigured catalogue must be an explicit failure")
	}
}

func TestCapabilitySessionModePreservesCompatibilityAndRejectsContradictions(t *testing.T) {
	for _, tc := range []struct {
		name, mode             string
		supportsSession, valid bool
	}{
		{"legacy", "", true, true},
		{"independent_image", "NONE", false, true},
		{"optional_chat", "OPTIONAL", true, true},
		{"agent_session", "REQUIRED", true, true},
		{"none_conflict", "NONE", true, false},
		{"optional_conflict", "OPTIONAL", false, false},
		{"required_conflict", "REQUIRED", false, false},
		{"unknown_mode", "FOREVER", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item := map[string]any{"capabilityRef": "image.generate", "version": "1", "kind": "TEXT_TO_IMAGE", "executionKind": "MODEL", "parameterSchemaVersion": "1", "parameterSchema": map[string]any{"type": "object"}, "inputKinds": []string{"TEXT"}, "outputKinds": []string{"IMAGE"}, "supportsSession": tc.supportsSession, "supportsStream": false, "supportsCancel": false, "available": false, "reason": "UNCONFIGURED"}
			if tc.mode != "" {
				item["sessionMode"] = tc.mode
			}
			body, err := json.Marshal(map[string]any{"items": []any{item}, "nextCursor": nil, "protocolVersion": "1"})
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { respond(w, 200, string(body)) }))
			defer server.Close()
			c, err := New(configFor(server.URL))
			if err != nil {
				t.Fatal(err)
			}
			page, err := c.Capabilities(context.Background(), application.Actor{SubjectRef: "usr_a"}, application.CapabilityQuery{})
			if !tc.valid {
				var fault *application.Fault
				if !errors.As(err, &fault) || fault.Code != "PROTOCOL_MISMATCH" {
					t.Fatalf("contradictory session behavior accepted: %v", err)
				}
				return
			}
			if err != nil || len(page.Items) != 1 {
				t.Fatalf("capability: %v", err)
			}
			mode := page.Items[0].SessionMode
			if (tc.mode == "" && mode != nil) || (tc.mode != "" && (mode == nil || *mode != tc.mode)) {
				t.Fatal("session mode was invented or lost")
			}
		})
	}
}
