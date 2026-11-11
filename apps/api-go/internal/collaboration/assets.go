package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/httpapi"
)

// GraphAssetIDs recognizes exactly the legacy graph's assetId fields and
// rhtv-asset: references. Arbitrary strings containing an ID do not grant access.
func GraphAssetIDs(raw []byte) (map[string]bool, error) {
	var graph any
	if err := json.Unmarshal(raw, &graph); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	var visit func(any)
	visit = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				if k == "assetId" {
					if s, ok := c.(string); ok && s != "" {
						ids[s] = true
					}
				}
				visit(c)
			}
		case []any:
			for _, c := range x {
				visit(c)
			}
		case string:
			if strings.HasPrefix(x, "rhtv-asset:") {
				ids[strings.TrimPrefix(x, "rhtv-asset:")] = true
			}
		}
	}
	visit(graph)
	return ids, nil
}

// AuthorizeProjectAssets is intended to run after the caller has locked its
// project for writes. Storage ownership alone never grants a collaborator use
// of assets from another private project owned by the same canonical owner.
func AuthorizeProjectAssets(ctx context.Context, db DB, actorID, projectID string, assetIDs []string) error {
	access, err := RequireProject(ctx, db, actorID, projectID, VIEWER, false)
	if err != nil {
		return err
	}
	if len(assetIDs) == 0 {
		return nil
	}
	var graph []byte
	if err = db.QueryRow(ctx, `SELECT graph FROM public.projects WHERE id=$1`, projectID).Scan(&graph); err != nil {
		return err
	}
	refs, err := GraphAssetIDs(graph)
	if err != nil {
		return err
	}
	unique := map[string]bool{}
	for _, id := range assetIDs {
		if ValidateID(id) != nil {
			return httpapi.Fail(422, "ASSET_UNAVAILABLE", "素材引用格式无效。")
		}
		unique[id] = true
	}
	query := `SELECT a.id,a.owner_id,a.project_id,EXISTS(SELECT 1 FROM public.projects p WHERE p.id=a.project_id AND p.owner_id=$2 AND p.deleted_at IS NULL) FROM public.assets a WHERE a.id=ANY($1::text[]) AND a.state='READY' AND a.deleted_at IS NULL ORDER BY a.id`
	var readOnly string
	if err = db.QueryRow(ctx, `SELECT current_setting('transaction_read_only')`).Scan(&readOnly); err != nil {
		return err
	}
	if readOnly != "on" {
		query += ` FOR SHARE OF a`
	}
	rows, err := db.Query(ctx, query, assetIDs, actorID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, owner, pid string
		var sourceOwned bool
		if err = rows.Scan(&id, &owner, &pid, &sourceOwned); err != nil {
			return err
		}
		if pid == projectID && owner == access.StorageOwnerID || refs[id] && owner == access.StorageOwnerID || actorID == access.StorageOwnerID && owner == actorID && sourceOwned {
			delete(unique, id)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if len(unique) > 0 {
		return httpapi.Fail(422, "ASSET_UNAVAILABLE", "素材不存在、未就绪或不在当前项目可引用范围。")
	}
	return nil
}

// RequireAssetProjectRead resolves a visible project containing the asset or an
// actual stored graph reference. Team publication is checked separately by
// RequireAssetGrant, so deleting the source private project cannot retract it.
func RequireAssetProjectRead(ctx context.Context, db DB, actorID, assetID string) error {
	var pid, storageOwner string
	err := db.QueryRow(ctx, `SELECT project_id,owner_id FROM public.assets WHERE id=$1 AND deleted_at IS NULL`, assetID).Scan(&pid, &storageOwner)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	if err != nil {
		return err
	}
	// Private asset vaults/studio storage are not collaborative projects. The
	// actual owning actor retains their private media without exposing the
	// vault through project membership or a substituted storage owner.
	var privateOwner bool
	if err = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.assets a JOIN public.projects p ON p.id=a.project_id JOIN public.users u ON u.id=$1 AND NOT u.disabled WHERE a.id=$2 AND a.owner_id=$1 AND p.owner_id=$1 AND p.internal_kind IS NOT NULL AND p.deleted_at IS NULL AND a.deleted_at IS NULL)`, actorID, assetID).Scan(&privateOwner); err != nil {
		return err
	}
	if privateOwner {
		return nil
	}
	access, accessErr := RequireProject(ctx, db, actorID, pid, VIEWER, false)
	err = accessErr
	if err == nil {
		if access.StorageOwnerID == storageOwner {
			return nil
		}
		err = httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Status != 404 {
		return err
	}
	// Candidate filtering only reduces work; exact parsed references grant access.
	rows, err := db.Query(ctx, `SELECT p.graph,p.cover_asset_id FROM public.projects p WHERE p.owner_id=$4 AND collaboration.project_role(p.id,$1) IS NOT NULL AND (p.graph::text LIKE $2 OR p.cover_asset_id=$3)`, actorID, "%"+strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(assetID)+"%", assetID, storageOwner)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var cover *string
		if err = rows.Scan(&raw, &cover); err != nil {
			return err
		}
		if cover != nil && *cover == assetID {
			return nil
		}
		refs, e := GraphAssetIDs(raw)
		if e != nil {
			return e
		}
		if refs[assetID] {
			return nil
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
}
