package application

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type promptSelection struct {
	nativePanoramaMode bool
	SchemaVersion      string                     `json:"schemaVersion"`
	FeatureCode        string                     `json:"featureCode,omitempty"`
	SceneCode          string                     `json:"sceneCode,omitempty"`
	PresetSelections   json.RawMessage            `json:"presetSelections,omitempty"`
	PromptCodes        json.RawMessage            `json:"promptCodes,omitempty"`
	Conditions         map[string]json.RawMessage `json:"conditions,omitempty"`
	ReferenceBindings  []referenceBinding         `json:"referenceBindings,omitempty"`
	Messages           []selectedMessage          `json:"messages,omitempty"`
}
type referenceBinding struct {
	AssetID       string `json:"assetId"`
	Role          string `json:"role"`
	SourceKey     string `json:"-"`
	TargetAssetID string `json:"targetAssetId,omitempty"`
}
type selectedMessage struct {
	Role     string   `json:"role"`
	Text     *string  `json:"text,omitempty"`
	AssetIDs []string `json:"assetIds,omitempty"`
}

func promptFault(code string) error { return &gateway.Fault{Code: code} }

func readPromptSelection(node domain.Node) (promptSelection, error) {
	selection := promptSelection{SchemaVersion: "1"}
	// Reject privileged envelopes wherever a graph client attempts to hide them.
	data, _ := json.Marshal(node.Data)
	if hasPrivilegedInput(data) {
		return selection, promptFault("UNTRUSTED_PROMPT_INSTRUCTIONS")
	}
	if raw := node.Data["promptSelection"]; len(raw) > 0 {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if dec.Decode(&selection) != nil || selection.SchemaVersion != "1" {
			return selection, domain.ErrInvalid
		}
		var extra any
		if !errors.Is(dec.Decode(&extra), io.EOF) {
			return selection, domain.ErrInvalid
		}
	}
	if len(selection.FeatureCode) > 200 || len(selection.SceneCode) > 200 || len(selection.ReferenceBindings) > 100 || len(selection.Messages) > 500 {
		return selection, domain.ErrInvalid
	}
	legacyScene := domain.String(node.Data, "sceneCode")
	if selection.SceneCode != "" && legacyScene != "" && selection.SceneCode != legacyScene {
		return selection, domain.ErrInvalid
	}
	if selection.SceneCode == "" {
		selection.SceneCode = legacyScene
	}
	for name, dst := range map[string]*json.RawMessage{"presetSelections": &selection.PresetSelections, "promptCodes": &selection.PromptCodes} {
		if raw := node.Data[name]; len(raw) > 0 {
			if len(*dst) > 0 && !bytes.Equal(*dst, raw) {
				return selection, domain.ErrInvalid
			}
			*dst = raw
		}
	}
	if !knownRolePromptCodes(selection.PromptCodes) {
		return selection, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
	}
	var err error
	selection.PresetSelections, selection.nativePanoramaMode, err = nativePanoramaModePresets(node, selection.SceneCode, selection.PresetSelections)
	if err != nil {
		return selection, err
	}
	if _, err := readStyles(selection.PresetSelections); err != nil {
		return selection, err
	}
	// Only the validated STUDIO style selector at the two documented paths is
	// exempt. Nested or RunningHub selectors retain their explicit 501 boundary.
	if hiddenPresetOutsideStyles(node) {
		return selection, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
	}
	if selection.FeatureCode == "" {
		sub := strings.ReplaceAll(strings.ToUpper(domain.String(node.Data, "subType", "toolsType")), "-", "_")
		tool := strings.ReplaceAll(strings.ToUpper(domain.String(node.Data, "toolsType")), "-", "_")
		switch {
		case tool == "IMAGE_MULTIANGLE" || tool == "IMAGE_MULTI_ANGLE":
			selection.FeatureCode = "image.angle"
		case tool == "IMAGE_LIGHT" || tool == "IMAGE_MULTI_ANGLE_LIGHT":
			selection.FeatureCode = "image.lighting"
		case tool == "IMAGE_ENHANCE":
			selection.FeatureCode = "image.enhance"
		case tool == "IMAGE_REDRAW":
			selection.FeatureCode = "image.repaint"
		case tool == "IMAGE_CUTOUT_TEXT":
			selection.FeatureCode = "image.remove-text"
		case string(node.Data["isPortraitAdjustResult"]) == "true":
			selection.FeatureCode = "image.portrait-adjust"
		case node.Type == "rh-script" || node.Type == "rh-storyboard" || sub == "MULTIMODAL_STORYBOARD" || sub == "TEXT_SCRIPT" || sub == "SCRIPT_STORYBOARD":
			selection.FeatureCode = "storyboard.script"
		case domain.String(node.Data, "transientKind") == "director-text-scene":
			selection.FeatureCode = "director.text-scene"
		case domain.String(node.Data, "transientKind") == "director-ai-vision":
			selection.FeatureCode = "director.image-observation"
		case sub == "VIDEO_ANALYSIS":
			selection.FeatureCode = "video.analyze"
		}
	}
	for _, message := range selection.Messages {
		if message.Role != "USER" && message.Role != "ASSISTANT" {
			return selection, promptFault("UNTRUSTED_PROMPT_INSTRUCTIONS")
		}
		if message.Text == nil && len(message.AssetIDs) == 0 || message.Text != nil && (len(*message.Text) > 200000 || strings.ContainsRune(*message.Text, 0)) || len(message.AssetIDs) > 100 {
			return selection, domain.ErrInvalid
		}
		for _, id := range message.AssetIDs {
			if id == "" || len(id) > 200 || strings.HasPrefix(id, "rhtv-asset:") {
				return selection, domain.ErrInvalid
			}
		}
	}
	for _, binding := range selection.ReferenceBindings {
		if binding.AssetID == "" || len(binding.AssetID) > 200 || strings.HasPrefix(binding.AssetID, "rhtv-asset:") || conditioningKind(binding.Role) == "" || binding.TargetAssetID != "" && (len(binding.TargetAssetID) > 200 || binding.TargetAssetID == binding.AssetID || (binding.Role != "MASK" && binding.Role != "POSE")) {
			return selection, domain.ErrInvalid
		}
	}
	if selection.Conditions == nil {
		selection.Conditions = map[string]json.RawMessage{}
	}
	// Keep specialized native camera/lighting/style/range options as user data.
	// The immutable Router parameter schema still validates execution parameters.
	var native map[string]json.RawMessage
	if raw := node.Data["params"]; len(raw) > 0 && json.Unmarshal(raw, &native) != nil {
		return selection, domain.ErrInvalid
	}
	clean := map[string]json.RawMessage{}
	consumedPrompt, _, _ := selectedNativePrompt(native)
	for key, value := range native {
		// Video transport switches already travel in schema-validated routerParameters.
		// The visual prompt accepts artistic conditions only.
		if node.Type == "rh-video" && (key == "generateAudio" || key == "returnLastFrame") {
			continue
		}
		if key != consumedPrompt && !(strings.EqualFold(key, "messages") && len(selection.Messages) > 0) && !isMediaKey(key) {
			clean[key] = value
		}
	}
	if len(clean) > 0 {
		if len(selection.Conditions["nativeParameters"]) > 0 {
			return selection, domain.ErrInvalid
		}
		selection.Conditions["nativeParameters"], _ = json.Marshal(clean)
	}
	for _, key := range []string{"styleCode", "generationMode", "stylePrompt", "globalPrompt", "storyboardGlobalPrompt", "negativePrompt", "camera", "cameraControl", "lighting", "pose", "angle", "region", "maskBounds"} {
		if raw := node.Data[key]; len(raw) > 0 {
			if prior := selection.Conditions[key]; len(prior) > 0 && !bytes.Equal(prior, raw) {
				return selection, domain.ErrInvalid
			}
			selection.Conditions[key] = raw
		}
	}
	if err := validateNativeStyleSelection(selection); err != nil {
		return selection, err
	}
	conditions, _ := json.Marshal(selection.Conditions)
	if rawCredentialParameter(conditions) {
		return selection, promptFault("PROVIDER_CREDENTIAL_PARAMETER_FORBIDDEN")
	}
	return selection, nil
}

func hasSelection(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return true
	}
	var nonempty func(any) bool
	nonempty = func(v any) bool {
		switch x := v.(type) {
		case nil:
			return false
		case string:
			return strings.TrimSpace(x) != ""
		case []any:
			for _, a := range x {
				if nonempty(a) {
					return true
				}
			}
			return false
		case map[string]any:
			for _, a := range x {
				if nonempty(a) {
					return true
				}
			}
			return false
		default:
			return true
		}
	}
	return nonempty(value)
}

func hasHiddenPreset(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return true
	}
	var walk func(any) bool
	walk = func(v any) bool {
		switch x := v.(type) {
		case map[string]any:
			for key, child := range x {
				normal := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
				if normal == "promptcode" || normal == "promptcodes" || normal == "presetid" || normal == "presetids" || normal == "presetselections" {
					body, _ := json.Marshal(child)
					if hasSelection(body) {
						return true
					}
				}
				if normal == "prompthidden" && child == true {
					return true
				}
				if walk(child) {
					return true
				}
			}
		case []any:
			for _, child := range x {
				if walk(child) {
					return true
				}
			}
		}
		return false
	}
	return walk(value)
}

func hasPrivilegedInput(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return true
	}
	var walk func(any) bool
	walk = func(v any) bool {
		switch x := v.(type) {
		case map[string]any:
			for key, child := range x {
				normal := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
				switch normal {
				case "promptspec", "system", "systemprompt", "systeminstructions", "developer", "developerprompt", "instructions", "templateref", "templateversion", "templatesha256":
					return true
				}
				if normal == "role" {
					if role, ok := child.(string); ok && (strings.EqualFold(role, "SYSTEM") || strings.EqualFold(role, "DEVELOPER")) {
						return true
					}
				}
				if walk(child) {
					return true
				}
			}
		case []any:
			for _, child := range x {
				if walk(child) {
					return true
				}
			}
		}
		return false
	}
	return walk(value)
}

func isMediaKey(key string) bool {
	k := strings.ToLower(strings.ReplaceAll(key, "_", ""))
	if k == "assetid" || k == "assetids" || k == "sourceobjects" || k == "toolssourceurl" || k == "url" || k == "urls" || k == "src" {
		return true
	}
	switch k {
	case "image", "video", "audio", "mask", "sourcevideo", "file", "firstframe", "lastframe", "posefile":
		return true
	}
	for _, word := range []string{"image", "video", "audio", "frame", "mask", "file"} {
		if strings.Contains(k, word) && (strings.HasSuffix(k, "url") || strings.HasSuffix(k, "urls") || strings.HasSuffix(k, "assetid") || strings.HasSuffix(k, "assetids")) {
			return true
		}
	}
	return false
}

func selectTemplate(selection promptSelection, kind string) (promptTemplate, error) {
	t, ok := defaultTemplate(kind)
	if !ok {
		return t, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
	}
	if selection.FeatureCode != "" {
		t, ok = featureTemplate(selection.FeatureCode)
		if !ok {
			return t, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
		}
	}
	if selection.SceneCode != "" {
		t, ok = sceneTemplate(selection.SceneCode)
		if !ok {
			return t, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
		}
	}
	for _, allowed := range t.kinds {
		if allowed == kind {
			return t, nil
		}
	}
	return t, promptFault("PROMPT_CAPABILITY_MISMATCH")
}

func nodePrompt(node domain.Node) string {
	var params map[string]json.RawMessage
	if json.Unmarshal(node.Data["params"], &params) == nil {
		if _, text, exists := selectedNativePrompt(params); exists {
			return text
		}
	}
	return domain.String(node.Data, "prompt", "text", "content", "positivePrompt")
}

func selectedNativePrompt(params map[string]json.RawMessage) (string, string, bool) {
	emptyKey := ""
	for _, key := range []string{"prompt", "PROMPT", "Prompt", "text", "content", "positivePrompt", "PositivePrompt"} {
		if raw, exists := params[key]; exists {
			var text string
			if json.Unmarshal(raw, &text) == nil {
				if strings.TrimSpace(text) != "" {
					return key, text, true
				}
				if emptyKey == "" {
					emptyKey = key
				}
			}
		}
	}
	if emptyKey != "" {
		return emptyKey, "", true
	}
	return "", "", false
}

func appendUserInput(request *gateway.InvocationRequest, parts ...gateway.InputPart) {
	indexes := []int{}
	for _, part := range parts {
		indexes = append(indexes, len(request.Input))
		request.Input = append(request.Input, part)
	}
	if len(indexes) > 0 {
		request.PromptSpec.Messages = append(request.PromptSpec.Messages, gateway.PromptMessage{Role: "USER", InputIndexes: indexes})
	}
}
func appendPromptConditions(request *gateway.InvocationRequest, selection promptSelection) {
	if len(selection.Conditions) == 0 && selection.FeatureCode == "" && selection.SceneCode == "" {
		return
	}
	version := "1"
	body, _ := json.Marshal(map[string]any{"schemaCode": "STUDIO_PROMPT_CONDITIONS_V1", "featureCode": selection.FeatureCode, "sceneCode": selection.SceneCode, "conditions": selection.Conditions})
	appendUserInput(request, gateway.InputPart{Type: "STRUCTURED", SchemaVersion: &version, Data: body})
}

func conditioningKind(role string) string {
	switch role {
	case "REFERENCE_IMAGE", "SKETCH", "MASK", "FIRST_FRAME", "LAST_FRAME", "POSE", "DEPTH", "STYLE":
		return "IMAGE"
	case "MOTION_REFERENCE", "SOURCE_VIDEO":
		return "VIDEO"
	case "REFERENCE_AUDIO", "VOICE":
		return "AUDIO"
	}
	return ""
}
func defaultConditioning(kind string) string {
	switch kind {
	case "IMAGE":
		return "REFERENCE_IMAGE"
	case "VIDEO":
		return "SOURCE_VIDEO"
	case "AUDIO":
		return "REFERENCE_AUDIO"
	}
	return ""
}

func setConditioning(request *gateway.InvocationRequest, selection promptSelection, node domain.Node, trusted ...bool) error {
	if isolatedCanvasMediaInput(request.Capability, node, trusted...) {
		node.Data = canvasGenerationInputData(node)
	}
	refs := map[string]gateway.Attachment{}
	for _, a := range request.Attachments {
		refs[a.SourceRef] = a
	}
	bindings := append([]referenceBinding(nil), selection.ReferenceBindings...)
	explicitAssets := map[string]bool{}
	for _, b := range selection.ReferenceBindings {
		explicitAssets[b.AssetID] = true
	}
	for _, b := range deriveReferenceBindings(node) {
		if !explicitAssets[b.AssetID] {
			bindings = append(bindings, b)
		}
	}
	var guideErr error
	bindings, guideErr = bindNativeImageGuide(*request, node, bindings)
	if guideErr != nil {
		return guideErr
	}
	seen := map[string]bool{}
	bound := map[string]bool{}
	for _, b := range bindings {
		a, ok := refs[b.AssetID]
		if !ok {
			return domain.ErrNotFound
		}
		if strings.EqualFold(b.SourceKey, "toolsSourceUrl") {
			b.Role = defaultConditioning(a.Kind)
		}
		if conditioningKind(b.Role) != a.Kind {
			return promptFault("PROMPT_CONDITIONING_INVALID")
		}
		var targetRef *string
		if b.TargetAssetID != "" {
			target, ok := refs[b.TargetAssetID]
			if !ok {
				return domain.ErrNotFound
			}
			if a.Kind != "IMAGE" || target.Kind != "IMAGE" || target.Ref == a.Ref {
				return promptFault("PROMPT_CONDITIONING_INVALID")
			}
			targetRef = &target.Ref
		}
		key := a.Ref + "/" + b.Role + "/" + b.TargetAssetID
		if !seen[key] {
			request.PromptSpec.Conditioning = append(request.PromptSpec.Conditioning, gateway.PromptConditioning{AttachmentRef: a.Ref, Role: b.Role, TargetAttachmentRef: targetRef})
			seen[key] = true
		}
		bound[a.Ref] = true
	}
	for _, a := range request.Attachments {
		role := defaultConditioning(a.Kind)
		if !bound[a.Ref] && role != "" {
			request.PromptSpec.Conditioning = append(request.PromptSpec.Conditioning, gateway.PromptConditioning{AttachmentRef: a.Ref, Role: role})
		}
	}
	// Only the explicit first/last feature assigns temporal roles. It consumes
	// the first and final ordinary image after deterministic media ordering;
	// masks, styles and other explicitly conditioned images keep their roles.
	sub := strings.ReplaceAll(strings.ToUpper(domain.String(node.Data, "subType", "toolsType")), "-", "_")
	if sub == "START_END_VIDEO" || sub == "FIRST_LAST_VIDEO" || sub == "START_VIDEO" || sub == "END_VIDEO" {
		ordinary := []string{}
		hasFirst, hasLast := false, false
		for _, c := range request.PromptSpec.Conditioning {
			hasFirst = hasFirst || c.Role == "FIRST_FRAME"
			hasLast = hasLast || c.Role == "LAST_FRAME"
			if c.Role == "REFERENCE_IMAGE" {
				ordinary = append(ordinary, c.AttachmentRef)
			}
		}
		// Conditioning declaration order may differ from transport order.
		ordered := []string{}
		for _, a := range request.Attachments {
			for _, ref := range ordinary {
				if a.Ref == ref {
					ordered = append(ordered, ref)
					break
				}
			}
		}
		first, last := "", ""
		if len(ordered) > 0 && !hasFirst && sub != "END_VIDEO" {
			first = ordered[0]
		}
		if (len(ordered) > 1 || hasFirst && len(ordered) > 0 || sub == "END_VIDEO" && len(ordered) > 0) && !hasLast && sub != "START_VIDEO" {
			last = ordered[len(ordered)-1]
		}
		for i := range request.PromptSpec.Conditioning {
			c := &request.PromptSpec.Conditioning[i]
			if c.Role == "REFERENCE_IMAGE" {
				if c.AttachmentRef == first {
					c.Role = "FIRST_FRAME"
				} else if c.AttachmentRef == last {
					c.Role = "LAST_FRAME"
				}
			}
		}
	}
	return nil
}

func deriveReferenceBindings(node domain.Node) []referenceBinding {
	var value any
	body, _ := json.Marshal(node.Data)
	_ = json.Unmarshal(body, &value)
	bindings := []referenceBinding{}
	var walk func(any, string)
	walk = func(v any, key string) {
		normal := strings.ToLower(strings.ReplaceAll(key, "_", ""))
		role := ""
		switch {
		case strings.Contains(normal, "mask"):
			role = "MASK"
		case strings.Contains(normal, "sketch"):
			role = "SKETCH"
		case strings.Contains(normal, "pose"):
			role = "POSE"
		case strings.Contains(normal, "depth"):
			role = "DEPTH"
		case strings.Contains(normal, "style"):
			role = "STYLE"
		case strings.Contains(normal, "first") || strings.Contains(normal, "startframe") || strings.Contains(normal, "startimage"):
			role = "FIRST_FRAME"
		case strings.Contains(normal, "last") || strings.Contains(normal, "endframe") || strings.Contains(normal, "endimage"):
			role = "LAST_FRAME"
		case strings.Contains(normal, "motion"):
			role = "MOTION_REFERENCE"
		case strings.Contains(normal, "voice"):
			role = "VOICE"
		case strings.Contains(normal, "audio"):
			role = "REFERENCE_AUDIO"
		case strings.Contains(normal, "video"):
			role = "SOURCE_VIDEO"
		case strings.Contains(normal, "image") || normal == "toolssourceurl":
			role = "REFERENCE_IMAGE"
		}
		switch x := v.(type) {
		case map[string]any:
			keys := []string{}
			for k := range x {
				if !inputMetadataKey(k) {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			for _, k := range keys {
				walk(x[k], k)
			}
		case []any:
			for _, child := range x {
				walk(child, key)
			}
		case string:
			if role != "" && strings.HasPrefix(x, "rhtv-asset:") {
				bindings = append(bindings, referenceBinding{AssetID: strings.TrimPrefix(x, "rhtv-asset:"), Role: role, SourceKey: key})
			}
		}
	}
	walk(value, "")
	return bindings
}

func validatePromptInputs(request gateway.InvocationRequest, cap gateway.Capability, t promptTemplate) error {
	if request.Capability.Ref == "codex-image-edit-v1" && request.Capability.Version == "3" && (t.ref == "studio-tv/scene/canvas-image-cutout" || t.ref == "studio-tv/feature/image.cutout") {
		var params struct {
			TransparentBackground bool `json:"transparentBackground"`
		}
		if json.Unmarshal(request.Parameters, &params) != nil || !params.TransparentBackground {
			return domain.ErrInvalid
		}
	}
	if err := validateNativeStyleInput(request, cap); err != nil {
		return err
	}
	if err := validateNativeRegionInput(request, cap); err != nil {
		return err
	}
	if cap.Model != nil {
		// Configured profiles must declare modalities; legacy fixture profiles
		// retain their previous contract. A name alone never grants support.
		if len(cap.InputKinds) == 0 || len(cap.OutputKinds) == 0 {
			return promptFault("PROMPT_CAPABILITY_MISMATCH")
		}
		if t.output != nil && (t.output.Type == "TEXT" || t.output.Type == "JSON_SCHEMA") {
			want := "TEXT"
			if t.output.Type == "JSON_SCHEMA" {
				want = "STRUCTURED"
			}
			found := false
			for _, kind := range cap.OutputKinds {
				if kind == want || t.output.Type == "JSON_SCHEMA" && kind == "TEXT" {
					found = true
				}
			}
			if !found {
				return promptFault("PROMPT_CAPABILITY_MISMATCH")
			}
		}
	}
	if len(request.Input) > 100 || len(request.Attachments) > 100 || request.PromptSpec != nil && (len(request.PromptSpec.Messages) > 100 || len(request.PromptSpec.Conditioning) > 100) {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	allowed := map[string]bool{}
	for _, kind := range cap.InputKinds {
		allowed[kind] = true
	}
	attachments := map[string]gateway.Attachment{}
	hasImage := false
	for _, a := range request.Attachments {
		attachments[a.Ref] = a
		if a.Kind == "IMAGE" {
			hasImage = true
		}
		if len(allowed) > 0 && !allowed[a.Kind] {
			return promptFault("PROMPT_CAPABILITY_MISMATCH")
		}
	}
	for _, part := range request.Input {
		if len(allowed) > 0 && part.Type != "MEDIA" && !allowed[part.Type] {
			return promptFault("PROMPT_CAPABILITY_MISMATCH")
		}
	}
	if t.requiresImage && !hasImage {
		return promptFault("PROMPT_REFERENCE_REQUIRED")
	}
	seen := map[int]bool{}
	hasUser := false
	if request.PromptSpec == nil || len(request.PromptSpec.Messages) == 0 {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	for _, m := range request.PromptSpec.Messages {
		if m.Role == "USER" {
			hasUser = true
		} else if m.Role != "ASSISTANT" {
			return promptFault("PROMPT_SPEC_INVALID")
		}
		if len(m.InputIndexes) == 0 {
			return promptFault("PROMPT_SPEC_INVALID")
		}
		for _, i := range m.InputIndexes {
			if i < 0 || i >= len(request.Input) || seen[i] {
				return promptFault("PROMPT_SPEC_INVALID")
			}
			seen[i] = true
		}
	}
	if !hasUser || len(seen) != len(request.Input) {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	for _, c := range request.PromptSpec.Conditioning {
		a, ok := attachments[c.AttachmentRef]
		if !ok || conditioningKind(c.Role) != a.Kind {
			return promptFault("PROMPT_CONDITIONING_INVALID")
		}
	}
	return nil
}
