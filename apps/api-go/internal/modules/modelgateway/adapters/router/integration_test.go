package router

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

// This test requires an explicitly supplied disposable Router + PostgreSQL.
// scripts/test-iteration-01.py supplies only isolated credentials, never IPAC
// identities or model adapters. No httptest server substitutes for this test.
func TestModelsRouterHTTPIntegration(t *testing.T) {
	origin := os.Getenv("TEST_MODELS_ROUTER_URL")
	if origin == "" {
		t.Skip("TEST_MODELS_ROUTER_URL unset; real Router/PostgreSQL joint integration NOT RUN")
	}
	token := integrationSecret(t, "TEST_MODELS_ROUTER_TOKEN")
	key, err := base64.StdEncoding.DecodeString(integrationSecret(t, "TEST_MODELS_ROUTER_SIGNING_KEY_B64"))
	if err != nil || len(key) < 32 {
		t.Fatal("explicit test signing key must be standard base64 of at least 32 bytes")
	}
	app := os.Getenv("TEST_MODELS_ROUTER_CLIENT_APP")
	if app == "" {
		app = "studio-iteration-test"
	}
	cfg := Config{BaseURL: origin, ClientApp: app, ServiceToken: token, SigningKey: key, Timeout: 10 * time.Second}
	transport := &integrationTransport{base: http.DefaultTransport}
	cfg.Transport = transport
	client, err := New(cfg)
	if err != nil {
		t.Fatal("invalid explicit joint integration configuration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	t.Cleanup(http.DefaultTransport.(*http.Transport).CloseIdleConnections)
	var random [12]byte
	if _, err = rand.Read(random[:]); err != nil {
		t.Fatal("cannot generate independent test scope")
	}
	prefix := "iteration-" + hex.EncodeToString(random[:])
	a, b := application.Actor{SubjectRef: prefix + "-actorA"}, application.Actor{SubjectRef: prefix + "-actorB"}
	conversation := prefix + "-conversation"
	var sessionA, sessionB application.Session

	t.Run("ready_with_real_storage", func(t *testing.T) {
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(origin, "/")+"/readyz", nil)
		if e != nil {
			t.Fatal("invalid test readiness URL")
		}
		response, e := client.http.Do(req)
		if e != nil {
			t.Fatal("disposable Router readiness request failed")
		}
		defer response.Body.Close()
		var health struct{ Status, ProtocolVersion string }
		if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health) != nil || response.StatusCode != 200 || health.Status != "ok" || health.ProtocolVersion != "1" || response.Header.Get("X-Models-Router-Version") != "1" {
			t.Fatalf("Router storage is not ready: HTTP %d", response.StatusCode)
		}
	})
	if t.Failed() {
		return
	}
	t.Run("same_conversation_isolated_by_actor", func(t *testing.T) {
		var e error
		sessionA, e = client.EnsureSession(ctx, a, conversation)
		if e != nil || transport.status != 201 {
			t.Fatalf("actorA creation: HTTP %d, %v", transport.status, e)
		}
		sessionB, e = client.EnsureSession(ctx, b, conversation)
		if e != nil || transport.status != 201 || sessionB.Ref == sessionA.Ref || sessionB.ConversationRef != conversation {
			t.Fatalf("actorB scope isolation: HTTP %d, %v", transport.status, e)
		}
	})
	if t.Failed() {
		return
	}
	t.Run("recreation_preserves_session_and_timestamps", func(t *testing.T) {
		got, e := client.EnsureSession(ctx, a, conversation)
		if e != nil || transport.status != 200 || !reflect.DeepEqual(got, sessionA) {
			t.Fatalf("actorA natural-key restoration: HTTP %d, %v", transport.status, e)
		}
	})
	t.Run("both_cross_actor_reads_return_404", func(t *testing.T) {
		for _, test := range []struct {
			actor application.Actor
			ref   string
		}{{a, sessionB.Ref}, {b, sessionA.Ref}} {
			_, e := client.Session(ctx, test.actor, test.ref)
			integrationFault(t, e, transport.status, 404, "NOT_FOUND")
		}
	})
	t.Run("new_client_restores_persisted_sessions", func(t *testing.T) {
		// Fresh transport and client share no STUDIO memory with the creator.
		freshTransport := http.DefaultTransport.(*http.Transport).Clone()
		defer freshTransport.CloseIdleConnections()
		freshConfig := cfg
		freshConfig.Transport = freshTransport
		fresh, e := New(freshConfig)
		if e != nil {
			t.Fatal("cannot construct independent HTTP client")
		}
		for _, test := range []struct {
			actor application.Actor
			want  application.Session
		}{{a, sessionA}, {b, sessionB}} {
			got, e := fresh.Session(ctx, test.actor, test.want.Ref)
			if e != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("persisted session GET from new client: %v", e)
			}
			got, e = fresh.EnsureSession(ctx, test.actor, conversation)
			if e != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("persisted natural-key recovery from new client: %v", e)
			}
		}
	})
	t.Run("unconfigured_capabilities_are_an_empty_list", func(t *testing.T) {
		for _, actor := range []application.Actor{a, b} {
			for _, kind := range []string{"", "LLM"} {
				page, e := client.Capabilities(ctx, actor, application.CapabilityQuery{Kind: kind, Limit: 20})
				if e != nil || transport.status != 200 || page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
					t.Fatalf("unconfigured capability catalogue: HTTP %d, %v", transport.status, e)
				}
			}
		}
	})
	if t.Failed() {
		return
	}
	t.Run("router_rejects_altered_actor_headers", func(t *testing.T) {
		for _, mutation := range []struct {
			name string
			edit func(*http.Request)
		}{
			{"subject", func(r *http.Request) { r.Header.Set("X-Router-Subject-Ref", b.SubjectRef) }},
			{"client_app", func(r *http.Request) { r.Header.Set("X-Router-Client-App", app+"-unregistered") }},
			{"missing_signature", func(r *http.Request) { r.Header.Del("X-Router-Actor-Signature") }},
			{"duplicate_subject", func(r *http.Request) { r.Header.Add("X-Router-Subject-Ref", a.SubjectRef) }},
			{"nonce", func(r *http.Request) { r.Header.Set("X-Router-Actor-Nonce", integrationNonce(t)) }},
		} {
			t.Run(mutation.name, func(t *testing.T) {
				transport.edit = mutation.edit
				defer func() { transport.edit = nil }()
				_, e := client.Session(ctx, a, sessionA.Ref)
				integrationFault(t, e, transport.status, 401, "UNAUTHENTICATED")
			})
		}
	})
	t.Run("router_rejects_persistent_nonce_replay", func(t *testing.T) {
		nonce := integrationNonce(t)
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		transport.edit = func(r *http.Request) {
			r.Header.Set("X-Router-Actor-Nonce", nonce)
			r.Header.Set("X-Router-Actor-Timestamp", timestamp)
			r.Header.Set("X-Router-Actor-Signature", proofSignature(key, r.Method, r.URL.RequestURI(), app, a.SubjectRef, timestamp, nonce, nil))
		}
		defer func() { transport.edit = nil }()
		if _, e := client.Session(ctx, a, sessionA.Ref); e != nil || transport.status != 200 {
			t.Fatalf("initial signed nonce request: HTTP %d, %v", transport.status, e)
		}
		// Repeat through another client/connection; Router's PG nonce receipt
		// must enforce rejection, regardless of STUDIO client instance.
		freshBase := http.DefaultTransport.(*http.Transport).Clone()
		defer freshBase.CloseIdleConnections()
		freshTransport := &integrationTransport{base: freshBase, edit: transport.edit}
		freshConfig := cfg
		freshConfig.Transport = freshTransport
		fresh, e := New(freshConfig)
		if e != nil {
			t.Fatal("cannot construct replay test client")
		}
		_, e = fresh.Session(ctx, a, sessionA.Ref)
		integrationFault(t, e, freshTransport.status, 401, "ACTOR_PROOF_REPLAYED")
	})
	t.Run("invocations_remain_reserved_without_model_execution", func(t *testing.T) {
		// No capability/input or adapter is configured. This checks the reserved
		// boundary only; it must never be used to exercise a real model.
		var out any
		e := client.do(ctx, a, http.MethodPost, "/v1/invocations", []byte(`{}`), &out)
		integrationFault(t, e, transport.status, 501, "ADAPTER_NOT_CONFIGURED")
	})
}

func integrationSecret(t *testing.T, name string) string {
	t.Helper()
	value, file := os.Getenv(name), os.Getenv(name+"_FILE")
	if value != "" && file != "" {
		t.Fatal("choose explicit test credential value or secret file")
	}
	if file != "" {
		info, e := os.Stat(file)
		if e != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			t.Fatal("joint test secret file must be a regular 0600 file")
		}
		body, e := os.ReadFile(file)
		if e != nil {
			t.Fatal("cannot read joint test secret file")
		}
		value = strings.TrimSuffix(strings.TrimSuffix(string(body), "\n"), "\r")
	}
	if value == "" {
		t.Fatal("explicit Router URL requires all test credentials")
	}
	return value
}

func integrationNonce(t *testing.T) string {
	t.Helper()
	var random [18]byte
	if _, e := rand.Read(random[:]); e != nil {
		t.Fatal("cannot generate test nonce")
	}
	return base64.RawURLEncoding.EncodeToString(random[:])
}

func integrationFault(t *testing.T, err error, status, want int, code string) {
	t.Helper()
	var fault *application.Fault
	if status != want || !errors.As(err, &fault) || fault.Code != code || fault.Retryable {
		t.Fatalf("expected HTTP %d/%s; got HTTP %d, %v", want, code, status, err)
	}
}

// Sequential subtests use real HTTP. Only response status is retained; actor
// headers, signed canonical bytes and credentials are never logged.
type integrationTransport struct {
	base   http.RoundTripper
	edit   func(*http.Request)
	status int
}

func (r *integrationTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	copy.Header = request.Header.Clone()
	if r.edit != nil {
		r.edit(copy)
	}
	r.status = 0
	response, err := r.base.RoundTrip(copy)
	if response != nil {
		r.status = response.StatusCode
	}
	return response, err
}
