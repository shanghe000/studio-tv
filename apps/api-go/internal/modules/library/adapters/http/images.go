package http

import (
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/library/domain"
)

func (h handler) images(w http.ResponseWriter, r *http.Request) error {
	g, e := h.service.Get(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return entryOutput(w, r, 200, g.Revision, map[string]any{"assetIds": g.AssetIDs, "mainAssetId": g.MainAssetID, "revision": g.Revision})
}
func (h handler) mutateImages(op string) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		expected, e := revision(r)
		if e != nil {
			return e
		}
		id := chi.URLParam(r, "id")
		g, e := h.service.Get(r.Context(), actor(r), id)
		if e != nil {
			return e
		}
		if g.Revision != expected {
			return &domain.VersionConflict{Current: g.Revision}
		}
		switch op {
		case "add", "order":
			var body struct {
				AssetIDs []string `json:"assetIds"`
			}
			if e = httpapi.Decode(w, r, &body); e != nil {
				return e
			}
			if body.AssetIDs == nil {
				return domain.ErrInvalid
			}
			if op == "add" {
				g.AssetIDs = append(g.AssetIDs, body.AssetIDs...)
			} else {
				if len(body.AssetIDs) != len(g.AssetIDs) {
					return domain.ErrInvalid
				}
				seen := map[string]bool{}
				for _, id := range g.AssetIDs {
					seen[id] = true
				}
				for _, id := range body.AssetIDs {
					if !seen[id] {
						return domain.ErrInvalid
					}
					delete(seen, id)
				}
				g.AssetIDs = body.AssetIDs
			}
		case "main":
			var body struct {
				AssetID *string `json:"assetId"`
			}
			if e = httpapi.Decode(w, r, &body); e != nil {
				return e
			}
			g.MainAssetID = body.AssetID
		case "delete":
			aid := chi.URLParam(r, "imageId")
			ids := []string{}
			found := false
			for _, id := range g.AssetIDs {
				if id == aid {
					found = true
				} else {
					ids = append(ids, id)
				}
			}
			if !found {
				return domain.ErrNotFound
			}
			g.AssetIDs = ids
			if g.MainAssetID != nil && *g.MainAssetID == aid {
				g.MainAssetID = nil
			}
		}
		next, e := h.service.Update(r.Context(), actor(r), id, g.Input, expected)
		if e != nil {
			return e
		}
		return entryOutput(w, r, 200, next.Revision, galleryView(next))
	}
}
