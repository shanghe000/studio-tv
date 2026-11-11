package application

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

// The native image toolbar creates a multimodal text node, not a grounding
// request. Its visible prompt remains user data and its result remains TEXT.
func TestImageParseKeepsNativePromptOwnedImageAndTextContract(t *testing.T) {
	for _, ref := range []string{"codex-6-vision-text-v1", "codex-6-1-vision-text-v1"} {
		t.Run(ref, func(t *testing.T) {
			s, store, catalog := promptTestService(t, "IMAGE_UNDERSTANDING")
			cap := imageParseCapability(ref, true)
			catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			s.WithRealExecution(true)
			prompt := "<role>你是参考图片解析助手。</role>\n<output_format>正向提示词：英文描述\n负向提示词：英文风险</output_format>"
			data := map[string]any{
				"subType": "multimodal-text", "textModelListType": "MULTIMODAL_TEXT",
				"modelType": "LLM", "modelCode": ref, "capabilityRef": ref, "capabilityVersion": "1",
				"hidePromptInput": true, "generateNum": 1, "routerParameters": map[string]any{},
				"params": map[string]any{"prompt": prompt, "imageUrls": []string{"rhtv-asset:img"}},
			}
			graph, _ := json.Marshal(map[string]any{
				"nodes": []any{
					map[string]any{"id": "source", "type": "rh-image", "data": map[string]any{"imageUrl": "rhtv-asset:img"}},
					map[string]any{"id": "parse", "type": "rh-text", "data": data},
				},
				"edges": []any{map[string]any{"source": "source", "target": "parse"}},
			})
			task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "parse", Graph: graph})
			if err != nil {
				t.Fatal(err)
			}
			req := frozenRequest(t, task)
			if task.TestMode || task.Plans[0].TestMode || req.Capability.Ref != ref || req.Capability.Version != "1" {
				t.Fatal("selected real vision profile was changed")
			}
			original, _ := defaultTemplate("LLM")
			expected := original.spec()
			if req.PromptSpec.TemplateRef != expected.TemplateRef || req.PromptSpec.TemplateVersion != "studio-authored-1" || req.PromptSpec.TemplateSHA256 != expected.TemplateSHA256 || !reflect.DeepEqual(req.PromptSpec.Instructions, expected.Instructions) || !reflect.DeepEqual(req.PromptSpec.OutputContract, expected.OutputContract) {
				t.Fatal("vision routing changed the authored instructions or TEXT contract")
			}
			if len(req.Input) != 2 || req.Input[0].Type != "TEXT" || req.Input[0].Text == nil || *req.Input[0].Text != prompt || req.Input[1].Type != "MEDIA" || len(req.PromptSpec.Messages) != 1 || req.PromptSpec.Messages[0].Role != "USER" || !reflect.DeepEqual(req.PromptSpec.Messages[0].InputIndexes, []int{0, 1}) {
				t.Fatal("native visible prompt and source image were not preserved as user data")
			}
			if len(req.Attachments) != 1 || req.Attachments[0].SourceRef != "img" || req.Attachments[0].SourceVersion != store.assets["img"].Version || req.Attachments[0].SHA256 != store.assets["img"].SHA256 || req.Attachments[0].ReadGrantRef == "" || *req.Input[1].AttachmentRef != req.Attachments[0].Ref {
				t.Fatal("owned source image was lost, duplicated, or not frozen")
			}
			if len(req.PromptSpec.Conditioning) != 1 || req.PromptSpec.Conditioning[0].Role != "REFERENCE_IMAGE" || req.PromptSpec.Conditioning[0].AttachmentRef != req.Attachments[0].Ref || string(req.Parameters) != "{}" || req.ParameterSchemaVersion != "1" {
				t.Fatal("image role or trusted empty parameter schema was changed")
			}
		})
	}
}

func TestImageParseRejectsPureTextProfilesAndMissingImage(t *testing.T) {
	for _, test := range []struct {
		ref, image, fault string
		vision            bool
	}{
		{"codex-5-6-text-v1", `,"imageUrls":["rhtv-asset:img"]`, "PROMPT_CAPABILITY_MISMATCH", false},
		{"codex-6-1-text-v1", `,"imageUrls":["rhtv-asset:img"]`, "PROMPT_CAPABILITY_MISMATCH", false},
		{"codex-6-1-vision-text-v1", "", "PROMPT_REFERENCE_REQUIRED", true},
	} {
		t.Run(test.ref, func(t *testing.T) {
			s, store, catalog := promptTestService(t, "LLM")
			catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{imageParseCapability(test.ref, test.vision)}}
			s.WithRealExecution(true)
			_, err := promptCanvas(t, s, `{"subType":"multimodal-text","capabilityRef":"`+test.ref+`","params":{"prompt":"解析图片"`+test.image+`}}`)
			faultCode(t, err, test.fault)
			if store.creates != 0 {
				t.Fatal("unsupported image request created a task")
			}
		})
	}
}

func TestImageParseBackendDoesNotGuessUnknownNativeModel(t *testing.T) {
	s, store, catalog := promptTestService(t, "IMAGE_UNDERSTANDING")
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{imageParseCapability("codex-6-1-vision-text-v1", true)}}
	s.WithRealExecution(true)
	graph := json.RawMessage(`{"nodes":[{"id":"parse","type":"rh-text","data":{"subType":"multimodal-text","modelCode":"llm-haimaflash-multimadal-text","params":{"prompt":"解析图片","imageUrls":["rhtv-asset:img"]}}}],"edges":[]}`)
	_, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "parse", Graph: graph})
	if !errors.Is(err, domain.ErrInvalid) || store.creates != 0 {
		t.Fatalf("unknown native label silently routed: %v", err)
	}
}

func imageParseCapability(ref string, vision bool) gateway.Capability {
	kind := "LLM"
	inputs := []string{"TEXT", "STRUCTURED"}
	if vision {
		kind = "IMAGE_UNDERSTANDING"
		inputs = append(inputs, "IMAGE")
	}
	cap := promptCapability(ref, kind)
	cap.TestMode, cap.ExecutionKind = false, "AGENT"
	cap.InputKinds, cap.OutputKinds = inputs, []string{"TEXT"}
	cap.Model = &gateway.ModelDescriptor{ProviderRef: "codex", ModelRef: ref, Title: "Configured Codex", Version: "6.1"}
	return cap
}
