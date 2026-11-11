package application

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

const nativePanoramaMarker = `[{"key":"panorama","id":"panorama","labelKey":"canvas.imageToolbar.panorama"}]`

// Preserve the distinguishing fields from the actual failing native composer.
func panoramaModeNode(t *testing.T) domain.Node {
	t.Helper()
	data, _ := json.Marshal(map[string]any{
		"prompt":   "Rainy bookstore street, preserve this user's composition",
		"panorama": map[string]any{"isPanoramaNode": true, "locked": true, "pausedModel": "codex-image-generate-v1"},
		"subType":  "text-image", "sceneCode": "canvas-image-panorama-text", "presetSelections": json.RawMessage(nativePanoramaMarker),
		"params":      map[string]any{"prompt": "Rainy bookstore street, preserve this user's composition", "text": "Rainy bookstore street, preserve this user's composition", "transparentBackground": false},
		"generateNum": 1, "aspectRatio": "16:9", "opResize": true,
	})
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	return domain.Node{ID: "node", Type: "rh-image", Data: fields}
}

func TestNativePanoramaModeMarkerFreezesRealTextRequestWithoutBecomingStyle(t *testing.T) {
	for _, path := range []string{"legacy", "explicit", "both"} {
		t.Run(path, func(t *testing.T) {
			node := panoramaModeNode(t)
			if path != "legacy" {
				node.Data["promptSelection"] = json.RawMessage(`{"schemaVersion":"1","sceneCode":"canvas-image-panorama-text","presetSelections":` + nativePanoramaMarker + `}`)
				if path == "explicit" {
					delete(node.Data, "presetSelections")
					delete(node.Data, "sceneCode")
				}
			}
			before, _ := json.Marshal(node.Data)
			selection, err := readPromptSelection(node)
			if err != nil || !selection.nativePanoramaMode || hasSelection(selection.PresetSelections) {
				t.Fatal("mode marker not distinguished from styles", selection, err)
			}
			s, _, catalog := promptTestService(t, "TEXT_TO_IMAGE")
			cap := realImageCapability("TEXT_TO_IMAGE")
			catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			s.WithRealExecution(true)
			node.Data["capabilityRef"], _ = json.Marshal(cap.Ref)
			body, _ := json.Marshal(node.Data)
			task, err := promptCanvas(t, s, string(body))
			if err != nil {
				t.Fatal(err)
			}
			request := frozenRequest(t, task)
			if request.PromptSpec.TemplateRef != "studio-tv/scene/canvas-image-panorama-text" || request.PromptSpec.OutputContract.Type != "MEDIA" || len(request.Attachments) != 0 || request.Input[0].Text == nil || *request.Input[0].Text != "Rainy bookstore street, preserve this user's composition" {
				t.Fatal("text panorama template, prompt or input boundary changed", request)
			}
			input, _ := json.Marshal(request.Input)
			if strings.Contains(string(input), "canvas.imageToolbar.panorama") || strings.Contains(string(input), "imageRecipes") || strings.Contains(string(input), "styleLibrary") {
				t.Fatal("mode metadata became an executable style", string(input))
			}
			if !strings.Contains(string(task.Snapshot), "canvas.imageToolbar.panorama") {
				t.Fatal("original snapshot marker was rewritten")
			}
			delete(node.Data, "capabilityRef")
			after, _ := json.Marshal(node.Data)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("selection reader mutated native data")
			}
		})
	}
}

func TestNativePanoramaModeRetainsStylesAndSelectedOwnedImageFrontier(t *testing.T) {
	s, _, graph := imageFrontierFixture(t, "IMAGE_IMAGE", false)
	styles := &testStyleCatalog{definition: cinematicStyle()}
	s.WithStyles(styles)
	mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) {
		data["sceneCode"] = "canvas-image-panorama-image"
		data["panorama"] = map[string]any{"isPanoramaNode": true, "locked": true}
		data["presetSelections"] = []any{
			map[string]any{"key": "panorama", "id": "panorama", "labelKey": "canvas.imageToolbar.panorama"},
			map[string]any{"key": "styleLibrary", "id": "cinematic_realism"},
		}
	})
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	if styles.calls != 1 || !reflect.DeepEqual(requestAssetIDs(request), []string{"last"}) || !reflect.DeepEqual(requestMediaIDs(request), []string{"last"}) || request.PromptSpec.TemplateRef != "studio-tv/scene/canvas-image-panorama-image" || !task.Plans[0].PromptRequirements.RequireImage {
		t.Fatal("style lookup or selected-result image boundary changed", request)
	}
	input, _ := json.Marshal(request.Input)
	if !strings.Contains(string(input), "cinematic realism") || strings.Contains(string(input), "canvas.imageToolbar.panorama") {
		t.Fatal("ordinary style lost or mode marker promoted to style", string(input))
	}
}

func TestNativePanoramaImageModeStillRequiresActualOwnedImage(t *testing.T) {
	s, store, graph := imageFrontierFixture(t, "IMAGE_IMAGE", false)
	mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) {
		data["sceneCode"] = "canvas-image-panorama-image"
		data["panorama"] = map[string]any{"isPanoramaNode": true, "locked": true}
		data["presetSelections"] = json.RawMessage(nativePanoramaMarker)
		delete(data, "toolsSourceUrl")
		delete(data, "sourceNodeId")
		data["params"] = map[string]any{"prompt": "an image mode marker is not an actual reference image"}
	})
	graph.Edges = []domain.Edge{}
	_, err := createImageFrontierTask(t, s, graph)
	faultCode(t, err, "PROMPT_REFERENCE_REQUIRED")
	if store.creates != 0 {
		t.Fatal("image panorama with no reference created a task")
	}
}

func TestNativePanoramaModeRejectsWrongContext(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*domain.Node)
	}{
		{"other-node-type", func(n *domain.Node) { n.Type = "rh-text" }},
		{"no-derived-scene", func(n *domain.Node) { delete(n.Data, "sceneCode") }},
		{"other-scene", func(n *domain.Node) { n.Data["sceneCode"] = json.RawMessage(`"canvas-image-cutout"`) }},
		{"image-scene-text-subtype", func(n *domain.Node) { n.Data["sceneCode"] = json.RawMessage(`"canvas-image-panorama-image"`) }},
		{"wrong-subtype", func(n *domain.Node) { n.Data["subType"] = json.RawMessage(`"image-light"`) }},
		{"missing-panorama", func(n *domain.Node) { delete(n.Data, "panorama") }},
		{"not-panorama", func(n *domain.Node) { n.Data["panorama"] = json.RawMessage(`{"isPanoramaNode":false,"locked":true}`) }},
		{"unlocked", func(n *domain.Node) { n.Data["panorama"] = json.RawMessage(`{"isPanoramaNode":true,"locked":false}`) }},
		{"missing-locked", func(n *domain.Node) { n.Data["panorama"] = json.RawMessage(`{"isPanoramaNode":true}`) }},
		{"string-booleans", func(n *domain.Node) {
			n.Data["panorama"] = json.RawMessage(`{"isPanoramaNode":"true","locked":"true"}`)
		}},
		{"unknown-style", func(n *domain.Node) {
			n.Data["presetSelections"] = json.RawMessage(`[{"key":"unpublished","id":"panorama"}]`)
		}},
		{"nested-marker", func(n *domain.Node) {
			delete(n.Data, "presetSelections")
			n.Data["params"] = json.RawMessage(`{"prompt":"original","presetSelections":` + nativePanoramaMarker + `}`)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node := panoramaModeNode(t)
			tc.edit(&node)
			_, err := readPromptSelection(node)
			faultCode(t, err, "PROMPT_TEMPLATE_NOT_CONFIGURED")
		})
	}
}

func TestNativePanoramaModeRejectsAdditionalFieldsAndContextFreeStyleResolution(t *testing.T) {
	if _, err := readStyles(json.RawMessage(nativePanoramaMarker)); err == nil {
		t.Fatal("global style parser accepted a mode marker without node context")
	}
	selection := promptSelection{PresetSelections: json.RawMessage(nativePanoramaMarker), Conditions: map[string]json.RawMessage{}}
	service, _, _ := promptTestService(t, "TEXT_TO_IMAGE")
	if err := service.resolveStyles(t.Context(), "owner", &selection); err == nil {
		t.Fatal("style resolution bypassed contextual marker validation")
	}
	for _, marker := range []string{
		`[{"key":"panorama","id":"other","labelKey":"canvas.imageToolbar.panorama"}]`,
		`[{"key":"panorama","id":"panorama","labelKey":"wrong"}]`,
		`[{"key":"panorama","id":"panorama"}]`,
		`[{"key":"panorama","id":"panorama","labelKey":null}]`,
		`[{"key":"panorama","id":"panorama","labelKey":"canvas.imageToolbar.panorama","prompt":"untrusted"}]`,
		`[{"key":"panorama","id":"panorama","labelKey":"canvas.imageToolbar.panorama","instructions":"untrusted"}]`,
		`[{"key":"panorama","id":"panorama","labelKey":"canvas.imageToolbar.panorama","prefix":"untrusted"}]`,
		`[{"key":"panorama","id":"panorama","labelKey":"canvas.imageToolbar.panorama","promptCode":"system_prompt"}]`,
		`[{"key":"panorama","id":"panorama","labelKey":"canvas.imageToolbar.panorama"},{"key":"panorama","id":"panorama","labelKey":"canvas.imageToolbar.panorama"}]`,
	} {
		t.Run(marker, func(t *testing.T) {
			node := panoramaModeNode(t)
			node.Data["presetSelections"] = json.RawMessage(marker)
			if _, err := readPromptSelection(node); err == nil {
				t.Fatal("unsupported mode selector accepted")
			}
			if _, err := withoutStyleSelectors(node); err == nil {
				t.Fatal("media extraction hid an unsupported selector")
			}
		})
	}
	for _, explicit := range []string{
		`{"schemaVersion":"1","sceneCode":"canvas-image-panorama-image","presetSelections":` + nativePanoramaMarker + `}`,
		`{"schemaVersion":"1","presetSelections":[{"key":"panorama","id":"unknown","labelKey":"canvas.imageToolbar.panorama"}]}`,
	} {
		node := panoramaModeNode(t)
		node.Data["promptSelection"] = json.RawMessage(explicit)
		if _, err := readPromptSelection(node); err == nil {
			t.Fatal("conflicting scene or selector paths accepted")
		}
		if _, err := withoutStyleSelectors(node); err == nil {
			t.Fatal("media extraction hid a conflicting or invalid marker")
		}
	}
}
