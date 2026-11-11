package application

import (
	"encoding/json"
	"strings"
	"unicode/utf16"

	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

const nativeStyleAlias = "canvas_prompt_user_style_extract"
const nativeStyleMarker = "user_style_extract_prompt"
const nativeStyleTemplate = "studio-tv/feature/image.style-extract"
const nativeStyleTemplateVersion = "studio-native-style-500-1"
const nativeStyleMaxUnits = 500

// This compatibility mapping is one captured feature, never a generic alias
// fallback. The browser's marker remains USER data; STUDIO instructions stay frozen.
func validateNativeStyleSelection(s promptSelection) error {
	var alias string
	_ = json.Unmarshal(s.Conditions["requestedModelCode"], &alias)
	if alias != nativeStyleAlias && s.FeatureCode != "image.style-extract" {
		return nil
	}
	if alias != nativeStyleAlias || s.FeatureCode != "image.style-extract" || s.SceneCode != "" || len(s.Messages) != 1 || len(s.ReferenceBindings) != 0 {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	m := s.Messages[0]
	if m.Role != "USER" || m.Text == nil || *m.Text != nativeStyleMarker || len(m.AssetIDs) != 1 {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	return nil
}

func validateNativeStyleInput(request gateway.InvocationRequest, cap gateway.Capability) error {
	if request.PromptSpec == nil || request.PromptSpec.TemplateRef != nativeStyleTemplate {
		return nil
	}
	if cap.Kind != "IMAGE_UNDERSTANDING" || len(request.Attachments) != 1 || request.Attachments[0].Kind != "IMAGE" {
		return promptFault("PROMPT_CAPABILITY_MISMATCH")
	}
	if request.PromptSpec.OutputContract == nil || request.PromptSpec.OutputContract.Type != "TEXT" {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	return nil
}

func validateNativeStyleOutput(request gateway.InvocationRequest, invocation gateway.Invocation) error {
	if request.PromptSpec == nil || request.PromptSpec.TemplateRef != nativeStyleTemplate {
		return nil
	}
	if len(invocation.OutputParts) != 1 || invocation.OutputParts[0].Type != "TEXT" || invocation.OutputParts[0].Text == nil || strings.TrimSpace(*invocation.OutputParts[0].Text) == "" {
		return promptFault("PROMPT_OUTPUT_INVALID")
	}
	if request.PromptSpec.TemplateVersion == nativeStyleTemplateVersion && len(utf16.Encode([]rune(*invocation.OutputParts[0].Text))) > nativeStyleMaxUnits {
		return promptFault("PROMPT_OUTPUT_INVALID")
	}
	// The immutable style reader needs descriptive text. A JSON object/array
	// is a different protocol even when serialized into a TEXT part.
	var value any
	if json.Unmarshal([]byte(strings.TrimSpace(*invocation.OutputParts[0].Text)), &value) == nil {
		switch value.(type) {
		case map[string]any, []any:
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
	}
	return nil
}
