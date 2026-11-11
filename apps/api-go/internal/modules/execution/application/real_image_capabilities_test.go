package application

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"strings"
	"testing"
)

func realImageCapability(kind string) gateway.Capability {
	ref := "codex-image-generate-v1"
	inputs := []string{"TEXT", "STRUCTURED"}
	if kind == "IMAGE_TO_IMAGE" {
		ref = "codex-image-edit-v1"
		inputs = append(inputs, "IMAGE")
	}
	cap := promptCapability(ref, kind)
	cap.TestMode = false
	cap.ExecutionKind = "AGENT"
	cap.Model = &gateway.ModelDescriptor{ProviderRef: "codex", ModelRef: "codex-image", Title: "Codex Image", Version: "1"}
	cap.InputKinds, cap.OutputKinds = inputs, []string{"IMAGE"}
	cap.ParameterSchema, _ = json.Marshal(map[string]any{"type": "object", "properties": map[string]any{"count": map[string]any{"type": "integer", "enum": []int{1}, "default": 1}}, "additionalProperties": false})
	return cap
}
func realImageCanvas(t *testing.T, s *Service, cap gateway.Capability, refs []string, scene string) (domain.Task, error) {
	t.Helper()
	params := map[string]any{"prompt": "preserve original user composition"}
	if refs != nil {
		params["imageUrls"] = refs
	}
	data := map[string]any{"capabilityRef": cap.Ref, "capabilityVersion": cap.Version, "subType": cap.Kind, "params": params, "routerParameters": map[string]any{"count": 1}}
	if scene != "" {
		data["sceneCode"] = scene
	}
	graph, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "image", "type": "rh-image", "data": data}}, "edges": []any{}})
	return s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "image", Graph: graph})
}
func TestRealImageGenerateAndReferenceEditFreezeMediaContractAndOwnedInputs(t *testing.T) {
	for _, kind := range []string{"TEXT_TO_IMAGE", "IMAGE_TO_IMAGE"} {
		t.Run(kind, func(t *testing.T) {
			s, _, g := promptTestService(t, kind)
			cap := realImageCapability(kind)
			g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			s.WithRealExecution(true)
			var refs []string
			if kind == "IMAGE_TO_IMAGE" {
				refs = []string{"rhtv-asset:img"}
			}
			task, err := realImageCanvas(t, s, cap, refs, "")
			if err != nil {
				t.Fatal(err)
			}
			request := frozenRequest(t, task)
			original, _ := defaultTemplate(kind)
			if task.TestMode || request.Capability.Ref != cap.Ref || request.Capability.Version != "1" || request.PromptSpec.OutputContract.Type != "MEDIA" || request.PromptSpec.TemplateSHA256 != original.spec().TemplateSHA256 || request.Input[0].Text == nil || *request.Input[0].Text != "preserve original user composition" {
				t.Fatal("real kind, original prompt, MEDIA contract or template hash changed")
			}
			if (kind == "IMAGE_TO_IMAGE") != task.Plans[0].PromptRequirements.RequireImage {
				t.Fatal("image edit input requirement not frozen")
			}
			if kind == "IMAGE_TO_IMAGE" && (len(request.Attachments) != 1 || request.Attachments[0].Kind != "IMAGE" || request.Attachments[0].SourceRef != "img" || request.Attachments[0].ReadGrantRef == "" || len(request.PromptSpec.Conditioning) != 1 || request.PromptSpec.Conditioning[0].Role != "REFERENCE_IMAGE") {
				t.Fatal("reference image did not keep owned grant and role")
			}
			if kind == "TEXT_TO_IMAGE" && len(request.Attachments) != 0 {
				t.Fatal("text generation acquired image input")
			}
		})
	}
}
func TestRealImageCapabilitiesRejectMissingWrongAndUnsupportedInputs(t *testing.T) {
	for _, c := range []struct {
		name, kind, scene, fault string
		refs                     []string
	}{
		{"edit without image", "IMAGE_TO_IMAGE", "", "PROMPT_REFERENCE_REQUIRED", nil},
		{"edit VIDEO", "IMAGE_TO_IMAGE", "", "PROMPT_CONDITIONING_INVALID", []string{"rhtv-asset:video"}},
		{"generation image input", "TEXT_TO_IMAGE", "", "PROMPT_CAPABILITY_MISMATCH", []string{"rhtv-asset:img"}},
		{"unconfigured scene", "IMAGE_TO_IMAGE", "not-configured", "PROMPT_TEMPLATE_NOT_CONFIGURED", []string{"rhtv-asset:img"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, store, g := promptTestService(t, c.kind)
			cap := realImageCapability(c.kind)
			g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			s.WithRealExecution(true)
			_, err := realImageCanvas(t, s, cap, c.refs, c.scene)
			faultCode(t, err, c.fault)
			if store.creates != 0 {
				t.Fatal("rejected image feature created task")
			}
		})
	}
	cap := realImageCapability("IMAGE_TO_IMAGE")
	raw, _ := json.Marshal(map[string]any{"count": 2})
	if err := validateParameters(cap, raw); err == nil {
		t.Fatal("unsupported multi-image count accepted")
	}
}
func TestRealImageEditWorkerRequiresImageEvenIfSavedPreflightFlagWasFalse(t *testing.T) {
	s, store, g := promptTestService(t, "IMAGE_TO_IMAGE")
	cap := realImageCapability("IMAGE_TO_IMAGE")
	g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	s.WithRealExecution(true)
	task, err := realImageCanvas(t, s, cap, []string{"rhtv-asset:img"}, "")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &receiptModeGateway{promptTestGateway: g, submitTestMode: false, readTestMode: false}
	s.gateway = fixture
	request := frozenRequest(t, task)
	request.Attachments = []gateway.Attachment{}
	request.PromptSpec.Conditioning = nil
	task.Plans[0].PromptRequirements.RequireImage = false
	task.Plans[0].InputBound = true
	task.Plans[0].Request, _ = json.Marshal(request)
	s.execute(context.Background(), task, "lease")
	if store.task.State != "FAILED" || store.task.ErrorCode == nil || *store.task.ErrorCode != "PROMPT_REFERENCE_REQUIRED" || fixture.submits != 0 {
		t.Fatal("old/falsified empty-image edit reached Router")
	}
}
func TestRealImageEditStillDefersPlannedSourceUntilWorkerBindsActualArtifact(t *testing.T) {
	s, _, g := promptTestService(t, "IMAGE_TO_IMAGE")
	source, target := realImageCapability("TEXT_TO_IMAGE"), realImageCapability("IMAGE_TO_IMAGE")
	g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{source, target}}
	s.WithRealExecution(true)
	nodes := []any{}
	for _, v := range []struct {
		id  string
		cap gateway.Capability
	}{{"source", source}, {"target", target}} {
		nodes = append(nodes, map[string]any{"id": v.id, "type": "rh-image", "data": map[string]any{"capabilityRef": v.cap.Ref, "capabilityVersion": "1", "subType": v.cap.Kind, "params": map[string]any{"prompt": "original " + v.id}, "routerParameters": map[string]any{"count": 1}}})
	}
	graph, _ := json.Marshal(map[string]any{"nodes": nodes, "edges": []any{map[string]any{"source": "source", "target": "target"}}})
	task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "CANVAS", Graph: graph})
	if err != nil {
		t.Fatal(err)
	}
	if len(task.Plans) != 2 || !strings.Contains(string(task.Plans[1].Request), "image_to_image") || !task.Plans[1].PromptRequirements.RequireImage {
		t.Fatal("planned image dependency changed original template/requirements")
	}
}
