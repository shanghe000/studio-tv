package core

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// The native style picker carries public cover/reference URLs. Execution must
// use owned assets, never fetch those URLs or accept arbitrary remote media.
// Keep the original audited style definitions unchanged and bind their exact
// reference to these reproducible, hash-verified bytes.
//
//go:embed seed/style-media/*
var styleMediaFiles embed.FS

func embeddedStyleMedia(resourceID, sourceVersion, reference string) ([]byte, bool, error) {
	if sourceVersion != "studio-style-library-1" {
		return nil, false, nil
	}
	var manifest struct {
		Version        string `json:"version"`
		CatalogVersion string `json:"catalogVersion"`
		Revision       int    `json:"revision"`
		Media          []struct {
			ResourceID string `json:"resourceId"`
			URL        string `json:"url"`
			File       string `json:"file"`
			SHA256     string `json:"sha256"`
			ByteSize   int    `json:"byteSize"`
		} `json:"media"`
	}
	raw, err := styleMediaFiles.ReadFile("seed/style-media/manifest.json")
	if err != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Version != "studio-style-media-1" || manifest.CatalogVersion != sourceVersion || manifest.Revision != 1 || len(manifest.Media) != 4 {
		return nil, true, errors.New("invalid embedded style media manifest")
	}
	for _, entry := range manifest.Media {
		if entry.ResourceID != resourceID || entry.URL != reference {
			continue
		}
		body, err := styleMediaFiles.ReadFile("seed/style-media/" + entry.File)
		digest := sha256.Sum256(body)
		if err != nil || len(body) != entry.ByteSize || hex.EncodeToString(digest[:]) != entry.SHA256 || len(body) < 12 || string(body[:4]) != "RIFF" || string(body[8:12]) != "WEBP" {
			return nil, true, errors.New("embedded style media integrity failure")
		}
		return body, true, nil
	}
	return nil, false, nil
}
