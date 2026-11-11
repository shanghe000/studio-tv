package domain

import (
	"encoding/json"
	"strings"
	"unicode"
)

const MaxAutomaticTitleRunes = 32

// Placeholder titles are the only titles the service may replace. Meaningful
// caller-supplied titles remain unchanged throughout subsequent turns.
func IsPlaceholderTitle(title string) bool {
	title = compactTitleText(title)
	return title == "" || title == "新对话"
}

// SuggestedConversationTitle derives a local title from user TEXT parts only;
// asset IDs and embedded skill instructions never become history titles.
func SuggestedConversationTitle(content json.RawMessage) string {
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return ""
	}
	texts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part.Type == "TEXT" {
			texts = append(texts, part.Text)
		}
	}
	text := compactTitleText(strings.Join(texts, " "))
	runes := []rune(text)
	if len(runes) > MaxAutomaticTitleRunes {
		return strings.TrimRight(string(runes[:MaxAutomaticTitleRunes-1]), " ") + "…"
	}
	return text
}

func compactTitleText(text string) string {
	return strings.Join(strings.FieldsFunc(text, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}), " ")
}
