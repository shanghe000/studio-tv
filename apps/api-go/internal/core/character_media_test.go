package core

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestIndependentCharacterCatalogPathAndBytes(t *testing.T) {
	body := []byte("the registered bytes")
	digest := sha256.Sum256(body)
	path := "/studio-character-media/" + hex.EncodeToString(digest[:]) + ".webp"
	if !validCatalogLocalPath(path) || verifyCatalogLocalBytes(path, body) != nil {
		t.Fatal("valid STUDIO character cache rejected")
	}
	if verifyCatalogLocalBytes(path, []byte("changed bytes")) == nil {
		t.Fatal("modified character bytes admitted")
	}
	for _, invalid := range []string{"/studio-character-media/a.webp", "/studio-character-media/../secret", "/studio-character-media/" + hex.EncodeToString(digest[:]) + ".png", "https://assets.example.invalid/removed", "/project/assets/../secret"} {
		if validCatalogLocalPath(invalid) {
			t.Fatal("untrusted catalog path admitted", invalid)
		}
	}
	if !validCatalogLocalPath("/project/assets/previously-registered.png") {
		t.Fatal("existing catalog boundary changed")
	}
}
