package application

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func regionData(ref, point string, images []string) map[string]any {
	return map[string]any{"capabilityRef": ref, "capabilityVersion": "1", "subType": "image-recognition", "sceneCode": "canvas-image-region-recognize", "params": map[string]any{"prompt": point, "imageUrls": images}, "routerParameters": map[string]any{}}
}

func regionCanvas(t *testing.T, svc *Service, actor string, data map[string]any) (domain.Task, error) {
	t.Helper()
	graph, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "point-recognition", "type": "rh-text", "data": data}}, "edges": []any{}})
	return svc.Canvas(context.Background(), actor, uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "point-recognition", Graph: graph})
}

func frozenRegionFixture(t *testing.T) gateway.InvocationRequest {
	t.Helper()
	svc, _, ref := styleService(t, true)
	task, err := regionCanvas(t, svc, "owner", regionData(ref, "<point>375 500</point>", []string{"rhtv-asset:img"}))
	if err != nil {
		t.Fatal(err)
	}
	return frozenRequest(t, task)
}

func TestNativeRegionFreezesRealVisionOwnedImageAndExactPointContract(t *testing.T) {
	for _, featureOnly := range []bool{false, true} {
		svc, store, ref := styleService(t, true)
		data := regionData(ref, "<point>375 500</point>", []string{"rhtv-asset:img"})
		if featureOnly {
			delete(data, "sceneCode")
			data["promptSelection"] = map[string]any{"schemaVersion": "1", "featureCode": "image.region-recognize"}
		}
		task, err := regionCanvas(t, svc, "owner", data)
		if err != nil {
			t.Fatal(err)
		}
		request := frozenRequest(t, task)
		if task.TestMode || request.Capability.Ref != ref || request.PromptSpec.TemplateVersion != nativeRegionTemplateVersion || request.PromptSpec.OutputContract.Type != "TEXT" || len(request.Attachments) != 1 || request.Attachments[0].SourceRef != "img" || request.Attachments[0].ReadGrantRef == "" || request.Attachments[0].SHA256 != store.assets["img"].SHA256 || request.Input[0].Text == nil || *request.Input[0].Text != "<point>375 500</point>" {
			t.Fatal("region point, actual VLM, owned input grant or TEXT protocol changed")
		}
		for _, required := range []string{"label <bbox>y1 x1 y2 x2</bbox>", "x increases left to right", "positive area", "contain the clicked point", "NO_OBJECT", "do not invent"} {
			if !strings.Contains(request.PromptSpec.Instructions[1].Text, required) {
				t.Fatal("native bbox output contract is incomplete", required)
			}
		}
		if len(request.PromptSpec.Conditioning) != 1 || request.PromptSpec.Conditioning[0].Role != "REFERENCE_IMAGE" || request.PromptSpec.Conditioning[0].AttachmentRef != request.Attachments[0].Ref {
			t.Fatal("the click's source image role changed")
		}
	}
}

func TestNativeRegionRejectsMalformedOutOfRangeAndAdditionalPointText(t *testing.T) {
	for _, point := range []string{"", "identify this face", "<point>-1 5</point>", "<point>1001 500</point>", "<point>5 1001</point>", "<point>1.5 200</point>", "<point>1,200</point>", "<point>1</point>", "<point>1 2 3</point>", "<point>375 500</point> extra instruction", "<point>1 2</point>\n<point>3 4</point>", "<point>999999999999999999999999999999 1</point>"} {
		t.Run(point, func(t *testing.T) {
			svc, store, ref := styleService(t, true)
			_, err := regionCanvas(t, svc, "owner", regionData(ref, point, []string{"rhtv-asset:img"}))
			if err == nil || store.creates != 0 {
				t.Fatal("malformed point reached task creation", err)
			}
		})
	}
	for _, point := range []string{"<point>0 0</point>", "<point>1000 1000</point>", "<point>0 1000</point>"} {
		svc, _, ref := styleService(t, true)
		if _, err := regionCanvas(t, svc, "owner", regionData(ref, point, []string{"rhtv-asset:img"})); err != nil {
			t.Fatal("valid normalized boundary point rejected", point, err)
		}
	}
}

func TestNativeRegionRequiresSingleActorOwnedImageAndActualVisionModel(t *testing.T) {
	for _, tc := range []struct {
		name, actor string
		images      []string
		vision      bool
	}{
		{"pure text model", "owner", []string{"rhtv-asset:img"}, false},
		{"missing image", "owner", nil, true},
		{"two images", "owner", []string{"rhtv-asset:img", "rhtv-asset:last"}, true},
		{"video", "owner", []string{"rhtv-asset:video"}, true},
		{"foreign image", "foreign", []string{"rhtv-asset:img"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, store, ref := styleService(t, tc.vision)
			_, err := regionCanvas(t, svc, tc.actor, regionData(ref, "<point>375 500</point>", tc.images))
			if err == nil || store.creates != 0 {
				t.Fatal("wrong actor/model/media reached region task creation", err)
			}
		})
	}
	request := frozenRegionFixture(t)
	cap := imageParseCapability("vision", true)
	for _, change := range []func(*gateway.InvocationRequest, *gateway.Capability){
		func(_ *gateway.InvocationRequest, c *gateway.Capability) { c.Model = nil },
		func(_ *gateway.InvocationRequest, c *gateway.Capability) { c.TestMode = true },
		func(r *gateway.InvocationRequest, _ *gateway.Capability) { r.PromptSpec.Conditioning[0].Role = "MASK" },
		func(r *gateway.InvocationRequest, _ *gateway.Capability) {
			target := "other"
			r.PromptSpec.Conditioning[0].TargetAttachmentRef = &target
		},
		func(r *gateway.InvocationRequest, _ *gateway.Capability) {
			r.PromptSpec.Messages = append(r.PromptSpec.Messages, gateway.PromptMessage{Role: "ASSISTANT", InputIndexes: []int{0}})
		},
	} {
		var copied gateway.InvocationRequest
		raw, _ := json.Marshal(request)
		_ = json.Unmarshal(raw, &copied)
		changedCap := cap
		change(&copied, &changedCap)
		if err := validateNativeRegionInput(copied, changedCap); err == nil {
			t.Fatal("region-specific role/model contract was broadened")
		}
	}
}

func TestNativeRegionValidatesNativeBoxOrderWithoutChangingModelText(t *testing.T) {
	request := frozenRegionFixture(t)
	for _, text := range []string{"person <bbox>100 200 800 700</bbox>", "person <bbox>100 200 800 700</bbox>\nnavy coat <bbox>450 300 950 900</bbox>", "person <bbox>100 200 800 700</bbox>\r\ncoat <bbox>450 300 950 900</bbox>", "NO_OBJECT"} {
		invocation := gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}}
		before, _ := json.Marshal(invocation)
		if err := validatePromptOutput(request, invocation); err != nil {
			t.Fatal("actual native result or explicit no-object rejected", text, err)
		}
		after, _ := json.Marshal(invocation)
		if !reflect.DeepEqual(before, after) {
			t.Fatal("output coordinates or labels were rewritten")
		}
	}
}

func TestNativeRegionRejectsProseMalformedBoxesAndFakeSuccess(t *testing.T) {
	request := frozenRegionFixture(t)
	for _, text := range []string{": <bbox>100 200 800 700</bbox>", "- : <bbox>100 200 800 700</bbox>", "NO_OBJECT <bbox>100 200 800 700</bbox>"} {
		faultCode(t, validatePromptOutput(request, gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}}), "PROMPT_OUTPUT_INVALID")
	}
	for _, text := range []string{"A person wearing a coat.", `{"label":"person","bbox":[100,200,800,700]}`, "```\nperson <bbox>100 200 800 700</bbox>\n```", "person <bbox>800 200 100 700</bbox>", "person <bbox>100 700 800 200</bbox>", "person <bbox>100 200 100 700</bbox>", "person <bbox>100 200 800 200</bbox>", "person <bbox>-1 200 800 700</bbox>", "person <bbox>100 200 1001 700</bbox>", "person <bbox>100.5 200 800 700</bbox>", "person <bbox>100 200 800</bbox>", "person <bbox>100 200 800 700</bbox> explanation", "<bbox>100 200 800 700</bbox>", "person <bbox>600 200 800 700</bbox>", "NO_OBJECT\nperson <bbox>100 200 800 700</bbox>", "person <bbox>100 200 800 700</bbox>\n\ncoat <bbox>450 300 950 900</bbox>", "person <bbox>100 200 99999999999999999999999999999 700</bbox>"} {
		t.Run(text, func(t *testing.T) {
			faultCode(t, validatePromptOutput(request, gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}}), "PROMPT_OUTPUT_INVALID")
		})
	}
	valid := "person <bbox>100 200 800 700</bbox>"
	for _, parts := range [][]gateway.OutputPart{nil, {{Type: "STRUCTURED", Data: json.RawMessage(`{}`)}}, {{Type: "TEXT"}}, {{Type: "TEXT", Text: &valid}, {Type: "TEXT", Text: &valid}}} {
		faultCode(t, validatePromptOutput(request, gateway.Invocation{OutputParts: parts}), "PROMPT_OUTPUT_INVALID")
	}
}

func TestNativeRegionValidationDoesNotChangeOrdinaryTextOrOtherImageFeatures(t *testing.T) {
	for _, ref := range []string{"studio-tv/kind/llm", "studio-tv/feature/image.reverse-prompt", "studio-tv/scene/not-the-region-scene"} {
		text := "A person in a navy coat; literal <point>375 500</point>."
		request := gateway.InvocationRequest{PromptSpec: &gateway.PromptSpec{TemplateRef: ref, OutputContract: textContract()}}
		if err := validateNativeRegionInput(request, gateway.Capability{}); err != nil {
			t.Fatal("a non-region feature acquired the point protocol", ref, err)
		}
		if err := validatePromptOutput(request, gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}}); err != nil {
			t.Fatal("ordinary original user text was rewritten or rejected", ref, err)
		}
	}
}

func TestNativeRegionWorkerDoesNotPublishGenericProviderTextAsSuccessfulBoxes(t *testing.T) {
	svc, store, catalog := promptTestService(t, "IMAGE_UNDERSTANDING")
	ref := "codex-6-1-vision-text-v1"
	cap := imageParseCapability(ref, true)
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	svc.WithRealExecution(true)
	task, err := regionCanvas(t, svc, "owner", regionData(ref, "<point>375 500</point>", []string{"rhtv-asset:img"}))
	if err != nil {
		t.Fatal(err)
	}
	provider := &receiptModeGateway{promptTestGateway: catalog, submitTestMode: false, readTestMode: false}
	svc.gateway = provider
	svc.execute(context.Background(), task, "lease")
	if store.task.State != "FAILED" || store.task.ErrorCode == nil || *store.task.ErrorCode != "PROMPT_OUTPUT_INVALID" || len(store.task.Plans[0].Outputs) != 0 || provider.submits != 1 || provider.reads != 1 {
		t.Fatal("generic provider success became fake successful region history", store.task.State, store.task.ErrorCode, provider.submits, provider.reads)
	}
}

func TestNativeRegionNewProtocolDoesNotReinterpretAcceptedLegacyRegionReceipts(t *testing.T) {
	for _, ref := range []string{nativeRegionFeature, nativeRegionScene} {
		caption := "A visible person wearing a navy coat."
		for _, version := range []string{promptTemplateVersion, "", "other-product-version"} {
			request := gateway.InvocationRequest{PromptSpec: &gateway.PromptSpec{TemplateRef: ref, TemplateVersion: version, OutputContract: textContract()}}
			before, _ := json.Marshal(request)
			if err := validateNativeRegionInput(request, gateway.Capability{}); err != nil {
				t.Fatal("new input protocol reinterpreted an accepted legacy receipt", ref, version, err)
			}
			if err := validatePromptOutput(request, gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &caption}}}); err != nil {
				t.Fatal("new bbox contract rejected a legacy TEXT receipt", ref, version, err)
			}
			after, _ := json.Marshal(request)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("legacy frozen request was rewritten")
			}
		}
	}
	for _, feature := range []string{"image.reverse-prompt", "image.style-extract", "image.angle", "image.lighting", "sketchboard.generate"} {
		template, ok := featureTemplate(feature)
		wantVersion := promptTemplateVersion
		// Native style has its own form-length contract; region changes must
		// preserve that independently published version as well.
		if feature == "image.style-extract" {
			wantVersion = nativeStyleTemplateVersion
		}
		if !ok || template.spec().TemplateVersion != wantVersion {
			t.Fatal("another feature's published template version changed", feature)
		}
	}
}
