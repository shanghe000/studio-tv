package application

import (
	"encoding/json"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"strings"
)

type nativeImageFrontier struct {
	sources      map[string]bool
	originalNode string
	region       bool
}

// Native tools edit the displayed output of their direct source, rather than
// replaying that source's generation inputs. The task snapshot stays complete:
// ancestor versions still participate in the canvas binding guard.
func nativeImageInputFrontier(cap gateway.CapabilitySelection, node domain.Node, graph domain.Graph, selected map[string]bool) (map[string]bool, *nativeImageFrontier, error) {
	if cap.Ref != "codex-image-edit-v1" || cap.Version != "3" || node.Type != "rh-image" {
		return selected, nil, nil
	}
	tool := strings.ReplaceAll(strings.ToUpper(domain.String(node.Data, "toolsType")), "-", "_")
	region := tool == "IMAGE_REDRAW" || tool == "IMAGE_ERASE" || tool == "IMAGE_EXPAND"
	portrait := string(node.Data["isPortraitAdjustResult"]) == "true"
	selection, err := readPromptSelection(node)
	if err != nil {
		return nil, nil, err
	}
	native := region || portrait
	switch tool {
	case "IMAGE_CUTOUT", "IMAGE_CUTOUT_TEXT", "IMAGE_ENHANCE", "IMAGE_MULTIANGLE", "IMAGE_MULTI_ANGLE", "IMAGE_LIGHT", "IMAGE_MULTI_ANGLE_LIGHT":
		native = true
	case "IMAGE_IMAGE":
		_, quick := quickSceneTasks[strings.TrimPrefix(selection.SceneCode, "canvas-image-quick-create-")]
		native = native || quick && strings.HasPrefix(selection.SceneCode, "canvas-image-quick-create-") || selection.SceneCode == "canvas-image-panorama-image"
	}
	if !native {
		return selected, nil, nil
	}
	pose := false
	if portrait {
		presets, err := readStyles(selection.PresetSelections)
		if err != nil {
			return nil, nil, err
		}
		for _, p := range presets {
			def, ok := PublishedImagePreset(p.Key, p.ID)
			pose = pose || ok && def.Key == "poseBase"
		}
	}
	nodes := map[string]domain.Node{}
	for _, body := range graph.Nodes {
		var source domain.Node
		if json.Unmarshal(body, &source) != nil {
			return nil, nil, domain.ErrInvalid
		}
		nodes[source.ID] = source
	}
	f := &nativeImageFrontier{sources: map[string]bool{}, region: region}
	for _, key := range []string{"sourceNodeId", "sourceImageNodeId", "toolsSourceUrl"} {
		raw := node.Data[key]
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || len(value) > 1024 {
			return nil, nil, promptFault("PROMPT_CONDITIONING_INVALID")
		}
		if key != "toolsSourceUrl" && value != "" {
			if f.originalNode != "" && f.originalNode != value {
				return nil, nil, promptFault("PROMPT_CONDITIONING_INVALID")
			}
			f.originalNode = value
		}
	}
	for _, edge := range graph.Edges {
		if edge.Target == node.ID && edge.Source != node.ID && nodes[edge.Source].Type == "rh-image" {
			f.sources[edge.Source] = true
		}
	}
	want := 1
	if pose {
		want = 2
	}
	if len(f.sources) == 0 {
		return nil, nil, promptFault("PROMPT_REFERENCE_REQUIRED")
	}
	if len(f.sources) != want || f.originalNode != "" && !f.sources[f.originalNode] {
		return nil, nil, promptFault("PROMPT_CONDITIONING_INVALID")
	}
	if !pose && f.originalNode == "" {
		for id := range f.sources {
			f.originalNode = id
		}
	}
	frontier := map[string]bool{}
	for id := range selected {
		if id == node.ID || nodes[id].Type != "rh-image" || f.sources[id] {
			frontier[id] = true
		}
	}
	return frontier, f, nil
}

// Attachment authority alone does not prove which node was edited. Bind the
// recipe to the direct source's frozen current/history output, and reject extra
// image inputs or an ancestor substituted through params/sourceNodeId.
func validateNativeImageFrontier(request gateway.InvocationRequest, node domain.Node, refs []domain.InputReference, f *nativeImageFrontier) error {
	if f == nil {
		return nil
	}
	bySource := map[string]map[string]bool{}
	for _, ref := range refs {
		if f.sources[ref.SourceNodeID] && ref.AssetID != "" && ref.Modality == "IMAGE" {
			if bySource[ref.SourceNodeID] == nil {
				bySource[ref.SourceNodeID] = map[string]bool{}
			}
			bySource[ref.SourceNodeID][ref.AssetID] = true
		}
	}
	allowed := map[string]bool{}
	for id := range f.sources {
		if len(bySource[id]) == 0 {
			return promptFault("PROMPT_REFERENCE_REQUIRED")
		}
		if len(bySource[id]) != 1 {
			return promptFault("PROMPT_CONDITIONING_INVALID")
		}
		for asset := range bySource[id] {
			allowed[asset] = true
		}
	}
	raw := domain.String(node.Data, "toolsSourceUrl")
	if raw != "" {
		if !strings.HasPrefix(raw, "rhtv-asset:") {
			return promptFault("PROMPT_REFERENCE_REQUIRED")
		}
		asset := strings.TrimPrefix(raw, "rhtv-asset:")
		if f.region {
			if asset == "" || allowed[asset] {
				return promptFault("PROMPT_CONDITIONING_INVALID")
			}
			allowed[asset] = true
		} else if !allowed[asset] || f.originalNode != "" && !bySource[f.originalNode][asset] {
			return promptFault("PROMPT_CONDITIONING_INVALID")
		}
	}
	for _, attachment := range request.Attachments {
		if attachment.Kind == "IMAGE" && !allowed[attachment.SourceRef] {
			return promptFault("PROMPT_CONDITIONING_INVALID")
		}
	}
	return nil
}

// Native region tools already persist an owned guide asset and the source edge.
// Resolve that pair from the frozen request without mutating the canvas graph.
func bindNativeImageGuide(request gateway.InvocationRequest, node domain.Node, bindings []referenceBinding) ([]referenceBinding, error) {
	if request.Capability.Ref != "codex-image-edit-v1" || request.Capability.Version != "3" {
		return bindings, nil
	}
	tool := strings.ReplaceAll(strings.ToUpper(domain.String(node.Data, "toolsType", "subType")), "-", "_")
	if string(node.Data["isPortraitAdjustResult"]) == "true" {
		selection, err := readPromptSelection(node)
		if err != nil {
			return nil, err
		}
		presets, err := readStyles(selection.PresetSelections)
		if err != nil {
			return nil, err
		}
		hasPose := false
		for _, p := range presets {
			def, ok := PublishedImagePreset(p.Key, p.ID)
			if ok && def.Key == "poseBase" {
				hasPose = true
			}
		}
		if !hasPose {
			return bindings, nil
		}
		source := strings.TrimPrefix(domain.String(node.Data, "toolsSourceUrl"), "rhtv-asset:")
		found := false
		pose := ""
		for _, a := range request.Attachments {
			if a.Kind != "IMAGE" {
				continue
			}
			if a.SourceRef == source {
				found = true
				continue
			}
			if pose != "" {
				return nil, promptFault("PROMPT_CONDITIONING_INVALID")
			}
			pose = a.SourceRef
		}
		if !found || pose == "" {
			return nil, promptFault("PROMPT_REFERENCE_REQUIRED")
		}
		out := make([]referenceBinding, 0, len(bindings)+1)
		for _, b := range bindings {
			if b.AssetID == pose {
				if b.TargetAssetID != "" && b.TargetAssetID != source {
					return nil, promptFault("PROMPT_CONDITIONING_INVALID")
				}
				continue
			}
			out = append(out, b)
		}
		out = append(out, referenceBinding{AssetID: pose, Role: "POSE", TargetAssetID: source})
		return out, nil
	}
	if tool != "IMAGE_REDRAW" && tool != "IMAGE_ERASE" && tool != "IMAGE_EXPAND" {
		return bindings, nil
	}
	raw := domain.String(node.Data, "toolsSourceUrl")
	if !strings.HasPrefix(raw, "rhtv-asset:") {
		return nil, promptFault("PROMPT_REFERENCE_REQUIRED")
	}
	guide := strings.TrimPrefix(raw, "rhtv-asset:")
	found := false
	target := ""
	for _, asset := range request.Attachments {
		if asset.Kind != "IMAGE" {
			continue
		}
		if asset.SourceRef == guide {
			found = true
			continue
		}
		if target != "" {
			return nil, promptFault("PROMPT_CONDITIONING_INVALID")
		}
		target = asset.SourceRef
	}
	if !found || target == "" {
		return nil, promptFault("PROMPT_REFERENCE_REQUIRED")
	}
	out := make([]referenceBinding, 0, len(bindings)+1)
	for _, b := range bindings {
		if b.AssetID == guide {
			if b.TargetAssetID != "" && b.TargetAssetID != target {
				return nil, promptFault("PROMPT_CONDITIONING_INVALID")
			}
			continue
		}
		out = append(out, b)
	}
	out = append(out, referenceBinding{AssetID: guide, Role: "MASK", TargetAssetID: target})
	return out, nil
}
