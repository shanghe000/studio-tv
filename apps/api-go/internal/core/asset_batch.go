package core

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
)

const assetResolveBatchLimit = 100

type assetResolveBatchRequest struct {
	AssetIDs []string `json:"assetIds"`
}

func assetResolveBatchIDs(input assetResolveBatchRequest) ([]string, error) {
	if input.AssetIDs == nil || len(input.AssetIDs) > assetResolveBatchLimit {
		return nil, httpapi.Fail(400, "VALIDATION_FAILED", "每次最多读取100项素材。")
	}
	ids := make([]string, 0, len(input.AssetIDs))
	seen := map[string]bool{}
	for _, id := range input.AssetIDs {
		if err := requireID(id); err != nil {
			return nil, err
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (s *Server) assetBatch(r chi.Router) {
	s.route(r, http.MethodPost, "/api/v2/assets/resolve-batch", true, s.resolveAssetBatch)
}

// One authenticated read replaces N browser requests, while every requested
// asset still passes the same live local ACL and deletion checks as GET asset.
// No partial metadata or signed URL is written if any item fails validation.
func (s *Server) resolveAssetBatch(w http.ResponseWriter, r *http.Request) error {
	if r.URL.RawQuery != "" {
		return httpapi.Fail(400, "VALIDATION_FAILED", "此素材接口不接受查询参数。")
	}
	var input assetResolveBatchRequest
	if err := httpapi.DecodeLimit(w, r, &input, 16*1024); err != nil {
		return err
	}
	ids, err := assetResolveBatchIDs(input)
	if err != nil {
		return err
	}
	assets := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		asset, err := accessibleAsset(r.Context(), s.db, owner(r), id, false)
		if err != nil {
			return err
		}
		if asset.State != "READY" {
			return httpapi.Fail(409, "ASSET_NOT_READY", "参考素材尚未就绪，请等待上传完成或重新选择素材。")
		}
		public, err := s.publicAsset(r, asset)
		if err != nil {
			return err
		}
		assets = append(assets, public)
	}
	w.Header().Set("Cache-Control", "no-store")
	return httpapi.OK(w, r, http.StatusOK, map[string]any{"assets": assets})
}
