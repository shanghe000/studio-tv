package core

import (
	"testing"
)

func TestEmbeddedStyleMediaExactReferences(t *testing.T) {
	entries := map[string]string{"cinematic_realism": "hero-canvas.webp", "anime_illustration": "demo-poster.webp", "product_ad": "examples/modular-speaker.webp", "editorial_fashion": "examples/lime-rim-light.webp"}
	for id, path := range entries {
		url := "https://assets.example.invalid/styles/" + path
		body, found, err := embeddedStyleMedia(id, "studio-style-library-1", url)
		if err != nil || !found || len(body) < 1000 {
			t.Fatalf("%s missing verified bytes: %v", id, err)
		}
		for _, changed := range [][3]string{{id, "other-version", url}, {"unknown", "studio-style-library-1", url}, {id, "studio-style-library-1", url + "?changed=1"}, {id, "studio-style-library-1", "https://evil.invalid/" + path}} {
			if _, found, err := embeddedStyleMedia(changed[0], changed[1], changed[2]); err != nil || found {
				t.Fatalf("unbound reference resolved: %v", changed)
			}
		}
	}
}
