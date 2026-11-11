package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func exactVersionItem() map[string]any {
	return map[string]any{"capabilityRef": "chat.general", "version": "1", "kind": "LLM", "executionKind": "MODEL", "parameterSchemaVersion": "1", "parameterSchema": map[string]any{"type": "object", "additionalProperties": false}, "inputKinds": []string{"TEXT"}, "outputKinds": []string{"TEXT"}, "supportsSession": false, "sessionMode": "NONE", "available": true, "model": map[string]any{"providerRef": "codex", "modelRef": "codex-text", "title": "Codex", "version": "1"}}
}

func TestCapabilityVersionTransportKeepsExactPairAndActorProof(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.RequestURI() != "/extensions/capability-versions/v1/capability?ref=chat.general&version=1" || r.Header.Get("X-Router-Subject-Ref") != "usr_verified" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) || r.Header.Get("Cache-Control") != "no-store" {
			t.Error("exact query lost version, actor or cache policy")
		}
		want := proofSignature(bytes.Repeat([]byte("k"), 32), r.Method, r.URL.RequestURI(), "studio-tv", "usr_verified", r.Header.Get("X-Router-Actor-Timestamp"), r.Header.Get("X-Router-Actor-Nonce"), nil)
		if r.Header.Get("X-Router-Actor-Signature") != want {
			t.Error("exact query was not signed")
		}
		body, _ := json.Marshal(exactVersionItem())
		w.Header().Set("Cache-Control", "no-store")
		respond(w, 200, string(body))
	}))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	cap, err := c.CapabilityVersion(context.Background(), application.Actor{SubjectRef: "usr_verified"}, "chat.general", "1")
	if err != nil || cap.Ref != "chat.general" || cap.Version != "1" || cap.ParameterSchemaVersion != "1" || cap.Model == nil || cap.Model.Version != "1" || string(cap.ParameterSchema) != `{"additionalProperties":false,"type":"object"}` {
		t.Fatalf("exact metadata changed: %+v %v", cap, err)
	}
}

func TestCapabilityVersionRejectsMismatchedPairEnvelopeAndSchema(t *testing.T) {
	for _, mode := range []string{"ref", "version", "envelope", "schema", "session"} {
		t.Run(mode, func(t *testing.T) {
			item := exactVersionItem()
			var output any = item
			switch mode {
			case "ref":
				item["capabilityRef"] = "other"
			case "version":
				item["version"] = "2"
			case "envelope":
				output = map[string]any{"data": item}
			case "schema":
				item["parameterSchema"] = nil
			case "session":
				item["supportsSession"] = true
			}
			body, _ := json.Marshal(output)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { respond(w, 200, string(body)) }))
			defer server.Close()
			c, _ := New(configFor(server.URL))
			_, err := c.CapabilityVersion(context.Background(), application.Actor{SubjectRef: "usr_a"}, "chat.general", "1")
			var fault *application.Fault
			if !errors.As(err, &fault) || fault.Code != "PROTOCOL_MISMATCH" {
				t.Fatalf("invalid exact metadata accepted: %v", err)
			}
		})
	}
}

func TestCapabilityVersionUnknownAndInvalidInputsNeverUseLatest(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/extensions/capability-versions/v1/capability" {
			t.Error("unknown exact version fell back to latest catalog")
		}
		respond(w, 404, `{"error":{"code":"CAPABILITY_NOT_FOUND","retryable":false},"requestId":"req_exact","protocolVersion":"1"}`)
	}))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	_, err := c.CapabilityVersion(context.Background(), application.Actor{SubjectRef: "usr_a"}, "chat.general", "old")
	var fault *application.Fault
	if !errors.As(err, &fault) || fault.Code != "CAPABILITY_NOT_FOUND" || calls != 1 {
		t.Fatalf("unknown version changed meaning: %v", err)
	}
	for _, test := range []struct{ actor, ref, version string }{{"bad\nactor", "chat.general", "1"}, {"usr_a", "", "1"}, {"usr_a", "chat.general", ""}, {"usr_a", "chat.general", "bad version"}, {"usr_a", "chat.general", strings.Repeat("1", 101)}} {
		if _, err := c.CapabilityVersion(context.Background(), application.Actor{SubjectRef: test.actor}, test.ref, test.version); err == nil {
			t.Fatal("invalid query accepted")
		}
	}
	if calls != 1 {
		t.Fatal("invalid inputs reached Router")
	}
}
