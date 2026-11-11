package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestConversationTitleUsesEffectiveUserTextOnly(t *testing.T) {
	for _, test := range []struct {
		name, parts, expected string
	}{
		{"normalizes separators", `[{"type":"TEXT","text":" \t　做一段\n图形广告\u0001"},{"type":"TEXT","text":"  竖屏　 "}]`, "做一段 图形广告 竖屏"},
		{"ignores attachment IDs", `[{"type":"ASSET","assetId":"private-file-id"},{"type":"TEXT","text":"图形图片"}]`, "图形图片"},
		{"ignores skill instructions", `[{"type":"STRUCTURED","schemaCode":"ASSISTANT_SKILL_V1","value":{"markdown":"private instructions"}}]`, ""},
		{"ignores empty text", `[{"type":"TEXT","text":" \n\u0085　"},{"type":"ASSET","assetId":"private-file-id"}]`, ""},
		{"invalid JSON", `{`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if actual := SuggestedConversationTitle(json.RawMessage(test.parts)); actual != test.expected {
				t.Fatalf("title = %q, want %q", actual, test.expected)
			}
		})
	}
	parts, _ := json.Marshal([]map[string]string{{"type": "TEXT", "text": strings.Repeat("🦊", 40)}})
	title := SuggestedConversationTitle(parts)
	if title != strings.Repeat("🦊", 31)+"…" || utf8.RuneCountInString(title) != MaxAutomaticTitleRunes || !utf8.ValidString(title) {
		t.Fatal("title was not bounded without splitting Unicode text")
	}
}

func TestConversationTitleGeneratedOnceAndCustomTitlePreserved(t *testing.T) {
	for _, original := range []string{"", " 新对话　", "用户指定的主题"} {
		root, _ := NewConversation("conversation-a", VerifiedActor{OwnerID: "owner-a"}, Create{Kind: Global, Title: original}, time.Now())
		if _, err := root.AppendUserParts("attachment", json.RawMessage(`[{"type":"ASSET","assetId":"asset-a"}]`), 1, time.Now()); err != nil {
			t.Fatal(err)
		}
		if root.Title != original || root.TitleGenerated {
			t.Fatal("non-text turn replaced title")
		}
		if _, err := root.AppendUserParts("text", json.RawMessage(`[{"type":"TEXT","text":"首条有效用户文字"}]`), 2, time.Now()); err != nil {
			t.Fatal(err)
		}
		expected := original
		if IsPlaceholderTitle(original) {
			expected = "首条有效用户文字"
		}
		if root.Title != expected || root.TitleGenerated != IsPlaceholderTitle(original) {
			t.Fatal("effective user text did not generate or preserve the expected title")
		}
		if _, err := root.AppendUserParts("later", json.RawMessage(`[{"type":"TEXT","text":"第二条用户文字"}]`), 3, time.Now()); err != nil || root.Title != expected {
			t.Fatal("a later turn replaced the established title")
		}
	}
	// A user's first actual text may itself be the placeholder label. Track that
	// generation occurred so a later turn cannot rename it again.
	root, _ := NewConversation("conversation-b", VerifiedActor{OwnerID: "owner-a"}, Create{Kind: Global, Title: "新对话"}, time.Now())
	_, _ = root.AppendUserParts("first", json.RawMessage(`[{"type":"TEXT","text":"新对话"}]`), 1, time.Now())
	_, _ = root.AppendUserParts("second", json.RawMessage(`[{"type":"TEXT","text":"后续文字"}]`), 2, time.Now())
	if root.Title != "新对话" || !root.TitleGenerated {
		t.Fatal("generated placeholder title was replaced by a later turn")
	}
}
