package postgres

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCharacterMediaUpgradeRetainsAllCapturedViewsAndAttributes(t *testing.T) {
	manifest, rows, hash, err := readCharacterUpgrade()
	if err != nil || len(hash) != 64 || len(rows) != 415 || len(manifest.Media) < 1245 {
		t.Fatal("invalid independently versioned character media catalog", err)
	}
	for _, row := range rows {
		var previous, content map[string]json.RawMessage
		if json.Unmarshal(row.Previous, &previous) != nil || json.Unmarshal(row.Content, &content) != nil {
			t.Fatal("invalid character content")
		}
		for _, key := range []string{"id", "name", "description", "attributes"} {
			if string(previous[key]) != string(content[key]) {
				t.Fatal("captured character identity or attributes changed", row.ID, key)
			}
		}
		var images []struct{ Name, Type, URL string }
		if json.Unmarshal(content["images"], &images) != nil || len(images) != 3 {
			t.Fatal("missing character views", row.ID)
		}
		for i, view := range []string{"closeUp", "fullBody", "multiView"} {
			if images[i].Type != view || images[i].Name == "" || !characterMediaPath.MatchString(images[i].URL) {
				t.Fatal("unregistered character view", row.ID)
			}
		}
		if !characterMediaPath.MatchString(row.Thumbnail) || strings.Contains(string(row.Content), "https://") {
			t.Fatal("character lookup depends on remote media", row.ID)
		}
	}
}
