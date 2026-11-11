package domain

import (
	"encoding/json"
	"regexp"
)

type Preferences struct {
	Revision          int64           `json:"revision"`
	UserID            string          `json:"userId"`
	ShortcutKeyConfig json.RawMessage `json:"shortcutKeyConfig"`
	BuzzyPopFlag      bool            `json:"buzzyPopFlag"`
}
type PreferenceInput struct {
	ShortcutKeyConfig json.RawMessage `json:"shortcutKeyConfig"`
	BuzzyPopFlag      *bool           `json:"buzzyPopFlag"`
}

func (p PreferenceInput) Validate() error {
	if len(p.ShortcutKeyConfig) == 0 && p.BuzzyPopFlag == nil {
		return ErrInvalid
	}
	if len(p.ShortcutKeyConfig) > 0 {
		var v struct {
			Newline         string          `json:"newline"`
			SubmitTask      string          `json:"submitTask"`
			InteractionMode string          `json:"interactionMode"`
			ZoomSensitivity json.RawMessage `json:"zoomSensitivity"`
		}
		if Strict(p.ShortcutKeyConfig, &v) != nil || !one(v.Newline, "enter", "shift-enter") || !one(v.SubmitTask, "enter", "shift-enter", "none") || !one(v.InteractionMode, "rhtv", "comfyui") {
			return ErrInvalid
		}
		if len(v.ZoomSensitivity) == 0 {
			return ErrInvalid
		}
		if len(v.ZoomSensitivity) > 0 {
			var n float64
			if json.Unmarshal(v.ZoomSensitivity, &n) != nil || n < 10 || n > 100 {
				return ErrInvalid
			}
		}
	}
	return nil
}

type Tag struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Color         string `json:"color"`
	SortOrder     int    `json:"sortOrder"`
	Visible       bool   `json:"visible"`
	HasVisibility bool   `json:"-"`
}
type Tags struct {
	Revision int64 `json:"revision"`
	Tags     []Tag `json:"tags"`
}

var color = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (t Tag) Validate() error {
	if !Text(t.Name, 60, true) || !color.MatchString(t.Color) {
		return ErrInvalid
	}
	return nil
}
