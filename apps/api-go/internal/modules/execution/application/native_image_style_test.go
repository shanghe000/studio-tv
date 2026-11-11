package application

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"reflect"
	"strings"
	"testing"
)

func styleData(ref string) map[string]any {
	return map[string]any{
		"subType": "LLM", "capabilityRef": ref, "capabilityVersion": "1", "routerParameters": map[string]any{},
		"params":          map[string]any{"prompt": nativeStyleMarker, "imageUrls": []string{"rhtv-asset:img"}},
		"promptSelection": map[string]any{"schemaVersion": "1", "featureCode": "image.style-extract", "conditions": map[string]any{"requestedModelCode": nativeStyleAlias}, "messages": []any{map[string]any{"role": "USER", "text": nativeStyleMarker, "assetIds": []string{"img"}}}},
	}
}
func styleCanvas(t *testing.T, s *Service, data map[string]any) (domain.Task, error) {
	t.Helper()
	graph, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "style", "type": "rh-text", "data": data}}, "edges": []any{}})
	return s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "style", Graph: graph})
}
func styleService(t *testing.T, vision bool) (*Service, *promptTestStore, string) {
	t.Helper()
	s, store, g := promptTestService(t, "IMAGE_UNDERSTANDING")
	ref := "codex-6-1-vision-text-v1"
	cap := imageParseCapability(ref, vision)
	cap.InputKinds = append(cap.InputKinds, "VIDEO")
	g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	s.WithRealExecution(true)
	return s, store, ref
}
func TestNativeStyleExtractFreezesSingleOwnedImageAndOriginalTemplate(t *testing.T) {
	s, store, ref := styleService(t, true)
	task, err := styleCanvas(t, s, styleData(ref))
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	original, _ := featureTemplate("image.style-extract")
	want := original.spec()
	if request.Capability.Ref != ref || request.Capability.Version != "1" || task.TestMode || request.PromptSpec.TemplateSHA256 != want.TemplateSHA256 || request.PromptSpec.TemplateVersion != want.TemplateVersion || !reflect.DeepEqual(request.PromptSpec.Instructions, want.Instructions) || !reflect.DeepEqual(request.PromptSpec.OutputContract, want.OutputContract) {
		t.Fatal("selected vision, authored template or TEXT contract changed")
	}
	if len(request.Attachments) != 1 || request.Attachments[0].SourceRef != "img" || request.Attachments[0].Kind != "IMAGE" || request.Attachments[0].ReadGrantRef == "" || request.Attachments[0].SourceVersion != store.assets["img"].Version || request.Attachments[0].SHA256 != store.assets["img"].SHA256 {
		t.Fatal("owned image grant/version/hash lost")
	}
	if request.PromptSpec.Messages[0].Role != "USER" || len(request.PromptSpec.Messages[0].InputIndexes) != 2 || request.Input[0].Text == nil || *request.Input[0].Text != nativeStyleMarker || request.Input[1].Type != "MEDIA" {
		t.Fatal("native marker/image are not USER data")
	}
}
func TestNativeStyleExtractRejectsSpoofedSelection(t *testing.T) {
	cases := []struct {
		name string
		edit func(map[string]any)
	}{
		{"unknown alias", func(p map[string]any) { p["conditions"].(map[string]any)["requestedModelCode"] = "unknown_style" }},
		{"other feature", func(p map[string]any) { p["featureCode"] = "llm.invoke" }},
		{"scene override", func(p map[string]any) { p["sceneCode"] = "storyboard-prompt-film" }},
		{"wrong marker", func(p map[string]any) { p["messages"].([]any)[0].(map[string]any)["text"] = "arbitrary task" }},
		{"assistant", func(p map[string]any) { p["messages"].([]any)[0].(map[string]any)["role"] = "ASSISTANT" }},
		{"no image", func(p map[string]any) { p["messages"].([]any)[0].(map[string]any)["assetIds"] = []string{} }},
		{"multiple images", func(p map[string]any) {
			p["messages"].([]any)[0].(map[string]any)["assetIds"] = []string{"img", "last"}
		}},
		{"more messages", func(p map[string]any) {
			p["messages"] = append(p["messages"].([]any), map[string]any{"role": "USER", "text": "extra"})
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, store, ref := styleService(t, true)
			data := styleData(ref)
			c.edit(data["promptSelection"].(map[string]any))
			_, err := styleCanvas(t, s, data)
			faultCode(t, err, "PROMPT_SPEC_INVALID")
			if store.creates != 0 {
				t.Fatal("rejected style created task")
			}
		})
	}
}
func TestNativeStyleExtractChecksActualKindsAdditionalInputsAndOwner(t *testing.T) {
	for _, c := range []struct {
		name   string
		refs   []string
		vision bool
	}{
		{"pure text profile", []string{"img"}, false},
		{"declared image is VIDEO", []string{"video"}, true},
		{"mixed VIDEO", []string{"img", "video"}, true},
		{"extra IMAGE", []string{"img", "last"}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, store, ref := styleService(t, c.vision)
			data := styleData(ref)
			refs := []string{}
			for _, id := range c.refs {
				refs = append(refs, "rhtv-asset:"+id)
			}
			data["params"].(map[string]any)["imageUrls"] = refs
			if len(c.refs) == 2 && c.refs[1] == "video" {
				data["params"].(map[string]any)["imageUrls"] = []string{"rhtv-asset:img"}
				data["params"].(map[string]any)["videoUrls"] = []string{"rhtv-asset:video"}
			}
			if len(c.refs) == 1 {
				data["promptSelection"].(map[string]any)["messages"].([]any)[0].(map[string]any)["assetIds"] = c.refs
			}
			_, err := styleCanvas(t, s, data)
			want := "PROMPT_CAPABILITY_MISMATCH"
			if len(c.refs) == 1 && c.refs[0] == "video" {
				want = "PROMPT_CONDITIONING_INVALID"
			}
			faultCode(t, err, want)
			if store.creates != 0 {
				t.Fatal("wrong input created task")
			}
		})
	}
	t.Run("outside owner store", func(t *testing.T) {
		s, store, ref := styleService(t, true)
		delete(store.assets, "img")
		_, err := styleCanvas(t, s, styleData(ref))
		if !errors.Is(err, domain.ErrNotFound) || store.creates != 0 {
			t.Fatalf("unauthorized asset accepted: %v", err)
		}
	})
}
func TestNativeStyleExtractRejectsWrongOutputProtocol(t *testing.T) {
	template, _ := featureTemplate("image.style-extract")
	request := gateway.InvocationRequest{PromptSpec: template.spec()}
	description := "soft warm light, abstract illustration"
	object := string(json.RawMessage{123, 125})
	empty := " "
	for _, parts := range [][]gateway.OutputPart{{}, {{Type: "TEXT", Text: &empty}}, {{Type: "TEXT", Text: &object}}, {{Type: "STRUCTURED", Data: json.RawMessage(object)}}, {{Type: "TEXT", Text: &description}, {Type: "TEXT", Text: &description}}} {
		faultCode(t, validatePromptOutput(request, gateway.Invocation{OutputParts: parts}), "PROMPT_OUTPUT_INVALID")
	}
	if err := validatePromptOutput(request, gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &description}}}); err != nil {
		t.Fatal(err)
	}
}

func TestNativeStyleCurrentTemplateBoundsNativeFormUTF16AndKeepsHistoricalOutput(t *testing.T) {
	template, _ := featureTemplate("image.style-extract")
	request := gateway.InvocationRequest{PromptSpec: template.spec()}
	if request.PromptSpec.TemplateVersion != nativeStyleTemplateVersion || !strings.Contains(template.task, "450 UTF-16") || !strings.Contains(template.task, "reusable principles") || !strings.Contains(template.task, "particular objects or scenery") {
		t.Fatal("native style output limit not frozen in versioned instructions")
	}
	for _, tc := range []struct {
		name, value string
		valid       bool
	}{
		{"ascii500", strings.Repeat("a", 500), true}, {"ascii501", strings.Repeat("a", 501), false},
		{"cjk500", strings.Repeat("风", 500), true}, {"cjk501", strings.Repeat("风", 501), false},
		{"emoji250", strings.Repeat("😀", 250), true}, {"emoji251", strings.Repeat("😀", 251), false},
		{"actual969", strings.Repeat("x", 969), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := tc.value
			invocation := gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &value}}}
			err := validateNativeStyleOutput(request, invocation)
			if (err == nil) != tc.valid {
				t.Fatalf("unexpected output validity: %v", err)
			}
			historical := request
			spec := *request.PromptSpec
			spec.TemplateVersion = "studio-authored-1"
			historical.PromptSpec = &spec
			if err := validateNativeStyleOutput(historical, invocation); err != nil {
				t.Fatalf("historical stored style changed: %v", err)
			}
		})
	}
}
