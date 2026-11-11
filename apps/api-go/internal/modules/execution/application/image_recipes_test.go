package application

import (
	"context"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/principal"
	"strings"
	"testing"
)

func TestImageRecipesFreezePublishedAndStudioRoleDefinitionsAsUserConditions(t *testing.T) {
	for _, def := range PublishedImagePresets() {
		t.Run(def.ID, func(t *testing.T) {
			raw, _ := json.Marshal([]StyleDefinition{def})
			data := map[string]json.RawMessage{"presetSelections": raw}
			if def.PromptCode != "" {
				data["promptCodes"], _ = json.Marshal([]string{def.PromptCode})
			}
			selection, err := readPromptSelection(domain.Node{Type: "rh-image", Data: data})
			if err != nil {
				t.Fatal(err)
			}
			svc := &Service{}
			if err = svc.resolveStyles(context.Background(), "owner", &selection); err != nil {
				t.Fatal(err)
			}
			var got []StyleDefinition
			if err = json.Unmarshal(selection.Conditions["imageRecipes"], &got); err != nil || len(got) != 1 || got[0] != def {
				t.Fatalf("unfrozen recipe: %s %v", selection.Conditions["imageRecipes"], err)
			}
		})
	}
}
func TestCodeOnlyNativePresetRequiresPublishedKeyAndCode(t *testing.T) {
	for _, tc := range []struct {
		key, code string
		ok        bool
	}{
		{"age", "studio-portrait-930-v1", true}, {"roleDesign:face:expression", "studio-role-face-smile-v1", true},
		{"age", "studio-portrait-age-v1", false}, {"makeup", "studio-portrait-930-v1", false},
	} {
		input, err := json.Marshal([]map[string]string{{"key": tc.key, "promptCode": tc.code}})
		if err != nil {
			t.Fatal(err)
		}
		rows, err := readStyles(input)
		if (err == nil) != tc.ok || tc.ok && (len(rows) != 1 || rows[0].ID != tc.code) {
			t.Fatalf("%s/%s: %v, %v", tc.key, tc.code, rows, err)
		}
	}
}

func TestImageRecipeRejectsUnknownHiddenCodeStaleAndTamperedText(t *testing.T) {
	def, _ := PublishedImagePreset("filter", "kodak_film")
	for _, test := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"prompt", func(v map[string]any) { v["prompt"] = "different" }},
		{"revision", func(v map[string]any) { v["revision"] = 2 }},
		{"hidden", func(v map[string]any) { v["promptCode"] = "system_prompt_2137" }},
		{"role-as-filter", func(v map[string]any) { v["id"] = "studio-role-basic-woman-v1" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			b, _ := json.Marshal(def)
			var v map[string]any
			_ = json.Unmarshal(b, &v)
			test.change(v)
			raw, _ := json.Marshal([]any{v})
			s, err := readPromptSelection(domain.Node{Data: map[string]json.RawMessage{"presetSelections": raw}})
			if err == nil {
				err = (&Service{}).resolveStyles(context.Background(), "owner", &s)
			}
			if err == nil {
				t.Fatal("untrusted recipe accepted")
			}
		})
	}
}
func TestImageRecipeCameraExemptionIsOnlyRootUIIdentifier(t *testing.T) {
	for _, body := range []string{`{"cameraControl":{"presetId":"default","chunk":"50mm","selection":{"cameraId":"test"}}}`, `{"cameraControl":{"presetId":"my-local-camera"}}`} {
		var data map[string]json.RawMessage
		_ = json.Unmarshal([]byte(body), &data)
		s, err := readPromptSelection(domain.Node{Data: data})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(s.Conditions["cameraControl"]), "presetId") {
			t.Fatal("lost camera user data")
		}
	}
	for _, body := range []string{`{"params":{"presetId":"default"}}`, `{"cameraControl":{"selection":{"presetId":"hidden"}}}`, `{"cameraControl":{"system":"malicious"}}`} {
		var data map[string]json.RawMessage
		_ = json.Unmarshal([]byte(body), &data)
		if _, err := readPromptSelection(domain.Node{Data: data}); err == nil {
			t.Fatal("broadened camera exemption")
		}
	}
}
func TestImageRecipeOwnerDefinitionsFrozenAndRevisionChecked(t *testing.T) {
	def := StyleDefinition{SchemaVersion: "1", Revision: 3, Key: "customPrompt", ID: "own", Label: "Mine", Prompt: "prefix\nsuffix", PrefixPrompt: "prefix", SuffixPrompt: "suffix", PromptType: "PROMPT"}
	svc := &Service{}
	svc.WithStyles(&testStyleCatalog{definition: def})
	for _, owner := range []string{"owner", "foreign"} {
		raw, _ := json.Marshal([]any{map[string]any{"key": "customPrompt", "id": "own", "revision": 3}})
		s := promptSelection{PresetSelections: raw, Conditions: map[string]json.RawMessage{}}
		err := svc.resolveStyles(context.Background(), owner, &s)
		if (err == nil) != (owner == "owner") {
			t.Fatal(owner, err)
		}
	}
	raw := json.RawMessage(`[{"key":"customPrompt","id":"own","revision":2}]`)
	if err := svc.resolveStyles(context.Background(), "owner", &promptSelection{PresetSelections: raw, Conditions: map[string]json.RawMessage{}}); !errors.Is(err, domain.ErrConflict) {
		t.Fatal(err)
	}
}
func TestImageRecipeToolTypeOverridesGenericSubtype(t *testing.T) {
	for tool, feature := range map[string]string{"IMAGE_MULTIANGLE": "image.angle", "IMAGE_MULTI_ANGLE": "image.angle", "IMAGE_LIGHT": "image.lighting", "IMAGE_MULTI_ANGLE_LIGHT": "image.lighting", "IMAGE_CUTOUT_TEXT": "image.remove-text", "image-multiangle": "image.angle", "image-multi-angle": "image.angle", "image-light": "image.lighting", "image-multi-angle-light": "image.lighting", "image-cutout-text": "image.remove-text", "image-redraw": "image.repaint", "image-enhance": "image.enhance"} {
		raw, _ := json.Marshal(tool)
		s, err := readPromptSelection(domain.Node{Data: map[string]json.RawMessage{"toolsType": raw, "subType": json.RawMessage(`"IMAGE_IMAGE"`)}})
		if err != nil || s.FeatureCode != feature {
			t.Fatal(tool, err)
		}
		template, err := selectTemplate(s, "IMAGE_TO_IMAGE")
		if err != nil || !template.requiresImage || template.output.Type != "MEDIA" {
			t.Fatal(err)
		}
	}
}

func TestImageRecipeAdvertisedAngleAndLightAliasesFreezeSpecificControls(t *testing.T) {
	for _, tc := range []struct {
		tool, feature, controls string
	}{
		{"image-multi-angle", "image.angle", `"horizontal_angle":270,"vertical_angle":-15,"zoom":1.7`},
		{"image-multi-angle-light", "image.lighting", `"light_azimuth":120,"light_elevation":45,"light_intensity":75,"light_color_hex":"#23ABEF"`},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			svc, _, _ := promptTestService(t, "IMAGE_TO_IMAGE")
			task, err := promptCanvas(t, svc, `{"capabilityRef":"mock","subType":"image-image","toolsType":"`+tc.tool+`","params":{"prompt":"preserve this person's identity","imageUrls":["rhtv-asset:img"],`+tc.controls+`},"routerParameters":{}}`)
			if err != nil {
				t.Fatal(err)
			}
			request := frozenRequest(t, task)
			template, _ := featureTemplate(tc.feature)
			if request.PromptSpec.TemplateSHA256 != template.spec().TemplateSHA256 || len(request.PromptSpec.Conditioning) != 1 || request.PromptSpec.Conditioning[0].Role != "REFERENCE_IMAGE" {
				t.Fatal("advertised alias did not freeze its specific semantic editor and source image")
			}
			var expected map[string]any
			if err := json.Unmarshal([]byte(`{`+tc.controls+`}`), &expected); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, part := range request.Input {
				if len(part.Data) == 0 {
					continue
				}
				var envelope struct {
					SchemaCode string `json:"schemaCode"`
					Conditions struct {
						NativeParameters map[string]any `json:"nativeParameters"`
					} `json:"conditions"`
				}
				if json.Unmarshal(part.Data, &envelope) != nil || envelope.SchemaCode != "STUDIO_PROMPT_CONDITIONS_V1" {
					continue
				}
				found = true
				for key, value := range expected {
					if envelope.Conditions.NativeParameters[key] != value {
						t.Fatalf("lost semantic control %s", key)
					}
				}
			}
			if !found || string(request.Parameters) != "{}" || request.Input[0].Text == nil || *request.Input[0].Text != "preserve this person's identity" {
				t.Fatal("semantic controls bypassed their USER condition boundary or changed the original prompt")
			}
		})
	}
}

func TestImageRecipeMaskGuideTargetIsAnExistingImageAttachment(t *testing.T) {
	for _, target := range []string{"original", "missing", "guide", "video"} {
		t.Run(target, func(t *testing.T) {
			request := gateway.InvocationRequest{PromptSpec: &gateway.PromptSpec{}, Attachments: []gateway.Attachment{{Ref: "attachment-original", SourceRef: "original", Kind: "IMAGE"}, {Ref: "attachment-guide", SourceRef: "guide", Kind: "IMAGE"}, {Ref: "attachment-video", SourceRef: "video", Kind: "VIDEO"}}}
			selection := promptSelection{ReferenceBindings: []referenceBinding{{AssetID: "guide", Role: "MASK", TargetAssetID: target}}}
			err := setConditioning(&request, selection, domain.Node{Data: map[string]json.RawMessage{}})
			if target != "original" {
				if err == nil {
					t.Fatal("invalid mask guide target accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := request.PromptSpec.Conditioning[0]
			if got.TargetAttachmentRef == nil || *got.TargetAttachmentRef != "attachment-original" || got.AttachmentRef != "attachment-guide" || got.Role != "MASK" {
				t.Fatal(got)
			}
		})
	}
}
func TestImageRecipeEditScenesAcceptSemanticImageModel(t *testing.T) {
	for _, scene := range []string{"canvas-image-cutout", "canvas-image-erase", "canvas-image-expand"} {
		template, err := selectTemplate(promptSelection{SceneCode: scene}, "IMAGE_TO_IMAGE")
		if err != nil || !template.requiresImage || template.output.Type != "MEDIA" {
			t.Fatal(scene, err)
		}
	}
	template, err := selectTemplate(promptSelection{FeatureCode: "image.repaint"}, "IMAGE_TO_IMAGE")
	if err != nil || !strings.Contains(template.task, "semantic") {
		t.Fatal(err)
	}
}

func TestImageRecipeNativeGuideUsesUniqueSourceAndNeverGuesses(t *testing.T) {
	for _, tool := range []string{"IMAGE_REDRAW", "IMAGE_ERASE", "IMAGE_EXPAND"} {
		for _, extra := range []bool{false, true} {
			request := gateway.InvocationRequest{PromptSpec: &gateway.PromptSpec{}, Attachments: []gateway.Attachment{{Ref: "ref-source", SourceRef: "source", Kind: "IMAGE"}, {Ref: "ref-guide", SourceRef: "guide", Kind: "IMAGE"}}}
			request.Capability.Ref = "codex-image-edit-v1"
			request.Capability.Version = "3"
			if extra {
				request.Attachments = append(request.Attachments, gateway.Attachment{Ref: "ref-other", SourceRef: "other", Kind: "IMAGE"})
			}
			raw, _ := json.Marshal(tool)
			node := domain.Node{Data: map[string]json.RawMessage{"toolsType": raw, "toolsSourceUrl": json.RawMessage(`"rhtv-asset:guide"`), "params": json.RawMessage(`{"imageUrls":["rhtv-asset:guide"]}`)}}
			err := setConditioning(&request, promptSelection{}, node)
			if extra {
				if err == nil {
					t.Fatal("ambiguous source accepted")
				}
				continue
			}
			if err != nil {
				t.Fatal(err)
			}
			masks := 0
			for _, binding := range request.PromptSpec.Conditioning {
				if binding.AttachmentRef == "ref-guide" {
					masks++
					if binding.Role != "MASK" || binding.TargetAttachmentRef == nil || *binding.TargetAttachmentRef != "ref-source" {
						t.Fatal(binding)
					}
				}
			}
			if masks != 1 {
				t.Fatal("duplicated or missing guide binding", masks)
			}
		}
	}
}

func TestImageRecipePrivatePresetUsesAuthenticatedActorNotProjectStorageOwner(t *testing.T) {
	def := StyleDefinition{SchemaVersion: "1", Revision: 1, Key: "customPrompt", ID: "mine", Label: "Mine", Prompt: "my recipe"}
	svc := &Service{}
	svc.WithStyles(&testStyleCatalog{definition: def})
	selected := func() promptSelection {
		return promptSelection{PresetSelections: json.RawMessage(`[{"key":"customPrompt","id":"mine"}]`), Conditions: map[string]json.RawMessage{}}
	}
	s := selected()
	if err := svc.resolveStyles(principal.WithActor(context.Background(), "owner"), "project-owner", &s); err != nil {
		t.Fatal("actor-owned recipe not resolved", err)
	}
	s = selected()
	if err := svc.resolveStyles(principal.WithActor(context.Background(), "foreign"), "owner", &s); err == nil {
		t.Fatal("project storage owner leaked private recipe")
	}
}
func TestImageRecipeCutoutRequiresVerifiedTransparentOutputParameter(t *testing.T) {
	template, _ := sceneTemplate("canvas-image-cutout")
	text := "isolate subject"
	for _, param := range []string{`{}`, `{"transparentBackground":false}`, `{"transparentBackground":true}`} {
		request := gateway.InvocationRequest{Capability: gateway.CapabilitySelection{Ref: "codex-image-edit-v1", Version: "3"}, Parameters: json.RawMessage(param), Attachments: []gateway.Attachment{{Ref: "image", Kind: "IMAGE"}}, Input: []gateway.InputPart{{Type: "TEXT", Text: &text}}, PromptSpec: &gateway.PromptSpec{Messages: []gateway.PromptMessage{{Role: "USER", InputIndexes: []int{0}}}}}
		err := validatePromptInputs(request, gateway.Capability{Kind: "IMAGE_TO_IMAGE"}, template)
		if param == `{"transparentBackground":true}` {
			if err != nil {
				t.Fatal(err)
			}
		} else if !errors.Is(err, domain.ErrInvalid) {
			t.Fatal("opaque cutout accepted", err)
		}
	}
}

func TestImageRecipePortraitPoseGuidePreservesSourceIdentityRole(t *testing.T) {
	request := gateway.InvocationRequest{Capability: gateway.CapabilitySelection{Ref: "codex-image-edit-v1", Version: "3"}, PromptSpec: &gateway.PromptSpec{}, Attachments: []gateway.Attachment{{Ref: "ref-source", SourceRef: "source", Kind: "IMAGE"}, {Ref: "ref-pose", SourceRef: "pose", Kind: "IMAGE"}}}
	node := domain.Node{Data: map[string]json.RawMessage{"isPortraitAdjustResult": json.RawMessage(`true`), "toolsSourceUrl": json.RawMessage(`"rhtv-asset:source"`), "presetSelections": json.RawMessage(`[{"key":"poseBase","id":"studio-portrait-952-v1","promptCode":"studio-portrait-952-v1"}]`), "params": json.RawMessage(`{"imageUrls":["rhtv-asset:source","rhtv-asset:pose"]}`)}}
	if err := setConditioning(&request, promptSelection{}, node); err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, binding := range request.PromptSpec.Conditioning {
		if binding.Role == "MASK" {
			t.Fatal("portrait interpreted as erase mask")
		}
		if binding.AttachmentRef == "ref-pose" {
			seen = true
			if binding.Role != "POSE" || binding.TargetAttachmentRef == nil || *binding.TargetAttachmentRef != "ref-source" {
				t.Fatal(binding)
			}
		}
	}
	if !seen {
		t.Fatal("pose reference absent")
	}
	request.Attachments = request.Attachments[:1]
	request.PromptSpec = &gateway.PromptSpec{}
	if err := setConditioning(&request, promptSelection{}, node); err == nil {
		t.Fatal("missing pose guide accepted")
	}
}

func TestImageRecipeNativeSavedAndInlineCustomShapes(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		saved      bool
	}{
		{"saved", `[{"key":"customPrompt","labelKey":"canvas.presetPicker.tabs.custom","label":"Mine","prefix":"Soft light","suffix":"Fine detail","presetId":"my-preset","presetName":"Mine","promptType":"PROMPT"}]`, true},
		{"inline", `[{"key":"customPrompt","labelKey":"canvas.presetPicker.tabs.custom","label":"自定义","prefix":"Soft light","suffix":"Fine detail","presetId":"","presetName":""}]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &Service{}
			if tc.saved {
				svc.WithStyles(&testStyleCatalog{definition: StyleDefinition{SchemaVersion: "1", Revision: 1, ID: "my-preset", Key: "customPrompt", Label: "Mine", Prompt: "Soft light\nFine detail", PrefixPrompt: "Soft light", SuffixPrompt: "Fine detail", PromptType: "PROMPT", SourceScope: "USER"}})
			}
			s, err := readPromptSelection(domain.Node{Data: map[string]json.RawMessage{"presetSelections": json.RawMessage(tc.body)}})
			if err != nil {
				t.Fatal(err)
			}
			if err = svc.resolveStyles(context.Background(), "owner", &s); err != nil {
				t.Fatal(err)
			}
			var defs []StyleDefinition
			if json.Unmarshal(s.Conditions["imageRecipes"], &defs) != nil || len(defs) != 1 || defs[0].PrefixPrompt != "Soft light" || defs[0].SuffixPrompt != "Fine detail" {
				t.Fatal(string(s.Conditions["imageRecipes"]))
			}
		})
	}
	for _, body := range []string{`[{"key":"customPrompt","id":"x","presetId":"y","prefix":"text"}]`, `[{"key":"customPrompt","prefix":"text","presetId":"","promptCode":"hidden-original"}]`} {
		if _, err := readStyles(json.RawMessage(body)); err == nil {
			t.Fatal("ambiguous/unregistered custom selector accepted")
		}
	}
}
func TestImageRecipePrivateDisplayURLsNeverAlterAuthorizedAttachment(t *testing.T) {
	for _, media := range []string{"rhtv-asset:img", "https://evil.invalid/input.png", "rhtv-asset:foreign"} {
		svc, store, _ := promptTestService(t, "LLM")
		svc.WithStyles(&testStyleCatalog{definition: StyleDefinition{SchemaVersion: "1", Revision: 1, Key: "styleLibrary", ID: "owned-style", Label: "Mine", Prompt: "Soft light", PrefixPrompt: "Soft light", PromptType: "STYLE", ReferenceAssetID: "img", SourceScope: "USER"}})
		body, _ := json.Marshal(map[string]any{"prompt": "x", "presetSelections": []any{map[string]any{"key": "styleLibrary", "id": "owned-style", "prompt": "Soft light", "coverUrl": "https://evil.invalid/cover.png", "referenceImageUrl": "https://evil.invalid/pretend.png"}}, "params": map[string]any{"imageUrls": []string{media}}})
		task, err := promptCanvas(t, svc, string(body))
		if media != "rhtv-asset:img" {
			if err == nil || store.creates != 0 {
				t.Fatal("display URL bypassed asset authorization")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		request := frozenRequest(t, task)
		if len(request.Attachments) != 1 || request.Attachments[0].SourceRef != "img" {
			t.Fatal("wrong image attachment")
		}
		raw, _ := json.Marshal(request)
		if strings.Contains(string(raw), "evil.invalid") {
			t.Fatal("untrusted display URL entered model request")
		}
	}
}
