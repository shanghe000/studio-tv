package http

import (
	"studiotv.local/service/api/internal/modules/library/domain"
	"time"
)

type galleryDTO struct {
	CategoryCode string   `json:"categoryCode"`
	FolderID     *string  `json:"folderId"`
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Description  string   `json:"description"`
	Kind         string   `json:"kind"`
	ItemType     string   `json:"itemType"`
	Revision     int64    `json:"revision"`
	AssetIDs     []string `json:"assetIds"`
	MainAssetID  *string  `json:"mainAssetId"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func galleryView(g domain.Gallery) galleryDTO {
	kind := "ROLE_GALLERY"
	if g.Kind == domain.Scene {
		kind = "SCENE_GALLERY"
	}
	ids := g.AssetIDs
	if ids == nil {
		ids = []string{}
	}
	code := g.CategoryCode
	if code == "" {
		code = "USER_OTHER"
	}
	return galleryDTO{code, g.FolderID, g.ID, g.Title, g.Description, string(g.Kind), kind, g.Revision, ids, g.MainAssetID, iso(g.CreatedAt), iso(g.UpdatedAt)}
}

type pageDTO struct {
	Records []galleryDTO `json:"records"`
	Page    int          `json:"page"`
	Size    int          `json:"size"`
	Total   int64        `json:"total"`
	Pages   int64        `json:"pages"`
	HasNext bool         `json:"hasNext"`
}
