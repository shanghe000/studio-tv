package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"time"
)

//go:embed seed/catalog.json
var catalogSeed embed.FS

// ImportCatalog is an explicit composition/administration operation, not a read fallback.
// It commits immutable normalized rows and audit metadata in one transaction, and never seeds owners.
func (r *Repository) ImportCatalog(ctx context.Context) error {
	raw, e := catalogSeed.ReadFile("seed/catalog.json")
	if e != nil {
		return domain.ErrUnavailable
	}
	var seed struct {
		Version    string `json:"version"`
		SourceHash string `json:"sourceHash"`
		SourceName string `json:"sourceName"`
		Items      []struct {
			ID          string          `json:"id"`
			Family      string          `json:"family"`
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Content     json.RawMessage `json:"content"`
			CategoryIDs []string        `json:"categoryIds"`
			CoverURL    string          `json:"coverUrl"`
			CreatedAt   *time.Time      `json:"createdAt"`
		} `json:"items"`
		Categories []struct {
			Namespace string          `json:"namespace"`
			ID        string          `json:"id"`
			ParentID  *string         `json:"parentId"`
			Name      string          `json:"name"`
			SortOrder int             `json:"sortOrder"`
			Context   json.RawMessage `json:"context"`
			Content   json.RawMessage `json:"content"`
		} `json:"categories"`
		Values []struct {
			Namespace string          `json:"namespace"`
			Key       string          `json:"key"`
			Content   json.RawMessage `json:"content"`
		} `json:"values"`
		Media []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"media"`
	}
	if json.Unmarshal(raw, &seed) != nil || len(seed.SourceHash) != 64 {
		return domain.ErrUnavailable
	}
	e = r.within(ctx, func(tx pgx.Tx) error {
		if e := lockOwner(ctx, tx, "server", "catalog-import"); e != nil {
			return e
		}
		var hash string
		e := tx.QueryRow(ctx, "SELECT source_hash FROM resources.catalog_imports WHERE version=$1", seed.Version).Scan(&hash)
		if e == nil {
			if hash != seed.SourceHash {
				return domain.ErrConflict
			}
			return nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrUnavailable
		}
		_, e = tx.Exec(ctx, "INSERT INTO resources.catalog_imports(version,source_hash,source_name,row_count) VALUES($1,$2,$3,$4)", seed.Version, seed.SourceHash, seed.SourceName, len(seed.Items)+len(seed.Categories)+len(seed.Values)+len(seed.Media))
		if e != nil {
			return domain.ErrUnavailable
		}
		for _, v := range seed.Items {
			_, e = tx.Exec(ctx, `INSERT INTO resources.items(id,family,scope,name,description,content,category_ids,cover_url,version,source_version,created_at) VALUES($1,$2,'SYSTEM',$3,$4,$5,$6,$7,$8,$8,COALESCE($9,now()))`, v.ID, v.Family, v.Name, v.Description, v.Content, v.CategoryIDs, v.CoverURL, seed.Version, v.CreatedAt)
			if e != nil {
				return domain.ErrUnavailable
			}
		}
		for _, v := range seed.Categories {
			_, e = tx.Exec(ctx, "INSERT INTO resources.categories(namespace,id,parent_id,name,context,content,sort_order,source_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", v.Namespace, v.ID, v.ParentID, v.Name, v.Context, v.Content, v.SortOrder, seed.Version)
			if e != nil {
				return domain.ErrUnavailable
			}
		}
		for _, v := range seed.Values {
			_, e = tx.Exec(ctx, "INSERT INTO resources.catalog_values(namespace,key,content,source_version) VALUES($1,$2,$3,$4)", v.Namespace, v.Key, v.Content, seed.Version)
			if e != nil {
				return domain.ErrUnavailable
			}
		}
		for _, v := range seed.Media {
			_, e = tx.Exec(ctx, "INSERT INTO resources.catalog_media(id,path,source_version) VALUES($1,$2,$3)", v.ID, v.Path, seed.Version)
			if e != nil {
				return domain.ErrUnavailable
			}
		}
		return nil
	})
	if e != nil {
		return e
	}
	return r.importCharacterMedia(ctx)
}
