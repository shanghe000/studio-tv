package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/principal"
)

// StyleDefinition is server-owned catalog data, never a privileged instruction.
// ReferenceImageURL remains user data; resolving it as pixels requires the asset pipeline.
type StyleDefinition struct {
	SchemaVersion     string `json:"schemaVersion"`
	Revision          int64  `json:"revision"`
	Key               string `json:"key"`
	ID                string `json:"id"`
	Label             string `json:"label"`
	Prompt            string `json:"prompt"`
	CoverURL          string `json:"coverUrl"`
	ReferenceImageURL string `json:"referenceImageUrl"`
	PrefixPrompt      string `json:"prefixPrompt,omitempty"`
	SuffixPrompt      string `json:"suffixPrompt,omitempty"`
	PromptType        string `json:"promptType,omitempty"`
	PromptCode        string `json:"promptCode,omitempty"`
	ReferenceAssetID  string `json:"referenceAssetId,omitempty"`
	SourceScope       string `json:"sourceScope,omitempty"`
}

type StyleCatalog interface {
	Definition(context.Context, string, string) (StyleDefinition, error)
}

func (s *Service) WithStyles(port StyleCatalog) { s.styles = port }

type selectedStyle struct {
	PresetID          *string `json:"presetId,omitempty"`
	PresetName        *string `json:"presetName,omitempty"`
	LabelKey          *string `json:"labelKey,omitempty"`
	Suffix            *string `json:"suffix,omitempty"`
	inline            bool
	Key               string  `json:"key"`
	ID                string  `json:"id"`
	SchemaVersion     *string `json:"schemaVersion,omitempty"`
	Revision          *int64  `json:"revision,omitempty"`
	Label             *string `json:"label,omitempty"`
	Prompt            *string `json:"prompt,omitempty"`
	CoverURL          *string `json:"coverUrl,omitempty"`
	ReferenceImageURL *string `json:"referenceImageUrl,omitempty"`
	PrefixPrompt      *string `json:"prefixPrompt,omitempty"`
	SuffixPrompt      *string `json:"suffixPrompt,omitempty"`
	Prefix            *string `json:"prefix,omitempty"`
	PromptType        *string `json:"promptType,omitempty"`
	PromptCode        *string `json:"promptCode,omitempty"`
	PromptHidden      *bool   `json:"promptHidden,omitempty"`
	Favorited         *bool   `json:"favorited,omitempty"`
	Des               *string `json:"des,omitempty"`
	UseRecordID       *string `json:"useRecordId,omitempty"`
}

func readStyles(raw json.RawMessage) ([]selectedStyle, error) {
	if !hasSelection(raw) {
		return nil, nil
	}
	if len(raw) > 20000 {
		return nil, domain.ErrInvalid
	}
	var objects []map[string]json.RawMessage
	if json.Unmarshal(raw, &objects) != nil || len(objects) == 0 || len(objects) > 100 {
		return nil, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
	}
	for _, object := range objects {
		var key string
		if json.Unmarshal(object["key"], &key) != nil || !supportedPresetKey(key) {
			return nil, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
		}
		for _, raw := range object {
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
				return nil, domain.ErrInvalid
			}
		}
	}
	var result []selectedStyle
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&result) != nil {
		return nil, domain.ErrInvalid
	}
	var extra any
	if !errors.Is(dec.Decode(&extra), io.EOF) {
		return nil, domain.ErrInvalid
	}
	seen := map[string]bool{}
	for index := range result {
		item := &result[index]
		if item.PresetID != nil && *item.PresetID != "" {
			if item.ID != "" && item.ID != *item.PresetID {
				return nil, domain.ErrInvalid
			}
			item.ID = *item.PresetID
		}
		// Some native role/portrait selections carry only their published code.
		// Resolve it only when the exact key/code is an immutable STUDIO recipe.
		if item.ID == "" && item.PromptCode != nil && *item.PromptCode != "" {
			if def, ok := PublishedImagePreset(item.Key, *item.PromptCode); ok && def.PromptCode == *item.PromptCode {
				item.ID = def.ID
			}
		}
		if item.Key == "customPrompt" && item.ID == "" {
			if (item.Prefix == nil || strings.TrimSpace(*item.Prefix) == "") && (item.Suffix == nil || strings.TrimSpace(*item.Suffix) == "") {
				return nil, domain.ErrInvalid
			}
			item.ID = "studio-inline-custom-v1"
			item.inline = true
		}
		if item.PromptHidden != nil && *item.PromptHidden {
			return nil, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
		}
		if item.PromptCode != nil && *item.PromptCode != "" {
			def, ok := PublishedImagePreset(item.Key, item.ID)
			if !ok || *item.PromptCode != def.PromptCode {
				return nil, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
			}
		}
		if item.ID == "" || len(item.ID) > 200 || seen[item.Key+"/"+item.ID] {
			return nil, domain.ErrInvalid
		}
		seen[item.Key+"/"+item.ID] = true
	}
	return result, nil
}

func hiddenPresetOutsideStyles(node domain.Node) bool {
	other, err := withoutStyleSelectors(node)
	if err != nil {
		return true
	}
	body, _ := json.Marshal(other)
	return hasHiddenPreset(body)
}

// Called for media extraction only after the selector has been server-verified.
// The selected catalog URLs remain in the frozen USER conditions, not assets.
func withoutStyleSelectors(node domain.Node) (map[string]json.RawMessage, error) {
	data := node.Data
	scene := domain.String(data, "sceneCode")
	var explicit map[string]json.RawMessage
	if raw := data["promptSelection"]; len(raw) > 0 {
		if json.Unmarshal(raw, &explicit) != nil {
			return nil, domain.ErrInvalid
		}
		var selectedScene string
		if raw := explicit["sceneCode"]; len(raw) > 0 && json.Unmarshal(raw, &selectedScene) != nil {
			return nil, domain.ErrInvalid
		}
		if selectedScene != "" {
			if scene != "" && selectedScene != scene {
				return nil, domain.ErrInvalid
			}
			scene = selectedScene
		}
	}
	// Recheck the two documented selector paths before excluding their metadata
	// from media extraction. Unknown or malformed selectors are never hidden.
	for _, raw := range []json.RawMessage{data["presetSelections"], explicit["presetSelections"]} {
		styles, _, err := nativePanoramaModePresets(node, scene, raw)
		if err != nil {
			return nil, err
		}
		if _, err := readStyles(styles); err != nil {
			return nil, err
		}
	}
	other := make(map[string]json.RawMessage, len(data))
	for key, raw := range data {
		if key == "promptCodes" && knownRolePromptCodes(raw) {
			continue
		}
		if key == "cameraControl" {
			var camera map[string]json.RawMessage
			if json.Unmarshal(raw, &camera) != nil {
				return nil, domain.ErrInvalid
			}
			delete(camera, "presetId")
			raw, _ = json.Marshal(camera)
		}
		if key == "presetSelections" {
			continue
		}
		if key == "promptSelection" {
			var selection map[string]json.RawMessage
			if json.Unmarshal(raw, &selection) != nil {
				return nil, domain.ErrInvalid
			}
			delete(selection, "presetSelections")
			if knownRolePromptCodes(selection["promptCodes"]) {
				delete(selection, "promptCodes")
			}
			raw, _ = json.Marshal(selection)
		}
		other[key] = raw
	}
	return other, nil
}

func (s *Service) resolveStyles(ctx context.Context, owner string, selection *promptSelection) error {
	styles, err := readStyles(selection.PresetSelections)
	if err != nil {
		return err
	}
	if len(styles) == 0 {
		if hasSelection(selection.PromptCodes) {
			return domain.ErrInvalid
		}
		return nil
	}

	if hasSelection(selection.Conditions["styleLibrary"]) || hasSelection(selection.Conditions["imageRecipes"]) {
		return domain.ErrInvalid
	}
	resolved := make([]StyleDefinition, 0, len(styles))
	for _, item := range styles {
		def, ok := PublishedImagePreset(item.Key, item.ID)
		if item.inline {
			prefix, suffix := "", ""
			if item.Prefix != nil {
				prefix = *item.Prefix
			}
			if item.Suffix != nil {
				suffix = *item.Suffix
			}
			label := "自定义"
			if item.Label != nil {
				label = *item.Label
			}
			def = StyleDefinition{SchemaVersion: "1", Revision: 1, Key: "customPrompt", ID: item.ID, Label: label, Prompt: strings.TrimSpace(strings.Join([]string{prefix, suffix}, "\n")), PrefixPrompt: prefix, SuffixPrompt: suffix, SourceScope: "INLINE_USER"}
			ok = true
		}
		var err error
		if !ok {
			if s.styles == nil {
				return promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
			}
			def, err = s.styles.Definition(ctx, principal.Actor(ctx, owner), item.ID)
		}
		if errors.Is(err, domain.ErrNotFound) {
			return promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
		}
		if err != nil {
			return err
		}
		if item.Key == "makeup" && def.Key == "customPrompt" {
			def.Key = "makeup"
			def.PromptType = "makeup"
		}
		if def.ID != item.ID || def.Key != item.Key || def.SchemaVersion != "1" || def.Revision < 1 || def.Prompt == "" {
			return domain.ErrInvalid
		}
		if item.Revision != nil && *item.Revision != def.Revision {
			return domain.ErrConflict
		}
		for _, pair := range []struct {
			supplied *string
			trusted  string
		}{
			{item.SchemaVersion, def.SchemaVersion}, {item.Label, def.Label}, {item.Prompt, def.Prompt},

			{item.PrefixPrompt, def.PrefixPrompt}, {item.SuffixPrompt, def.SuffixPrompt}, {item.Prefix, def.PrefixPrompt}, {item.Suffix, def.SuffixPrompt}, {item.PromptType, def.PromptType},
		} {
			if pair.supplied != nil && *pair.supplied != pair.trusted {
				return domain.ErrInvalid
			}
		}
		// Private resource URLs are transient display metadata and are never
		// frozen or fetched. Actual reference pixels still require owned assets.
		if def.SourceScope != "USER" && def.SourceScope != "INLINE_USER" {
			if item.CoverURL != nil && *item.CoverURL != def.CoverURL || item.ReferenceImageURL != nil && *item.ReferenceImageURL != def.ReferenceImageURL {
				return domain.ErrInvalid
			}
		}
		if item.PresetName != nil && *item.PresetName != "" && *item.PresetName != def.Label {
			return domain.ErrInvalid
		}
		if item.PromptHidden != nil && *item.PromptHidden || item.PromptCode != nil && *item.PromptCode != def.PromptCode {
			return promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
		}
		resolved = append(resolved, def)
	}
	var codes []string
	_ = json.Unmarshal(selection.PromptCodes, &codes)
	for _, code := range codes {
		found := false
		for _, def := range resolved {
			if code == def.PromptCode {
				found = true
			}
		}
		if !found {
			return domain.ErrInvalid
		}
	}
	stylesOnly, recipes := []StyleDefinition{}, []StyleDefinition{}
	for _, def := range resolved {
		if def.Key == "styleLibrary" {
			stylesOnly = append(stylesOnly, def)
		} else {
			recipes = append(recipes, def)
		}
	}
	if len(stylesOnly) > 0 {
		selection.Conditions["styleLibrary"], err = json.Marshal(stylesOnly)
	}
	if len(recipes) > 0 {
		selection.Conditions["imageRecipes"], err = json.Marshal(recipes)
	}
	return err
}

func supportedPresetKey(key string) bool {
	for _, def := range PublishedImagePresets() {
		if def.Key == key || def.Key == "clothing" && strings.HasPrefix(key, "clothing:") {
			return true
		}
	}
	return key == "styleLibrary" || key == "filter" || key == "function" || key == "camera" || key == "customPrompt" || strings.HasPrefix(key, "roleDesign:")
}
