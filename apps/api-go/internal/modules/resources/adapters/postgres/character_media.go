package postgres

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/resources/domain"
)

// Character bytes are separately cached and verified by the offline importer.
// The immutable original capture stays unchanged; this audited upgrade only
// supplies its previously empty media references, preserving character identity.
//
//go:embed seed/character-media.json
var characterMediaSeed embed.FS

var characterMediaPath = regexp.MustCompile(`^/studio-character-media/([a-f0-9]{64})\.webp$`)

type characterManifest struct {
	Version    string `json:"version"`
	Base       string `json:"baseVersion"`
	SourceName string `json:"sourceName"`
	Characters []struct {
		ID        string `json:"id"`
		Thumbnail string `json:"thumbnailPath"`
		Images    []struct {
			Name string `json:"name"`
			Type string `json:"type"`
			URL  string `json:"url"`
		} `json:"images"`
	} `json:"characters"`
	Media []struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
		Bytes  int64  `json:"byteSize"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
		MIME   string `json:"mimeType"`
	} `json:"media"`
}

type characterUpgrade struct {
	ID, Name, Description string
	Categories            []string
	Previous, Content     json.RawMessage
	Thumbnail             string
}

func readCharacterUpgrade() (characterManifest, []characterUpgrade, string, error) {
	var manifest characterManifest
	raw, e := characterMediaSeed.ReadFile("seed/character-media.json")
	if e != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Version != "studio-character-media-1" || manifest.Base != "captured-2026-10-05-v2" || len(manifest.Characters) != 415 || manifest.SourceName == "" {
		return manifest, nil, "", domain.ErrUnavailable
	}
	var baseline struct {
		Version string `json:"version"`
		Items   []struct {
			ID          string          `json:"id"`
			Family      string          `json:"family"`
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Categories  []string        `json:"categoryIds"`
			Content     json.RawMessage `json:"content"`
		} `json:"items"`
	}
	baseRaw, e := catalogSeed.ReadFile("seed/catalog.json")
	if e != nil || json.Unmarshal(baseRaw, &baseline) != nil || baseline.Version != manifest.Base {
		return manifest, nil, "", domain.ErrUnavailable
	}
	media := make(map[string]bool, len(manifest.Media))
	for _, v := range manifest.Media {
		match := characterMediaPath.FindStringSubmatch(v.Path)
		if match == nil || match[1] != v.SHA256 || media[v.Path] || v.Bytes < 1 || v.Bytes > 8<<20 || v.Width < 1 || v.Width > 768 || v.Height < 1 || v.Height > 4096 || v.MIME != "image/webp" {
			return manifest, nil, "", domain.ErrUnavailable
		}
		media[v.Path] = true
	}
	old := make(map[string]characterUpgrade)
	for _, v := range baseline.Items {
		if v.Family == "CHARACTER" {
			old[v.ID] = characterUpgrade{ID: v.ID, Name: v.Name, Description: v.Description, Categories: v.Categories, Previous: v.Content}
		}
	}
	if len(old) != len(manifest.Characters) {
		return manifest, nil, "", domain.ErrUnavailable
	}
	upgrades := make([]characterUpgrade, 0, len(old))
	for _, v := range manifest.Characters {
		previous, exists := old[v.ID]
		if !exists || len(v.Images) != 3 || !media[v.Thumbnail] {
			return manifest, nil, "", domain.ErrUnavailable
		}
		delete(old, v.ID)
		var content map[string]json.RawMessage
		var images []struct{ Name, Type, URL string }
		if json.Unmarshal(previous.Previous, &content) != nil || json.Unmarshal(content["images"], &images) != nil || len(images) != 3 {
			return manifest, nil, "", domain.ErrUnavailable
		}
		for i, image := range v.Images {
			if image.Name != images[i].Name || image.Type != images[i].Type || images[i].URL != "" || !media[image.URL] {
				return manifest, nil, "", domain.ErrUnavailable
			}
		}
		content["images"], _ = json.Marshal(v.Images)
		content["thumbnailUrl"], _ = json.Marshal(v.Thumbnail)
		previous.Content, _ = json.Marshal(content)
		previous.Thumbnail = v.Thumbnail
		upgrades = append(upgrades, previous)
	}
	digest := sha256.Sum256(raw)
	return manifest, upgrades, hex.EncodeToString(digest[:]), nil
}

func (r *Repository) importCharacterMedia(ctx context.Context) error {
	manifest, upgrades, hash, e := readCharacterUpgrade()
	if e != nil {
		return e
	}
	return r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, "server", "catalog-import"); e != nil {
			return e
		}
		var recordedHash string
		e := tx.QueryRow(ctx, `SELECT source_hash FROM resources.catalog_imports WHERE version=$1`, manifest.Version).Scan(&recordedHash)
		replay := e == nil
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrUnavailable
		}
		if replay && recordedHash != hash {
			return domain.ErrConflict
		}
		if !replay {
			if _, e = tx.Exec(ctx, `INSERT INTO resources.catalog_imports(version,source_hash,source_name,row_count)VALUES($1,$2,$3,$4)`, manifest.Version, hash, manifest.SourceName, len(upgrades)+len(manifest.Media)); e != nil {
				return domain.ErrUnavailable
			}
		}
		for _, v := range upgrades {
			if !replay {
				result, e := tx.Exec(ctx, `UPDATE resources.items SET content=$2,cover_url=$3,version=$4,source_version=$4,revision=2,updated_at=now() WHERE id=$1 AND family='CHARACTER' AND scope='SYSTEM' AND owner_id IS NULL AND deleted_at IS NULL AND revision=1 AND version=$5 AND source_version=$5 AND content=$6::jsonb AND name=$7 AND description=$8 AND category_ids=$9 AND cover_url='' AND cover_asset_id IS NULL`, v.ID, v.Content, v.Thumbnail, manifest.Version, manifest.Base, v.Previous, v.Name, v.Description, v.Categories)
				if e != nil {
					return domain.ErrUnavailable
				}
				if result.RowsAffected() != 1 {
					return domain.ErrConflict
				}
			} else {
				var unchanged bool
				e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM resources.items WHERE id=$1 AND family='CHARACTER' AND scope='SYSTEM' AND owner_id IS NULL AND deleted_at IS NULL AND revision=2 AND version=$4 AND source_version=$4 AND content=$2::jsonb AND cover_url=$3 AND name=$5 AND description=$6 AND category_ids=$7 AND cover_asset_id IS NULL)`, v.ID, v.Content, v.Thumbnail, manifest.Version, v.Name, v.Description, v.Categories).Scan(&unchanged)
				if e != nil {
					return domain.ErrUnavailable
				}
				if !unchanged {
					return domain.ErrConflict
				}
			}
		}
		for _, v := range manifest.Media {
			id := "pfchar_" + v.SHA256
			if !replay {
				if _, e := tx.Exec(ctx, `INSERT INTO resources.catalog_media(id,path,source_version)VALUES($1,$2,$3)`, id, v.Path, manifest.Version); e != nil {
					return domain.ErrConflict
				}
			} else {
				var unchanged bool
				if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM resources.catalog_media WHERE id=$1 AND path=$2 AND source_version=$3)`, id, v.Path, manifest.Version).Scan(&unchanged); e != nil {
					return domain.ErrUnavailable
				}
				if !unchanged {
					return domain.ErrConflict
				}
			}
		}
		return nil
	})
}
