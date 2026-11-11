package application

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type batchWorkerGateway struct {
	*receiptModeGateway
	result       gateway.Invocation
	contentReads int
}

func (g *batchWorkerGateway) Invocation(context.Context, gateway.Actor, string) (gateway.Invocation, error) {
	g.reads++
	return g.result, nil
}
func (g *batchWorkerGateway) ArtifactContent(_ context.Context, _ gateway.Actor, a gateway.Artifact) ([]byte, error) {
	g.contentReads++
	return []byte("TEST MODE fixture " + a.Ref), nil
}

type batchWorkerImporter struct{ calls int }

func (i *batchWorkerImporter) Import(_ context.Context, owner, project, key string, a gateway.Artifact, body []byte) (Asset, error) {
	i.calls++
	if owner != "owner" || project != "project" || key == "" || len(body) == 0 {
		panic("invalid scoped fixture import")
	}
	return Asset{ID: "owned-" + a.Ref, MimeType: a.MediaType}, nil
}

func TestImageBatchWorkerImportsPartialResultsWithoutPromotingSuccess(t *testing.T) {
	for _, state := range []string{"SUCCEEDED", "FAILED", "CANCELED"} {
		t.Run(state, func(t *testing.T) {
			s, store, catalog := promptTestService(t, "TEXT_TO_IMAGE")
			cap := realImageCapability("TEXT_TO_IMAGE")
			cap.Version = "2"
			cap.ParameterSchemaVersion = "2"
			cap.TestMode = true
			cap.ParameterSchema = json.RawMessage(`{"type":"object","properties":{"count":{"type":"integer","enum":[1,2,4]}},"additionalProperties":false}`)
			catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			g := &batchWorkerGateway{receiptModeGateway: &receiptModeGateway{promptTestGateway: catalog, submitTestMode: true}, result: gateway.Invocation{Ref: "receipt", State: state, TestMode: true}}
			for i := 0; i < 2; i++ {
				ref := fmt.Sprintf("artifact-%d", i)
				out := fmt.Sprintf("output-%d", i)
				g.result.OutputParts = append(g.result.OutputParts, gateway.OutputPart{OutputRef: out, Type: "ARTIFACT", ArtifactRef: &ref, TestMode: true})
				g.result.Artifacts = append(g.result.Artifacts, gateway.Artifact{Ref: ref, OutputRef: out, MediaType: "image/png", TestMode: true})
			}
			if state != "SUCCEEDED" {
				g.result.NormalizedError = &gateway.NormalizedError{Code: "CODEX_IMAGE_BATCH_INCOMPLETE"}
			}
			importer := &batchWorkerImporter{}
			s.gateway = g
			s.importer = importer
			count := 2
			if state != "SUCCEEDED" {
				count = 4
			}
			task, err := promptCanvas(t, s, fmt.Sprintf(`{"capabilityRef":"codex-image-generate-v1","capabilityVersion":"2","params":{"prompt":"TEST MODE batch fixture"},"routerParameters":{"count":%d}}`, count))
			if err != nil {
				t.Fatal(err)
			}
			s.execute(context.Background(), task, "lease")
			got := store.task
			if got.State != state || got.Plans[0].State != state || len(got.Plans[0].Outputs) != 2 || importer.calls != 2 || g.submits != 1 || g.contentReads != 2 {
				t.Fatalf("state=%s outputs=%d imports=%d submits=%d", got.State, len(got.Plans[0].Outputs), importer.calls, g.submits)
			}
			if state != "SUCCEEDED" && (got.ErrorCode == nil || *got.ErrorCode != "CODEX_IMAGE_BATCH_INCOMPLETE") {
				t.Fatal("partial batch error lost")
			}
			for _, out := range got.Plans[0].Outputs {
				if out.Type != "ASSET" || out.AssetID == nil || !out.TestMode {
					t.Fatal("partial image lacks canonical persisted asset", out)
				}
			}
		})
	}
}

func TestImageBatchPartialContractRejectsOtherVersionsAndMalformedArtifacts(t *testing.T) {
	r := gateway.InvocationRequest{}
	r.Capability.Ref = "codex-image-generate-v1"
	r.Capability.Version = "2"
	a := "a"
	v := gateway.Invocation{State: "FAILED", OutputParts: []gateway.OutputPart{{OutputRef: "o", Type: "ARTIFACT", ArtifactRef: &a}}, Artifacts: []gateway.Artifact{{Ref: a, OutputRef: "o", MediaType: "image/png"}}}
	if !hasPartialImageBatch(r, v) {
		t.Fatal("valid partial rejected")
	}
	r.Capability.Version = "3"
	if !hasPartialImageBatch(r, v) {
		t.Fatal("v3 valid partial rejected")
	}
	r.Capability.Version = "1"
	if hasPartialImageBatch(r, v) {
		t.Fatal("v1 behavior changed")
	}
	r.Capability.Version = "2"
	v.Artifacts[0].MediaType = "video/mp4"
	if hasPartialImageBatch(r, v) {
		t.Fatal("non-image partial accepted")
	}
	v.Artifacts[0].MediaType = "image/png"
	v.OutputParts = append(v.OutputParts, v.OutputParts[0])
	v.Artifacts = append(v.Artifacts, v.Artifacts[0])
	if hasPartialImageBatch(r, v) {
		t.Fatal("duplicate partial accepted")
	}
}
