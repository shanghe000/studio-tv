package core

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
)

const projectPreviewLimit = 100

type projectPreviewQuery struct {
	ProjectIDs []string `json:"projectIds"`
}

type projectPreviewThumbnail struct {
	AssetID      string `json:"assetId"`
	URL          string `json:"url"`
	URLsExpireAt string `json:"urlsExpireAt"`
}

type projectPreview struct {
	Project    map[string]any           `json:"project"`
	Role       string                   `json:"role"`
	NodesCount int                      `json:"nodesCount"`
	Thumbnail  *projectPreviewThumbnail `json:"thumbnail"`
}

type projectPreviewRecord struct {
	Project    Project
	NodesCount int
	AssetID    *string
}

// Only metadata, a node count and one owned image ID cross the database
// boundary. This is one statement for the whole page, including ACL and cover
// selection, rather than a loop of project, snapshot and asset queries.
const projectPreviewSQL = `WITH requested AS (
 SELECT id,ordinality FROM unnest($2::text[]) WITH ORDINALITY AS ids(id,ordinality)
), visible AS MATERIALIZED (
 SELECT p.id,p.owner_id,p.name,p.cover_asset_id,p.pinned,p.revision,p.created_at,p.updated_at,p.graph,
        requested.ordinality,collaboration.project_role(p.id,$1) AS role
 FROM requested JOIN public.projects p ON p.id=requested.id
 WHERE p.deleted_at IS NULL AND p.internal_kind IS NULL
), permitted AS (
 SELECT * FROM visible WHERE role IS NOT NULL
)
SELECT p.id,p.owner_id,p.name,p.cover_asset_id,p.pinned,p.revision,p.created_at,p.updated_at,p.role,
       (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.graph->'nodes')='array' THEN p.graph->'nodes' ELSE '[]'::jsonb END) AS n(node)
        WHERE node->>'id' IS DISTINCT FROM 'rhtv_meta_v1')::int,
       COALESCE(cover.id,image.id)
FROM permitted p
LEFT JOIN public.assets cover ON cover.id=p.cover_asset_id AND cover.owner_id=p.owner_id
 AND cover.deleted_at IS NULL AND cover.state='READY' AND cover.kind='IMAGE' AND cover.mime_type LIKE 'image/%'
LEFT JOIN LATERAL (
 SELECT a.id FROM (
  SELECT refs.asset_id,n.node_order,refs.reference_order
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.graph->'nodes')='array' THEN p.graph->'nodes' ELSE '[]'::jsonb END) WITH ORDINALITY AS n(node,node_order)
  CROSS JOIN LATERAL (
   SELECT reference#>>'{}' AS asset_id,reference_order
   FROM jsonb_path_query(n.node,'$.**.assetId ? (@.type() == "string")') WITH ORDINALITY AS matches(reference,reference_order)
   UNION ALL
   SELECT substring(reference#>>'{}' FROM 12) AS asset_id,reference_order
   FROM jsonb_path_query(n.node->'data','$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(^url$|^urls$|^image$|^images$|^file$|^files$|^source$|^sources$|^sourceObjects$|^outputs$|^result$|^results$|Urls?$)" flag "i").value[*] ? (@.type() == "string" && @ like_regex "^rhtv-asset:")') WITH ORDINALITY AS matches(reference,reference_order)
  ) refs
  WHERE cover.id IS NULL AND n.node->>'id' IS DISTINCT FROM 'rhtv_meta_v1' AND n.node->>'type' IN ('image','rh-image')
 ) candidates
 JOIN public.assets a ON a.id=candidates.asset_id AND a.owner_id=p.owner_id
 WHERE a.deleted_at IS NULL AND a.state='READY' AND a.kind='IMAGE' AND a.mime_type LIKE 'image/%'
 ORDER BY candidates.node_order,candidates.reference_order,a.id
 LIMIT 1
) image ON true
ORDER BY p.ordinality`

func validateProjectPreviewQuery(input projectPreviewQuery) error {
	if len(input.ProjectIDs) < 1 || len(input.ProjectIDs) > projectPreviewLimit {
		return httpapi.Fail(400, "VALIDATION_FAILED", "项目预览一次需要 1 至 100 个项目。")
	}
	seen := make(map[string]bool, len(input.ProjectIDs))
	for _, id := range input.ProjectIDs {
		if collaboration.ValidateID(id) != nil || seen[id] {
			return httpapi.Fail(400, "VALIDATION_FAILED", "项目ID格式无效或重复。")
		}
		seen[id] = true
	}
	return nil
}

func loadProjectPreviews(ctx context.Context, db DB, actorID string, ids []string) ([]projectPreviewRecord, error) {
	rows, err := db.Query(ctx, projectPreviewSQL, actorID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]projectPreviewRecord, 0, len(ids))
	for rows.Next() {
		var item projectPreviewRecord
		p := &item.Project
		if err = rows.Scan(&p.ID, &p.OwnerID, &p.Name, &p.CoverAssetID, &p.Pinned, &p.Revision, &p.CreatedAt, &p.UpdatedAt, &p.Role, &item.NodesCount, &item.AssetID); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// No partial page, and the same error for missing, deleted, internal and
	// unauthorized projects. No metadata from the other entries is emitted.
	if len(items) != len(ids) {
		return nil, httpapi.Fail(404, "PROJECT_NOT_FOUND", "项目不存在。")
	}
	return items, nil
}

func (s *Server) projectPreviews(r chi.Router) {
	s.route(r, http.MethodPost, "/api/v2/project-previews/query", true, s.queryProjectPreviews)
}

func (s *Server) queryProjectPreviews(w http.ResponseWriter, r *http.Request) error {
	if err := queryKeys(r); err != nil {
		return err
	}
	var input projectPreviewQuery
	if err := httpapi.DecodeLimit(w, r, &input, 8192); err != nil {
		return err
	}
	if err := validateProjectPreviewQuery(input); err != nil {
		return err
	}
	records, err := loadProjectPreviews(r.Context(), s.db, owner(r), input.ProjectIDs)
	if err != nil {
		return err
	}
	items := make([]projectPreview, 0, len(records))
	for _, record := range records {
		item := projectPreview{Project: record.Project.Public(), Role: record.Project.Role, NodesCount: record.NodesCount}
		if record.AssetID != nil {
			// Match the existing private asset-read protocol: the actual actor
			// and local session are bound, and readAsset rechecks current ACL.
			token, e := s.tokens.Sign(map[string]any{"sub": owner(r), "aid": *record.AssetID, "sid": httpapi.IdentityFrom(r).SessionID}, "asset-read", 15*time.Minute)
			if e != nil {
				return e
			}
			item.Thumbnail = &projectPreviewThumbnail{AssetID: *record.AssetID, URL: s.cfg.PublicBaseURL + "/storage/assets/" + *record.AssetID + "?token=" + url.QueryEscape(token), URLsExpireAt: iso(time.Now().Add(15 * time.Minute))}
		}
		items = append(items, item)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	return httpapi.OK(w, r, http.StatusOK, map[string]any{"items": items})
}
