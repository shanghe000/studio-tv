package application

import (
	"encoding/json"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func h3Capability(cap gateway.Capability) bool {
	if cap.Model == nil || cap.Model.ModelRef != "h3" || cap.Kind != "IMAGE_TO_VIDEO" && cap.Kind != "OMNI_REFERENCE" {
		return false
	}
	var schema struct {
		Mode string `json:"x-video-mode"`
	}
	if json.Unmarshal(cap.ParameterSchema, &schema) != nil {
		return false
	}
	return schema.Mode == "FIRST_FRAME" || schema.Mode == "FIRST_LAST_FRAME" || schema.Mode == "OMNI_REFERENCE"
}

func canvasMediaCapability(cap gateway.Capability) bool {
	if h3Capability(cap) || profiledVideoCapability(cap) {
		return true
	}
	if cap.Model == nil || cap.Kind != "TEXT_TO_IMAGE" && cap.Kind != "IMAGE_TO_IMAGE" && cap.Kind != "IMAGE_ENHANCE" {
		return false
	}
	for _, kind := range cap.OutputKinds {
		if kind == "IMAGE" {
			return true
		}
	}
	return false
}

// New video providers explicitly opt into current-reference semantics through
// a versioned public parameter profile. Unknown video catalogs keep their old
// behavior; a name containing a vendor or "video" is never sufficient.
func profiledVideoCapability(cap gateway.Capability) bool {
	if cap.Model == nil {
		return false
	}
	video := false
	for _, kind := range cap.OutputKinds {
		video = video || kind == "VIDEO"
	}
	if !video {
		return false
	}
	var schema struct {
		Mode     string `json:"x-video-mode"`
		Metadata struct {
			Version string            `json:"schemaVersion"`
			Presets []json.RawMessage `json:"presets"`
		} `json:"x-video-parameter-metadata"`
		Properties struct {
			OutputPreset struct {
				Enum []string `json:"enum"`
			} `json:"outputPreset"`
		} `json:"properties"`
	}
	if json.Unmarshal(cap.ParameterSchema, &schema) != nil || schema.Metadata.Version != "1" ||
		len(schema.Metadata.Presets) == 0 || len(schema.Metadata.Presets) != len(schema.Properties.OutputPreset.Enum) {
		return false
	}
	switch schema.Mode {
	case "TEXT_TO_VIDEO":
		return cap.Kind == "TEXT_TO_VIDEO"
	case "FIRST_FRAME", "FIRST_LAST_FRAME", "LAST_FRAME":
		return cap.Kind == "IMAGE_TO_VIDEO"
	case "OMNI_REFERENCE":
		return cap.Kind == "OMNI_REFERENCE"
	case "MOTION_TRANSFER":
		return cap.Kind == "VIDEO_TO_VIDEO"
	}
	return false
}

func h3CanvasInput(cap gateway.CapabilitySelection, node domain.Node, trusted ...bool) bool {
	if node.Type != "rh-video" {
		return false
	}
	if len(trusted) > 0 && trusted[0] {
		return true
	}
	if cap.Version != "1" && cap.Version != "2" {
		return false
	}
	switch cap.Ref {
	case "h3-first-frame-v1", "h3-first-last-frame-v1", "h3-reference-v1", "h3-video-reference-v1":
		return true
	}
	return false
}

// Restrict the changed input semantics to the connected production image/video models.
func isolatedCanvasMediaInput(cap gateway.CapabilitySelection, node domain.Node, trusted ...bool) bool {
	if h3CanvasInput(cap, node, trusted...) {
		return true
	}
	if node.Type == "rh-image" && len(trusted) > 0 && trusted[0] {
		return true
	}
	return node.Type == "rh-image" && (cap.Version == "1" || cap.Version == "2" || cap.Version == "3") && (cap.Ref == "codex-image-generate-v1" || cap.Ref == "codex-image-edit-v1")
}

func canvasMediaNode(node domain.Node) bool {
	switch node.Type {
	case "rh-image", "rh-role", "rh-scene", "rh-entity", "rh-video", "rh-audio":
		return true
	}
	return false
}

// A connected generated image/video/audio supplies its current output, not its
// own historical references. Keep the full snapshot for lineage/CAS and retain
// text conditions. Explicit target attachments and ordering remain authoritative.
func canvasModelInputFrontier(cap gateway.CapabilitySelection, node domain.Node, graph domain.Graph, selected map[string]bool, trusted ...bool) (map[string]bool, *nativeImageFrontier, error) {
	selected, imageFrontier, err := nativeImageInputFrontier(cap, node, graph, selected)
	if err != nil {
		return nil, nil, err
	}
	if !isolatedCanvasMediaInput(cap, node, trusted...) {
		return selected, imageFrontier, nil
	}
	direct := map[string]bool{}
	for _, edge := range graph.Edges {
		if edge.Target == node.ID {
			direct[edge.Source] = true
		}
	}
	frontier := map[string]bool{}
	for _, raw := range graph.Nodes {
		var source domain.Node
		if json.Unmarshal(raw, &source) != nil {
			return nil, nil, domain.ErrInvalid
		}
		if selected[source.ID] && (source.ID == node.ID || direct[source.ID] || !canvasMediaNode(source)) {
			frontier[source.ID] = true
		}
	}
	// Current direct text in an ordinary image form supersedes only its own
	// text ancestors. Trusted video/tool/other input chains keep their semantics.
	if len(trusted) > 0 && trusted[0] {
		frontier, err = nativeImageTextInputFrontier(node, graph, frontier)
		if err == nil && (len(trusted) < 2 || trusted[1]) {
			frontier, err = nativeStoryboardImageInputFrontier(node, graph, frontier)
		}
		if err == nil && (len(trusted) < 2 || trusted[1]) {
			frontier, err = nativeStoryboardVideoInputFrontier(cap, node, graph, frontier, trusted...)
		}
	}
	return frontier, imageFrontier, err
}

// Root display fields describe the previous result. Explicit reference inputs
// remain under params/promptSelection and must still pass model validation.
func canvasGenerationInputData(node domain.Node) map[string]json.RawMessage {
	data := make(map[string]json.RawMessage, len(node.Data))
	for key, value := range node.Data {
		switch key {
		case "sourceObjects", "imageUrl", "videoUrl", "audioUrl", "assetId", "assetIds":
			continue
		}
		data[key] = value
	}
	return data
}
