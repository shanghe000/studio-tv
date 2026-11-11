package application

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type officialFailureGateway struct {
	*receiptModeGateway
	code  string
	async bool
}

func (g *officialFailureGateway) Submit(ctx context.Context, actor gateway.Actor, submission gateway.Submission) (gateway.Invocation, error) {
	if g.async {
		return g.receiptModeGateway.Submit(ctx, actor, submission)
	}
	g.submits++
	return gateway.Invocation{}, &gateway.Fault{Code: g.code}
}

func (g *officialFailureGateway) Invocation(context.Context, gateway.Actor, string) (gateway.Invocation, error) {
	g.reads++
	return gateway.Invocation{Ref: "private-receipt", State: "FAILED", TestMode: true, NormalizedError: &gateway.NormalizedError{Code: g.code, Message: "TEST_ONLY private upstream diagnostic must never be persisted"}}, nil
}

func TestOfficialVideoFailuresReachTaskAndCanvasPlanWithoutProviderText(t *testing.T) {
	for _, async := range []bool{false, true} {
		for _, code := range []string{"COMFY_GENERATION_INTERRUPTED", "PROVIDER_CREDENTIAL_REQUIRED", "OFFICIAL_VIDEO_INSUFFICIENT_BALANCE", "OFFICIAL_VIDEO_AUTH_FAILED", "OFFICIAL_VIDEO_RATE_LIMITED", "OFFICIAL_VIDEO_REJECTED", "PROVIDER_CREDENTIAL_KEY_REMOVED", "OFFICIAL_VIDEO_CONTENT_REJECTED", "OFFICIAL_VIDEO_USAGE_LIMIT", "OFFICIAL_VIDEO_INPUT_INVALID"} {
			s, store, catalog := promptTestService(t, "LLM")
			g := &officialFailureGateway{receiptModeGateway: &receiptModeGateway{promptTestGateway: catalog, submitTestMode: true}, code: code, async: async}
			s.gateway = g
			task, err := promptCanvas(t, s, `{"params":{"prompt":"TEST MODE only"}}`)
			if err != nil {
				t.Fatal(err)
			}
			s.execute(context.Background(), task, "lease")
			got := store.task
			if got.State != "FAILED" || got.ErrorCode == nil || *got.ErrorCode != code || got.Plans[0].State != "FAILED" || got.Plans[0].ErrorCode == nil || *got.Plans[0].ErrorCode != code {
				t.Fatalf("official failure did not reach task and plan: async=%t code=%s state=%s", async, code, got.State)
			}
			raw, _ := json.Marshal(got)
			if strings.Contains(string(raw), "private upstream") {
				t.Fatal("upstream diagnostic was persisted")
			}
		}
	}
}

func TestPersonalCredentialUnavailableReasonSurvivesAcceptanceAndResume(t *testing.T) {
	for _, code := range []string{"PROVIDER_CREDENTIAL_REQUIRED", "PROVIDER_CREDENTIALS_DISABLED", "OFFICIAL_VIDEO_NOT_CONFIGURED"} {
		s, store, catalog := promptTestService(t, "LLM")
		cap := catalog.pages[""].Items[0]
		cap.Available = false
		cap.ParameterSchema = json.RawMessage(`{"type":"object","additionalProperties":false,"x-model-source":{"kind":"API","credentialProviderRef":"minimax-official","unavailableCode":"` + code + `"}}`)
		catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
		_, err := promptCanvas(t, s, `{"params":{"prompt":"TEST MODE only"}}`)
		faultCode(t, err, code)
		if store.creates != 0 {
			t.Fatal("unavailable personal API model created a task")
		}
		cap.Available = true
		catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
		g := &officialFailureGateway{receiptModeGateway: &receiptModeGateway{promptTestGateway: catalog, submitTestMode: true}, async: true}
		s.gateway = g
		task, err := promptCanvas(t, s, `{"params":{"prompt":"TEST MODE only"}}`)
		if err != nil {
			t.Fatal(err)
		}
		cap.Available = false
		catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
		s.execute(context.Background(), task, "lease")
		if store.task.State != "FAILED" || store.task.Plans[0].ErrorCode == nil || *store.task.Plans[0].ErrorCode != code || g.submits != 0 {
			t.Fatal("personal credential removal at resume lost cause or made a call")
		}
	}
}
