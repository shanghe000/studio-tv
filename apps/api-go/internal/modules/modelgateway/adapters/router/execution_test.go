package router

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
	"strings"
	"testing"
	"time"
)

func TestExecutionReceiptsAcceptQueuedAndRejectMissingOutputs(t *testing.T) {
	now := time.Now().UTC()
	inv := application.Invocation{Ref: "inv_abc", OperationRef: "exe_abc", State: "QUEUED", CreatedAt: now, UpdatedAt: now, OutputParts: []application.OutputPart{}, Artifacts: []application.Artifact{}, TestMode: true}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Models-Router-Features") != "progress-detail-v1" {
			t.Error("measured progress extension not negotiated")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Models-Router-Version", "1")
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Router-Actor-Signature") != proofSignature([]byte(strings.Repeat("k", 32)), r.Method, r.URL.RequestURI(), "studio-tv", "owner", r.Header.Get("X-Router-Actor-Timestamp"), r.Header.Get("X-Router-Actor-Nonce"), body, r.Header.Get("Idempotency-Key")) {
			t.Error("idempotency key not bound in actor signature")
		}
		if r.Header.Get("Idempotency-Key") == "" {
			t.Error("key missing")
		}
		w.WriteHeader(202)
		json.NewEncoder(w).Encode(inv)
	}))
	defer server.Close()
	client, err := New(Config{BaseURL: server.URL, ClientApp: "studio-tv", ServiceToken: strings.Repeat("t", 32), SigningKey: []byte(strings.Repeat("k", 32))})
	if err != nil {
		t.Fatal(err)
	}
	got, err := client.Submit(context.Background(), application.Actor{SubjectRef: "owner"}, application.Submission{IdempotencyKey: uuid.NewString(), Request: application.InvocationRequest{OperationRef: "exe_abc"}})
	if err != nil || got.Ref != inv.Ref {
		t.Fatal("queued receipt", err)
	}
	inv.OutputParts = nil
	if _, err = client.Submit(context.Background(), application.Actor{SubjectRef: "owner"}, application.Submission{IdempotencyKey: uuid.NewString(), Request: application.InvocationRequest{OperationRef: "exe_abc"}}); err == nil {
		t.Fatal("null output list accepted")
	}
}
