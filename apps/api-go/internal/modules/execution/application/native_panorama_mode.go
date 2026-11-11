package application

import (
	"encoding/json"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

// The native panorama composer stores its mode alongside style selections.
// It is display/mode metadata, not a catalog recipe or executable prompt.
// Only the observed marker in a matching execution context may be removed.
func nativePanoramaModePresets(node domain.Node, scene string, raw json.RawMessage) (json.RawMessage, bool, error) {
	if !hasSelection(raw) {
		return raw, false, nil
	}
	if len(raw) > 20000 {
		return nil, false, domain.ErrInvalid
	}
	var objects []map[string]json.RawMessage
	if json.Unmarshal(raw, &objects) != nil || len(objects) == 0 || len(objects) > 100 {
		return nil, false, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
	}
	styles := make([]map[string]json.RawMessage, 0, len(objects))
	found := false
	for _, object := range objects {
		var key string
		_ = json.Unmarshal(object["key"], &key)
		if key != "panorama" {
			styles = append(styles, object)
			continue
		}
		var id, label string
		if found || len(object) != 3 || json.Unmarshal(object["id"], &id) != nil || id != "panorama" || json.Unmarshal(object["labelKey"], &label) != nil || label != "canvas.imageToolbar.panorama" || !nativePanoramaModeContext(node, scene) {
			return nil, false, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
		}
		found = true
	}
	if !found {
		return raw, false, nil
	}
	clean, err := json.Marshal(styles)
	return clean, true, err
}

func nativePanoramaModeContext(node domain.Node, scene string) bool {
	if node.Type != "rh-image" {
		return false
	}
	var panorama map[string]json.RawMessage
	var enabled, locked bool
	if json.Unmarshal(node.Data["panorama"], &panorama) != nil || json.Unmarshal(panorama["isPanoramaNode"], &enabled) != nil || !enabled || json.Unmarshal(panorama["locked"], &locked) != nil || !locked {
		return false
	}
	sub := strings.ReplaceAll(strings.ToLower(domain.String(node.Data, "subType")), "_", "-")
	return scene == "canvas-image-panorama-text" && sub == "text-image" || scene == "canvas-image-panorama-image" && sub == "image-image"
}
