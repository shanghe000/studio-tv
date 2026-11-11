package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/httpapi"
	library "studiotv.local/service/api/internal/modules/library/domain"
	resource "studiotv.local/service/api/internal/modules/resources/domain"
)

// Publications copy content, never the private library entry or its namespace.
// Only input/content fields can cross into a shared entry. Runtime authority,
// session identifiers, local paths and execution history are not portable.
func portableTeamNode(raw json.RawMessage) (json.RawMessage, error) {
	var original map[string]any
	if len(raw) > 1024*1024 || decodeTeamStrict(raw, &original) != nil || original == nil {
		return nil, teamInvalid()
	}
	denied := map[string]bool{}
	for _, k := range []string{"owner", "ownerId", "userId", "projectId", "sessionId", "accessToken", "refreshToken", "authorization", "cookie", "apiKey", "secret", "password", "grant", "grantId", "grants", "taskId", "executionId", "runId", "conversationId", "status", "progress", "history", "historyStorage", "__rhtv", "meta", "serverPath", "storageKey", "uploadUrl", "downloadUrl", "signedUrl"} {
		denied[strings.ToLower(k)] = true
	}
	var clean func(any, int) (any, error)
	clean = func(v any, depth int) (any, error) {
		if depth > 64 {
			return nil, teamInvalid()
		}
		switch x := v.(type) {
		case map[string]any:
			for k, z := range x {
				if denied[strings.ToLower(k)] {
					delete(x, k)
					continue
				}
				value, e := clean(z, depth+1)
				if e != nil {
					return nil, e
				}
				x[k] = value
			}
		case []any:
			for i, z := range x {
				value, e := clean(z, depth+1)
				if e != nil {
					return nil, e
				}
				x[i] = value
			}
		}
		return v, nil
	}
	out := map[string]any{}
	for _, k := range []string{"id", "type", "data", "position", "width", "height", "style"} {
		if v, ok := original[k]; ok {
			z, e := clean(v, 0)
			if e != nil {
				return nil, e
			}
			out[k] = z
		}
	}
	if _, ok := out["data"]; !ok {
		out["data"] = map[string]any{}
	}
	return json.Marshal(out)
}

func bareTeamContent(a sourceTeamAsset) library.NodeContent {
	nodeType := ""
	switch a.Kind {
	case "IMAGE":
		nodeType = "rh-image"
	case "VIDEO":
		nodeType = "rh-video"
	case "AUDIO":
		nodeType = "rh-audio"
	case "FILE":
		if a.MimeType == "model/gltf-binary" {
			nodeType = "rh-3d"
		}
	}
	content := library.NodeContent{NodeType: nodeType, AssetIDs: []string{a.ID}, ModelAssetIDs: []string{}, PrimaryAssetID: &a.ID, NodeContent: json.RawMessage(`{}`)}
	if nodeType != "" {
		raw, _ := json.Marshal(map[string]any{"type": nodeType, "position": map[string]int{"x": 0, "y": 0}, "data": map[string]string{"url": "rhtv-asset:" + a.ID, "title": a.FileName}})
		content.NodeContent = raw
	}
	if nodeType == "rh-3d" {
		content.AssetIDs = []string{}
		content.ModelAssetIDs = []string{a.ID}
	}
	return content
}

func teamWriteReceipt(ctx context.Context, tx pgx.Tx, actor, operation, key, hash string) ([]byte, error) {
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, actor+":"+operation+":"+key); e != nil {
		return nil, teamUnavailable()
	}
	var previous string
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT request_hash,response_body FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3`, actor, operation, key).Scan(&previous, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, teamUnavailable()
	}
	if previous != hash {
		return nil, httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "该幂等键已用于不同内容。")
	}
	return raw, nil
}
func saveTeamWriteReceipt(ctx context.Context, tx pgx.Tx, actor, operation, key, hash string, result any) error {
	raw, e := json.Marshal(result)
	if e != nil {
		return teamUnavailable()
	}
	if _, e = tx.Exec(ctx, `INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,201,$5)`, actor, operation, key, hash, raw); e != nil {
		return teamUnavailable()
	}
	return nil
}

func (s *TeamAssetService) Publish(ctx context.Context, actor, team string, input PublishTeamAsset, key string) (TeamEntry, error) {
	var result TeamEntry
	normalized, e := teamAssetKey(key)
	if e != nil {
		return result, e
	}
	key = normalized
	if (input.SourceAssetID == "") == (input.SourceNodeID == "") || input.Name != "" && !validTeamName(input.Name) || input.SourceRevision != nil && *input.SourceRevision < 1 {
		return result, teamInvalid()
	}
	sourceID := input.SourceAssetID
	if sourceID == "" {
		sourceID = input.SourceNodeID
	}
	if ValidateID(sourceID) != nil {
		return result, teamInvalid()
	}
	hash, e := copyHash(input)
	if e != nil {
		return result, e
	}
	err := teamTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, e := RequireTeam(ctx, tx, actor, team, EDITOR, true); e != nil {
			return e
		}
		if e := requireTeamFolder(ctx, tx, team, input.FolderID); e != nil {
			return e
		}
		operation := "TEAM_ASSET_PUBLISH:" + team
		raw, e := teamWriteReceipt(ctx, tx, actor, operation, key, hash)
		if e != nil {
			return e
		}
		if raw != nil {
			var old TeamEntry
			if json.Unmarshal(raw, &old) != nil {
				return teamUnavailable()
			}
			result, e = teamEntry(ctx, tx, team, old.ID, false)
			return e
		}
		var sourceCount int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM collaboration.team_entries WHERE team_id=$1 AND deleted_at IS NULL`, team).Scan(&sourceCount); e != nil {
			return teamUnavailable()
		}
		if sourceCount >= 5000 {
			return httpapi.Fail(409, "TEAM_ASSET_LIMIT", "团队共享条目数量已达上限。")
		}
		kind, version, name := "ASSET", "", input.Name
		content := library.NodeContent{}
		var thumbnail *string
		ids := []string{}
		if input.SourceAssetID != "" {
			a, e := loadTeamAsset(ctx, tx, input.SourceAssetID, true)
			if e != nil {
				return e
			}
			if a.OwnerID != actor || a.ProjectDeleted {
				return teamNotFound()
			}
			content = bareTeamContent(a)
			ids = []string{a.ID}
			version = a.ChecksumSHA256
			if name == "" {
				name = a.FileName
			}
			if a.Kind == "IMAGE" {
				thumbnail = &a.ID
			}
		} else {
			kind = "NODE"
			var source library.Node
			var raw []byte
			e = tx.QueryRow(ctx, `SELECT n.name,n.kind,n.category_code,n.content,n.thumbnail_asset_id,n.revision FROM library.nodes n WHERE n.id=$1 AND n.owner_id=$2 AND n.deleted_at IS NULL AND (n.folder_id IS NULL OR EXISTS(SELECT 1 FROM library.visible_folders f WHERE f.id=n.folder_id AND f.owner_id=n.owner_id)) FOR SHARE OF n`, input.SourceNodeID, actor).Scan(&source.Name, &source.Kind, &source.CategoryCode, &raw, &source.ThumbnailAssetID, &source.Revision)
			if errors.Is(e, pgx.ErrNoRows) {
				return teamNotFound()
			}
			if e != nil || json.Unmarshal(raw, &source.Content) != nil {
				return teamUnavailable()
			}
			if input.SourceRevision != nil && *input.SourceRevision != source.Revision {
				return teamVersion()
			}
			source.ItemType = "NODE"
			if source.NodeInput.Validate() != nil {
				return teamInvalid()
			}
			content = source.Content
			thumbnail = source.ThumbnailAssetID
			version = strconv.FormatInt(source.Revision, 10)
			if name == "" {
				name = source.Name
			}
			content.NodeContent, e = portableTeamNode(content.NodeContent)
			if e != nil {
				return e
			}
			extracted, e := resource.ExtractAssets(content.NodeContent)
			if e != nil {
				return teamInvalid()
			}
			present := map[string]bool{}
			for _, id := range extracted {
				present[id] = true
			}
			if content.PrimaryAssetID != nil {
				present[*content.PrimaryAssetID] = true
			}
			media := []string{}
			for _, id := range content.AssetIDs {
				if present[id] {
					media = append(media, id)
				}
			}
			content.AssetIDs = media
			models := []string{}
			for _, id := range content.ModelAssetIDs {
				if present[id] {
					models = append(models, id)
				}
			}
			content.ModelAssetIDs = models
			source.Content = content
			refs, e := source.NodeInput.Refs()
			if e != nil {
				return teamInvalid()
			}
			for _, ref := range refs {
				ids = append(ids, ref.ID)
			}
		}
		if !validTeamName(name) {
			return teamInvalid()
		}
		sources := []sourceTeamAsset{}
		if len(ids) > 0 {
			ids, e = normalizeCopyIDs(ids)
			if e != nil {
				return e
			}
		}
		for _, id := range ids {
			a, e := loadTeamAsset(ctx, tx, id, true)
			if e != nil {
				return e
			}
			if a.OwnerID != actor || a.ProjectDeleted {
				return teamNotFound()
			}
			if thumbnail != nil && id == *thumbnail && a.Kind != "IMAGE" {
				return teamInvalid()
			}
			for _, model := range content.ModelAssetIDs {
				if model == id && !(a.Kind == "FILE" && a.MimeType == "model/gltf-binary") {
					return teamInvalid()
				}
			}
			file, _, e := verifyTeamBlob(s.storageRoot, a)
			if e != nil {
				return e
			}
			_ = file.Close()
			sources = append(sources, a)
		}
		body, e := json.Marshal(content)
		if e != nil || len(body) > 1024*1024 {
			return teamInvalid()
		}
		id := teamID("tast")
		if _, e = tx.Exec(ctx, `INSERT INTO collaboration.team_entries(id,team_id,folder_id,name,kind,source_kind,source_id,source_version,source_owner_id,content,thumbnail_asset_id,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$8,$8)`, id, team, input.FolderID, strings.TrimSpace(name), kind, sourceID, version, actor, body, thumbnail); e != nil {
			return teamUnavailable()
		}
		for i, a := range sources {
			if _, e = tx.Exec(ctx, `INSERT INTO collaboration.team_asset_refs(entry_id,team_id,asset_id,asset_owner_id,sort_order) VALUES($1,$2,$3,$4,$5)`, id, team, a.ID, a.OwnerID, i); e != nil {
				return teamUnavailable()
			}
		}
		result, e = teamEntry(ctx, tx, team, id, false)
		if e != nil {
			return e
		}
		if e = saveTeamWriteReceipt(ctx, tx, actor, operation, key, hash, result); e != nil {
			return e
		}
		return Audit(ctx, tx, actor, "TEAM_ASSET_PUBLISH", "TEAM_ASSET", id, map[string]any{"teamId": team, "kind": kind, "assetCount": len(sources)})
	})
	return result, err
}

func (s *TeamAssetService) Import(ctx context.Context, actor, team, entryID, project, key string) (TeamImportResult, error) {
	var result TeamImportResult
	normalized, e := teamAssetKey(key)
	if e != nil {
		return result, e
	}
	key = normalized
	if ValidateID(entryID) != nil {
		return result, teamInvalid()
	}
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return result, teamUnavailable()
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	scope, e := RequireProject(ctx, tx, actor, project, EDITOR, true)
	if e != nil {
		return result, e
	}
	// Source TEAM is read-only during import. SHARE coordinates revocation
	// without upgrading a team grant lock already acquired by the target project.
	var locked string
	e = tx.QueryRow(ctx, `SELECT id FROM collaboration.teams WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, team).Scan(&locked)
	if errors.Is(e, pgx.ErrNoRows) {
		return result, teamNotFound()
	}
	if e != nil {
		return result, teamUnavailable()
	}
	if _, e = RequireTeam(ctx, tx, actor, team, VIEWER, false); e != nil {
		return result, e
	}
	entry, e := teamEntry(ctx, tx, team, entryID, false)
	if e != nil {
		return result, e
	}
	operation := "TEAM_ENTRY_IMPORT:" + team + ":" + entryID
	hash, _ := copyHash(map[string]string{"teamId": team, "entryId": entryID, "projectId": project})
	raw, e := copyReceipt(ctx, tx, actor, project, operation, key, hash)
	if e != nil {
		return result, e
	}
	if raw != nil {
		if json.Unmarshal(raw, &result) != nil {
			return result, teamUnavailable()
		}
		result.Node, e = canonicalTeamJSON(result.Node)
		if e != nil {
			return result, teamUnavailable()
		}
		result.Entry.Content.NodeContent, e = canonicalTeamJSON(result.Entry.Content.NodeContent)
		if e != nil {
			return result, teamUnavailable()
		}
		if e = validateCopyReplay(ctx, tx, s.storageRoot, scope, result.AssetCopyResult); e != nil {
			return result, e
		}
		return result, nil
	}
	sources := []sourceTeamAsset{}
	for _, dto := range entry.Assets {
		a, e := loadTeamAsset(ctx, tx, dto.ID, true)
		if e != nil {
			return result, e
		}
		sources = append(sources, a)
	}
	copied, created, e := createTeamCopies(ctx, tx, s.storageRoot, scope, sources, key, operation)
	if e != nil {
		cleanupTeamCopies(created)
		return result, e
	}
	result.AssetCopyResult = copied
	result.Entry = entry
	result.Entry.Content, e = remapTeamContent(entry.Content, copied.AssetIDMap)
	if e == nil && entry.ThumbnailAssetID != nil {
		v, ok := copied.AssetIDMap[*entry.ThumbnailAssetID]
		if !ok {
			e = teamUnavailable()
		} else {
			result.Entry.ThumbnailAssetID = &v
		}
	}
	result.Entry.Assets = copied.Assets
	result.Node = json.RawMessage(`null`)
	if e == nil && entry.Content.NodeType != "" {
		var node map[string]any
		e = decodeTeamStrict(result.Entry.Content.NodeContent, &node)
		if e == nil {
			node["id"] = teamID("node")
			node["type"] = entry.Content.NodeType
			result.Node, e = json.Marshal(node)
		}
	}
	if e == nil {
		e = saveCopyReceipt(ctx, tx, actor, project, operation, key, hash, result)
	}
	if e == nil {
		e = Audit(ctx, tx, actor, "TEAM_ASSET_IMPORT", "PROJECT", project, map[string]any{"teamId": team, "entryId": entryID, "assetCount": len(copied.Assets)})
	}
	if e != nil {
		cleanupTeamCopies(created)
		return result, e
	}
	if e = tx.Commit(ctx); e != nil {
		return result, teamUnavailable()
	}
	return result, nil
}
