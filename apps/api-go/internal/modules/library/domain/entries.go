package domain

import (
	"encoding/json"
	resource "studiotv.local/service/api/internal/modules/resources/domain"
	"strings"
	"time"
)

func ValidCategory(code string) bool {
	switch code {
	case "USER_CHARACTER", "USER_SCENE", "USER_THING", "USER_STYLE", "USER_PRODUCT", "USER_OTHER":
		return true
	}
	return false
}

type FolderInput struct {
	Name         string  `json:"name"`
	CategoryCode string  `json:"categoryCode"`
	ParentID     *string `json:"parentId"`
	Kind         string  `json:"kind"`
}

func (i FolderInput) Validate() error {
	if !resource.Text(i.Name, 120, true) || !ValidCategory(i.CategoryCode) || (i.Kind != "" && i.Kind != "MIXED") || i.ParentID != nil && !ValidID(*i.ParentID) {
		return ErrInvalid
	}
	return nil
}

type Folder struct {
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	Kind              string    `json:"kind"`
	CategoryCode      string    `json:"categoryCode"`
	ParentID          *string   `json:"parentId"`
	ThumbnailAssetIDs []string  `json:"thumbnailAssetIds"`
	Revision          int64     `json:"revision"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
	ItemCount         int64     `json:"itemCount"`
}
type FolderPatch struct {
	Name              *string  `json:"name"`
	ThumbnailAssetIDs []string `json:"thumbnailAssetIds"`
}

func (i FolderPatch) Validate() error {
	if i.Name == nil && i.ThumbnailAssetIDs == nil {
		return ErrInvalid
	}
	if i.Name != nil && !resource.Text(*i.Name, 120, true) || len(i.ThumbnailAssetIDs) > 100 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, id := range i.ThumbnailAssetIDs {
		if !ValidID(id) || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
	}
	return nil
}

type NodeContent struct {
	NodeType       string          `json:"nodeType"`
	NodeContent    json.RawMessage `json:"nodeContent"`
	AssetIDs       []string        `json:"assetIds"`
	ModelAssetIDs  []string        `json:"modelAssetIds"`
	PrimaryAssetID *string         `json:"primaryAssetId"`
	Text           *string         `json:"text"`
}
type NodeInput struct {
	Name             string      `json:"name"`
	Kind             string      `json:"kind"`
	CategoryCode     string      `json:"categoryCode"`
	FolderID         *string     `json:"folderId"`
	ItemType         string      `json:"itemType"`
	Content          NodeContent `json:"content"`
	ThumbnailAssetID *string     `json:"thumbnailAssetId"`
}

func (i NodeInput) Refs() ([]resource.AssetRef, error) {
	ids, e := resource.ExtractAssets(i.Content.NodeContent)
	if e != nil {
		return nil, ErrInvalid
	}
	refs := []resource.AssetRef{}
	all := map[string]bool{}
	media := map[string]bool{}
	model := map[string]bool{}
	add := func(id, kind string) error {
		if !ValidID(id) || all[id] {
			return ErrInvalid
		}
		all[id] = true
		refs = append(refs, resource.AssetRef{ID: id, Kind: kind})
		return nil
	}
	for _, id := range i.Content.AssetIDs {
		if add(id, "") != nil {
			return nil, ErrInvalid
		}
		media[id] = true
	}
	for _, id := range i.Content.ModelAssetIDs {
		if add(id, "MODEL") != nil {
			return nil, ErrInvalid
		}
		model[id] = true
	}
	for _, id := range ids {
		if !all[id] {
			return nil, ErrInvalid
		}
	}
	for id := range all {
		found := false
		for _, x := range ids {
			if x == id {
				found = true
			}
		}
		if !found && i.Content.PrimaryAssetID != nil && *i.Content.PrimaryAssetID == id {
			found = true
		}
		if !found {
			return nil, ErrInvalid
		}
	}
	if i.Content.PrimaryAssetID != nil && !all[*i.Content.PrimaryAssetID] {
		return nil, ErrInvalid
	}
	if i.ThumbnailAssetID != nil {
		if !ValidID(*i.ThumbnailAssetID) {
			return nil, ErrInvalid
		}
		if !all[*i.ThumbnailAssetID] {
			refs = append(refs, resource.AssetRef{ID: *i.ThumbnailAssetID, Kind: "IMAGE"})
		} else {
			for n := range refs {
				if refs[n].ID == *i.ThumbnailAssetID {
					if model[refs[n].ID] {
						return nil, ErrInvalid
					}
					refs[n].Kind = "IMAGE"
				}
			}
		}
	}
	return refs, nil
}
func (i NodeInput) Validate() error {
	if !resource.Text(i.Name, 120, true) || !ValidCategory(i.CategoryCode) || i.ItemType != "NODE" || i.FolderID != nil && !ValidID(*i.FolderID) || !resource.Text(i.Kind, 50, true) || !resource.Text(i.Content.NodeType, 100, true) || len(i.Content.NodeContent) > 1024*1024 || len(i.Content.NodeContent) == 0 || i.Content.NodeContent[0] != '{' || !json.Valid(i.Content.NodeContent) || len(i.Content.AssetIDs)+len(i.Content.ModelAssetIDs) > 500 || i.Content.Text != nil && !resource.Text(*i.Content.Text, 200000, false) {
		return ErrInvalid
	}
	switch strings.ToUpper(i.Kind) {
	case "TEXT", "IMAGE", "VIDEO", "AUDIO", "MODEL", "FILE", "SCRIPT", "STORYBOARD", "GROUP", "OTHER", "RH-TEXT", "RH-IMAGE", "RH-VIDEO", "RH-AUDIO", "RH-3D", "RH-SCRIPT", "RH-STORYBOARD", "RH-GROUP", "RH-DIRECTOR", "DIRECTOR":
	default:
		return ErrInvalid
	}
	_, e := i.Refs()
	return e
}

type Node struct {
	ID string `json:"id"`
	NodeInput
	Revision  int64     `json:"revision"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type EntryQuery struct {
	Page         int
	Size         int
	ParentID     *string
	CategoryCode string
	Keyword      string
	Recursive    bool
	Kind         string
	ItemType     string
	AfterTime    *time.Time
	BeforeTime   *time.Time
	NodeKind     string
	NodeTypes    []string
	FoldersOnly  bool
}

func (q EntryQuery) Validate() error {
	if !resource.Text(q.NodeKind, 100, false) || len(q.NodeTypes) > 100 {
		return ErrInvalid
	}
	for _, v := range q.NodeTypes {
		if !resource.Text(v, 100, true) {
			return ErrInvalid
		}
	}
	if q.Page < 1 || q.Page > 100000 || q.Size < 1 || q.Size > 100 || !resource.Text(q.Keyword, 300, false) || q.ParentID != nil && !ValidID(*q.ParentID) || q.CategoryCode != "" && !ValidCategory(q.CategoryCode) || !resource.Text(q.Kind, 50, false) || !resource.Text(q.ItemType, 50, false) || q.AfterTime != nil && q.BeforeTime != nil && q.AfterTime.After(*q.BeforeTime) {
		return ErrInvalid
	}
	return nil
}

type EntriesPage struct {
	Records []json.RawMessage `json:"records"`
	Page    int               `json:"page"`
	Current int               `json:"current"`
	Size    int               `json:"size"`
	Total   int64             `json:"total"`
	Pages   int64             `json:"pages"`
	HasNext bool              `json:"hasNext"`
}
type BatchCreate struct {
	Items                      []NodeInput `json:"items"`
	ExpectedCollectionRevision int64       `json:"expectedCollectionRevision"`
}

func (b BatchCreate) Validate() error {
	if len(b.Items) == 0 || len(b.Items) > 100 || b.ExpectedCollectionRevision < 1 {
		return ErrInvalid
	}
	for _, i := range b.Items {
		if e := i.Validate(); e != nil {
			return e
		}
	}
	return nil
}

type BatchMutation struct {
	ItemIDs                    []string `json:"itemIds"`
	FolderIDs                  []string `json:"folderIds"`
	ExpectedCollectionRevision int64    `json:"expectedCollectionRevision"`
	TargetCategoryCode         string   `json:"targetCategoryCode"`
	TargetFolderID             *string  `json:"targetFolderId"`
}

func (b BatchMutation) Validate(move bool) error {
	if len(b.ItemIDs)+len(b.FolderIDs) == 0 || len(b.ItemIDs)+len(b.FolderIDs) > 100 || b.ExpectedCollectionRevision < 1 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, ids := range [][]string{b.ItemIDs, b.FolderIDs} {
		for _, id := range ids {
			if !ValidID(id) || seen[id] {
				return ErrInvalid
			}
			seen[id] = true
		}
	}
	if move {
		if !ValidCategory(b.TargetCategoryCode) || b.TargetFolderID != nil && !ValidID(*b.TargetFolderID) {
			return ErrInvalid
		}
	} else if b.TargetCategoryCode != "" || b.TargetFolderID != nil {
		return ErrInvalid
	}
	return nil
}

type BatchResult struct {
	Revision   int64    `json:"revision"`
	ChangedIDs []string `json:"changedIds"`
	Items      []Node   `json:"items,omitempty"`
}
