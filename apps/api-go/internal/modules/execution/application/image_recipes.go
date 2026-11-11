package application

import (
	_ "embed"
	"encoding/json"
	"strings"
)

// PublishedImagePresets are STUDIO-owned execution recipes. The nine general presets
// preserve publicly visible native text; role labels are original STUDIO authored
// replacements, never recovered hidden RunningHub instructions.
var imagePresetDefinitions = []StyleDefinition{
	{SchemaVersion: "1", Revision: 1, Key: "filter", ID: "kodak_film", Label: "柯达胶片", Prompt: "Kodak film look, warm highlights, soft grain, rich analog color", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "filter", ID: "cool_cyber", Label: "冷调赛博", Prompt: "cool cyberpunk color palette, neon contrast, blue magenta shadows", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "filter", ID: "soft_pastel", Label: "柔和粉彩", Prompt: "soft pastel color grading, gentle contrast, airy highlights", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "function", ID: "multi_view", Label: "多视角", Prompt: "show the same subject from multiple camera angles, consistent identity and outfit", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "function", ID: "character_sheet", Label: "角色设定", Prompt: "character design sheet, front view, side view, back view, consistent details", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "function", ID: "scene_extension", Label: "场景延展", Prompt: "expand the environment naturally, preserve subject identity and scene continuity", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "camera", ID: "canon_eos_r5", Label: "佳能 EOS R5", Prompt: "Shot on Canon EOS R5, full-frame stills camera, crisp commercial detail", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "camera", ID: "arri_alexa_35", Label: "ARRI Alexa 35", Prompt: "Shot on ARRI Alexa 35, filmic color science, natural skin tones, organic contrast", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "camera", ID: "panavision_c", Label: "Panavision C", Prompt: "Panavision C-series cinema lenses, warm halation, oval bokeh, vintage anamorphic character", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:basic:presentation", ID: "studio-role-basic-woman-v1", Label: "成年女性", Prompt: "An adult woman.", PrefixPrompt: "An adult woman.", PromptType: "roleDesign", PromptCode: "studio-role-basic-woman-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:basic:presentation", ID: "studio-role-basic-man-v1", Label: "成年男性", Prompt: "An adult man.", PrefixPrompt: "An adult man.", PromptType: "roleDesign", PromptCode: "studio-role-basic-man-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:basic:presentation", ID: "studio-role-basic-androgynous-v1", Label: "中性气质", Prompt: "An adult character with an androgynous presentation.", PrefixPrompt: "An adult character with an androgynous presentation.", PromptType: "roleDesign", PromptCode: "studio-role-basic-androgynous-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:face:expression", ID: "studio-role-face-calm-v1", Label: "平静", Prompt: "A calm, composed expression.", PrefixPrompt: "A calm, composed expression.", PromptType: "roleDesign", PromptCode: "studio-role-face-calm-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:face:expression", ID: "studio-role-face-smile-v1", Label: "微笑", Prompt: "A natural, relaxed smile.", PrefixPrompt: "A natural, relaxed smile.", PromptType: "roleDesign", PromptCode: "studio-role-face-smile-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:face:expression", ID: "studio-role-face-determined-v1", Label: "坚定", Prompt: "A determined, focused expression.", PrefixPrompt: "A determined, focused expression.", PromptType: "roleDesign", PromptCode: "studio-role-face-determined-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:hair:length", ID: "studio-role-hair-short-v1", Label: "短发", Prompt: "Short hair with a clear silhouette.", PrefixPrompt: "Short hair with a clear silhouette.", PromptType: "roleDesign", PromptCode: "studio-role-hair-short-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:hair:length", ID: "studio-role-hair-long-v1", Label: "长发", Prompt: "Long hair with natural volume.", PrefixPrompt: "Long hair with natural volume.", PromptType: "roleDesign", PromptCode: "studio-role-hair-long-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:hair:length", ID: "studio-role-hair-tied-v1", Label: "束发", Prompt: "Hair neatly tied back.", PrefixPrompt: "Hair neatly tied back.", PromptType: "roleDesign", PromptCode: "studio-role-hair-tied-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:body:build", ID: "studio-role-body-slim-v1", Label: "纤细", Prompt: "A slender adult build with natural proportions.", PrefixPrompt: "A slender adult build with natural proportions.", PromptType: "roleDesign", PromptCode: "studio-role-body-slim-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:body:build", ID: "studio-role-body-athletic-v1", Label: "健美", Prompt: "An athletic adult build with natural proportions.", PrefixPrompt: "An athletic adult build with natural proportions.", PromptType: "roleDesign", PromptCode: "studio-role-body-athletic-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:body:build", ID: "studio-role-body-broad-v1", Label: "壮实", Prompt: "A broad, sturdy adult build with natural proportions.", PrefixPrompt: "A broad, sturdy adult build with natural proportions.", PromptType: "roleDesign", PromptCode: "studio-role-body-broad-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:outfit:wardrobe", ID: "studio-role-outfit-casual-v1", Label: "休闲", Prompt: "Simple contemporary casual clothing.", PrefixPrompt: "Simple contemporary casual clothing.", PromptType: "roleDesign", PromptCode: "studio-role-outfit-casual-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:outfit:wardrobe", ID: "studio-role-outfit-formal-v1", Label: "正装", Prompt: "Tailored formal clothing with coherent materials.", PrefixPrompt: "Tailored formal clothing with coherent materials.", PromptType: "roleDesign", PromptCode: "studio-role-outfit-formal-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:outfit:wardrobe", ID: "studio-role-outfit-fantasy-v1", Label: "幻想服饰", Prompt: "An original fantasy costume with practical, coherent details.", PrefixPrompt: "An original fantasy costume with practical, coherent details.", PromptType: "roleDesign", PromptCode: "studio-role-outfit-fantasy-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:style:rendering", ID: "studio-role-style-realistic-v1", Label: "写实", Prompt: "A realistic character design with natural material detail.", PrefixPrompt: "A realistic character design with natural material detail.", PromptType: "roleDesign", PromptCode: "studio-role-style-realistic-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:style:rendering", ID: "studio-role-style-illustration-v1", Label: "插画", Prompt: "A clean illustrated character design with readable shapes.", PrefixPrompt: "A clean illustrated character design with readable shapes.", PromptType: "roleDesign", PromptCode: "studio-role-style-illustration-v1", CoverURL: "", ReferenceImageURL: ""},
	{SchemaVersion: "1", Revision: 1, Key: "roleDesign:style:rendering", ID: "studio-role-style-animation-v1", Label: "动画", Prompt: "A polished stylized animated character design with expressive shapes.", PrefixPrompt: "A polished stylized animated character design with expressive shapes.", PromptType: "roleDesign", PromptCode: "studio-role-style-animation-v1", CoverURL: "", ReferenceImageURL: ""},
}

func PublishedImagePresets() []StyleDefinition {
	result := append([]StyleDefinition(nil), imagePresetDefinitions...)
	for _, item := range PortraitRecipes().Items {
		result = append(result, item.Definition)
	}
	return result
}
func PublishedImagePreset(key, id string) (StyleDefinition, bool) {
	for _, def := range PublishedImagePresets() {
		if (def.Key == key || def.Key == "clothing" && strings.HasPrefix(key, "clothing:")) && def.ID == id {
			def.Key = key
			return def, true
		}
	}
	return StyleDefinition{}, false
}
func knownRolePromptCodes(raw []byte) bool {
	if !hasSelection(raw) {
		return true
	}
	var codes []string
	if json.Unmarshal(raw, &codes) != nil || len(codes) > 100 {
		return false
	}
	seen := map[string]bool{}
	for _, code := range codes {
		found := false
		for _, def := range PublishedImagePresets() {
			if def.PromptCode == code && code != "" {
				found = true
			}
		}
		if !found || seen[code] {
			return false
		}
		seen[code] = true
	}
	return true
}

//go:embed seed/portrait-recipes.json
var portraitSeed []byte

type PortraitRecipeCatalog struct {
	Version    string `json:"version"`
	Source     string `json:"source"`
	Categories []struct {
		ID       int             `json:"id"`
		Name     string          `json:"name"`
		Prop     json.RawMessage `json:"prop"`
		ParentID *int            `json:"parentId"`
	} `json:"categories"`
	Items []struct {
		CategoryID int             `json:"categoryId"`
		Prop       json.RawMessage `json:"prop"`
		Definition StyleDefinition `json:"definition"`
	} `json:"items"`
}

func PortraitRecipes() PortraitRecipeCatalog {
	var seed PortraitRecipeCatalog
	if err := json.Unmarshal(portraitSeed, &seed); err != nil {
		panic("invalid compiled portrait recipe seed")
	}
	return seed
}
