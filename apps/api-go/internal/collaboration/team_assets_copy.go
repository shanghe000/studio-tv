package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/httpapi"
	library "studiotv.local/service/api/internal/modules/library/domain"
)

type sourceTeamAsset struct {
	TeamAssetDTO
	OwnerID, ProjectID string
	StorageKey         *string
	ProjectDeleted     bool
}

func loadTeamAsset(ctx context.Context, db DB, id string, lock bool) (sourceTeamAsset, error) {
	var a sourceTeamAsset
	if ValidateID(id) != nil {
		return a, teamInvalid()
	}
	query := `SELECT a.id,a.kind,a.mime_type,a.file_name,a.byte_size,a.checksum_sha256,a.width,a.height,a.duration_seconds,a.owner_id,a.project_id,a.storage_key,p.deleted_at IS NOT NULL FROM public.assets a JOIN public.projects p ON p.id=a.project_id WHERE a.id=$1 AND a.state='READY' AND a.deleted_at IS NULL`
	if lock {
		query += ` FOR SHARE OF a`
	}
	err := db.QueryRow(ctx, query, id).Scan(&a.ID, &a.Kind, &a.MimeType, &a.FileName, &a.ByteSize, &a.ChecksumSHA256, &a.Width, &a.Height, &a.DurationSeconds, &a.OwnerID, &a.ProjectID, &a.StorageKey, &a.ProjectDeleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在或尚未就绪。")
	}
	if err != nil {
		return a, teamUnavailable()
	}
	if a.ByteSize < 1 || a.ByteSize > 536870912 || len(a.ChecksumSHA256) != 64 || a.StorageKey != nil && *a.StorageKey != a.ID {
		return a, teamUnavailable()
	}
	if _, err := hex.DecodeString(a.ChecksumSHA256); err != nil {
		return a, teamUnavailable()
	}
	return a, nil
}

// RequireAssetGrant is deliberately independent of asset owner. Callers must
// already verify the real issuing session and application access. It does not
// grant writes or authority over the publisher's other personal assets.
func RequireAssetGrant(ctx context.Context, db DB, actorID, assetID string) error {
	var granted bool
	err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.team_asset_refs r JOIN collaboration.team_entries e ON e.id=r.entry_id AND e.team_id=r.team_id JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.asset_owner_id WHERE r.asset_id=$1 AND e.deleted_at IS NULL AND a.state='READY' AND a.deleted_at IS NULL AND collaboration.team_role(r.team_id,$2) IS NOT NULL)`, assetID, actorID).Scan(&granted)
	if err != nil {
		return teamUnavailable()
	}
	if !granted {
		return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	return nil
}

// RequireAssetGrantForUse holds the source TEAM grant until the caller's write
// transaction finishes. Input acceptance must use this form so membership or
// publication revocation cannot commit between authorization and binding.
func RequireAssetGrantForUse(ctx context.Context, tx pgx.Tx, actorID, assetID string) error {
	if tx == nil {
		return teamUnavailable()
	}
	return lockTeamReadGrant(ctx, tx, actorID, assetID)
}

func lockTeamReadGrant(ctx context.Context, tx pgx.Tx, actor, assetID string) error {
	var team string
	err := tx.QueryRow(ctx, `SELECT r.team_id FROM collaboration.team_asset_refs r JOIN collaboration.team_entries e ON e.id=r.entry_id AND e.team_id=r.team_id JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.asset_owner_id WHERE r.asset_id=$1 AND e.deleted_at IS NULL AND a.state='READY' AND a.deleted_at IS NULL AND collaboration.team_role(r.team_id,$2) IS NOT NULL ORDER BY r.team_id,r.entry_id LIMIT 1`, assetID, actor).Scan(&team)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	if err != nil {
		return teamUnavailable()
	}
	// Member/entry mutations hold the team row FOR UPDATE. A shared lock permits
	// reads while preventing a membership revoke from committing during a copy.
	var active string
	if err = tx.QueryRow(ctx, `SELECT id FROM collaboration.teams WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, team).Scan(&active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
		}
		return err
	}
	if _, err = RequireTeam(ctx, tx, actor, team, "VIEWER", false); err != nil {
		return err
	}
	var granted bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.team_asset_refs r JOIN collaboration.team_entries e ON e.id=r.entry_id AND e.team_id=r.team_id JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.asset_owner_id WHERE r.asset_id=$1 AND r.team_id=$2 AND e.deleted_at IS NULL AND a.state='READY' AND a.deleted_at IS NULL AND collaboration.team_role($2,$3) IS NOT NULL)`, assetID, team, actor).Scan(&granted); err != nil {
		return teamUnavailable()
	}
	if !granted {
		return httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	return nil
}

type AssetCopyResult struct {
	TargetProjectID string            `json:"targetProjectId"`
	AssetIDMap      map[string]string `json:"assetIdMap"`
	Assets          []TeamAssetDTO    `json:"assets"`
}
type TeamImportResult struct {
	AssetCopyResult
	Entry TeamEntry       `json:"entry"`
	Node  json.RawMessage `json:"node"`
}

func copyHash(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", teamInvalid()
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
func normalizeCopyIDs(ids []string) ([]string, error) {
	if len(ids) < 1 || len(ids) > 500 {
		return nil, teamInvalid()
	}
	out := append([]string(nil), ids...)
	sort.Strings(out)
	for i, id := range out {
		if ValidateID(id) != nil || i > 0 && id == out[i-1] {
			return nil, teamInvalid()
		}
	}
	return out, nil
}
func copyReceipt(ctx context.Context, tx pgx.Tx, actor, project, operation, key, hash string) ([]byte, error) {
	if len(key) < 1 || len(key) > 200 {
		return nil, teamInvalid()
	}
	keyHash, _ := copyHash(key)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, actor+":"+project+":"+operation+":"+keyHash); err != nil {
		return nil, teamUnavailable()
	}
	var oldHash string
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT request_hash,result FROM collaboration.asset_import_receipts WHERE actor_id=$1 AND project_id=$2 AND operation=$3 AND key_hash=$4`, actor, project, operation, keyHash).Scan(&oldHash, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, teamUnavailable()
	}
	if oldHash != hash {
		return nil, httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "该幂等键已用于不同导入内容。")
	}
	return raw, nil
}
func saveCopyReceipt(ctx context.Context, tx pgx.Tx, actor, project, operation, key, hash string, result any) error {
	keyHash, _ := copyHash(key)
	raw, err := json.Marshal(result)
	if err != nil {
		return teamUnavailable()
	}
	if _, err = tx.Exec(ctx, `INSERT INTO collaboration.asset_import_receipts(actor_id,project_id,operation,key_hash,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)`, actor, project, operation, keyHash, hash, raw); err != nil {
		return teamUnavailable()
	}
	return nil
}
func copiedAssetID(actor, project, operation, key, source string) string {
	sum := sha256.Sum256([]byte(actor + "\x00" + project + "\x00" + operation + "\x00" + key + "\x00" + source))
	return "ast_" + hex.EncodeToString(sum[:])[:48]
}

func verifyTeamBlob(root string, a sourceTeamAsset) (*os.File, os.FileInfo, error) {
	path := filepath.Join(root, a.ID)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != a.ByteSize {
		return nil, nil, httpapi.Retry(503, "ASSET_STORAGE_UNAVAILABLE", "素材文件暂不可用。")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, httpapi.Retry(503, "ASSET_STORAGE_UNAVAILABLE", "素材文件暂不可用。")
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		file.Close()
		return nil, nil, teamUnavailable()
	}
	hasher := sha256.New()
	n, err := io.Copy(hasher, io.LimitReader(file, a.ByteSize+1))
	if err != nil || n != a.ByteSize || hex.EncodeToString(hasher.Sum(nil)) != strings.ToLower(a.ChecksumSHA256) {
		file.Close()
		return nil, nil, httpapi.Retry(503, "ASSET_INTEGRITY_UNAVAILABLE", "素材完整性校验失败。")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return nil, nil, teamUnavailable()
	}
	return file, opened, nil
}
func materializeTeamCopy(root string, source sourceTeamAsset, id string) (bool, error) {
	file, _, err := verifyTeamBlob(root, source)
	if err != nil {
		return false, err
	}
	defer file.Close()
	destination := filepath.Join(root, id)
	// Separate inodes make the project copy independent even if the publisher's
	// original file is later corrupted. Never overwrite an existing destination.
	if _, e := os.Lstat(destination); e == nil {
		existing := source
		existing.ID = id
		existing.StorageKey = &id
		opened, _, e := verifyTeamBlob(root, existing)
		if e != nil {
			return false, httpapi.Fail(409, "ASSET_COPY_CONFLICT", "导入文件与已有记录冲突。")
		}
		_ = opened.Close()
		return false, nil
	} else if !errors.Is(e, os.ErrNotExist) {
		return false, teamUnavailable()
	}

	output, e := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0640)
	if e != nil {
		return false, httpapi.Retry(503, "ASSET_STORAGE_UNAVAILABLE", "素材复制暂不可用。")
	}
	good := false
	defer func() {
		_ = output.Close()
		if !good {
			_ = os.Remove(destination)
		}
	}()
	hasher := sha256.New()
	n, e := io.Copy(io.MultiWriter(output, hasher), io.LimitReader(file, source.ByteSize+1))
	if e != nil || n != source.ByteSize || hex.EncodeToString(hasher.Sum(nil)) != strings.ToLower(source.ChecksumSHA256) {
		return false, teamUnavailable()
	}
	if output.Sync() != nil || output.Chmod(0440) != nil || output.Close() != nil {
		return false, teamUnavailable()
	}
	good = true
	return true, nil
}

func createTeamCopies(ctx context.Context, tx pgx.Tx, root string, scope ProjectAccess, sources []sourceTeamAsset, key, operation string) (AssetCopyResult, []string, error) {
	result := AssetCopyResult{TargetProjectID: scope.ProjectID, AssetIDMap: map[string]string{}, Assets: []TeamAssetDTO{}}
	created := []string{}
	var total int64
	for _, source := range sources {
		total += source.ByteSize
		if total > 1073741824 {
			return result, created, httpapi.Fail(413, "ASSET_COPY_TOO_LARGE", "一次导入的素材总量超过限制。")
		}
		if ctx.Err() != nil {
			return result, created, ctx.Err()
		}
		id := copiedAssetID(scope.ActorID, scope.ProjectID, operation, key, source.ID)
		newFile, err := materializeTeamCopy(root, source, id)
		if err != nil {
			return result, created, err
		}
		if newFile {
			created = append(created, filepath.Join(root, id))
		}
		provenance, _ := json.Marshal(map[string]any{"source": "COLLABORATION_IMPORT", "sourceAssetId": source.ID, "importedBy": scope.ActorID})
		var asset TeamAssetDTO
		err = tx.QueryRow(ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,duration_seconds,storage_key,provenance,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'READY',$9,$10,$11,$1,$12,$13) RETURNING id,kind,mime_type,file_name,byte_size,checksum_sha256,width,height,duration_seconds`, id, scope.StorageOwnerID, scope.ProjectID, source.FileName, source.Kind, source.MimeType, source.ByteSize, source.ChecksumSHA256, source.Width, source.Height, source.DurationSeconds, provenance, scope.ActorID).Scan(&asset.ID, &asset.Kind, &asset.MimeType, &asset.FileName, &asset.ByteSize, &asset.ChecksumSHA256, &asset.Width, &asset.Height, &asset.DurationSeconds)
		if err != nil {
			return result, created, teamUnavailable()
		}
		result.AssetIDMap[source.ID] = id
		result.Assets = append(result.Assets, asset)
	}
	return result, created, nil
}
func validateCopyReplay(ctx context.Context, tx pgx.Tx, root string, scope ProjectAccess, result AssetCopyResult) error {
	if result.TargetProjectID != scope.ProjectID || len(result.Assets) > 500 || len(result.AssetIDMap) != len(result.Assets) {
		return teamUnavailable()
	}
	values := map[string]bool{}
	for old, id := range result.AssetIDMap {
		if ValidateID(old) != nil || ValidateID(id) != nil || values[id] {
			return teamUnavailable()
		}
		values[id] = true
	}
	for _, dto := range result.Assets {
		if !values[dto.ID] {
			return teamUnavailable()
		}
		delete(values, dto.ID)
		a, err := loadTeamAsset(ctx, tx, dto.ID, true)
		if err != nil {
			return err
		}
		identity := result.AssetIDMap[dto.ID] == dto.ID
		if identity {
			if err = AuthorizeProjectAssets(ctx, tx, scope.ActorID, scope.ProjectID, []string{dto.ID}); err != nil {
				return err
			}
		} else if a.OwnerID != scope.StorageOwnerID || a.ProjectID != scope.ProjectID {
			return teamUnavailable()
		}
		if a.ChecksumSHA256 != dto.ChecksumSHA256 || a.ByteSize != dto.ByteSize {
			return teamUnavailable()
		}
		file, _, err := verifyTeamBlob(root, a)
		if err != nil {
			return err
		}
		_ = file.Close()
	}
	return nil
}
func cleanupTeamCopies(paths []string) {
	for _, path := range paths {
		_ = os.Remove(path)
	}
}

// CopyAssetsToProject keeps the real actor separate from the target storage
// owner. It creates immutable new IDs/bytes and records actor-scoped receipts;
// its caller later saves the remapped graph through normal canvas commands.
func CopyAssetsToProject(ctx context.Context, pool *pgxpool.Pool, storageRoot, actorID, targetProjectID string, sourceAssetIDs []string, logicalKey string) (AssetCopyResult, error) {
	var result AssetCopyResult
	ids, err := normalizeCopyIDs(sourceAssetIDs)
	if err != nil {
		return result, err
	}
	if pool == nil || storageRoot == "" || len(logicalKey) < 1 || len(logicalKey) > 200 {
		return result, teamInvalid()
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return result, teamUnavailable()
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	// Acquire all involved project rows in one order. Their membership writers
	// take the same locks, including when copying across projects in both directions.
	projects := map[string]bool{targetProjectID: true}
	for _, id := range ids {
		a, e := loadTeamAsset(ctx, tx, id, false)
		if e != nil {
			return result, e
		}
		projects[a.ProjectID] = true
	}
	pids := []string{}
	for id := range projects {
		pids = append(pids, id)
	}
	sort.Strings(pids)
	rows, e := tx.Query(ctx, `SELECT id FROM public.projects WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, pids)
	if e != nil {
		return result, teamUnavailable()
	}
	for rows.Next() {
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return result, teamUnavailable()
	}
	scope, err := RequireProject(ctx, tx, actorID, targetProjectID, "EDITOR", true)
	if err != nil {
		return result, err
	}
	operation := "PROJECT_ASSET_IMPORT"
	hash, _ := copyHash(ids)
	raw, err := copyReceipt(ctx, tx, actorID, targetProjectID, operation, logicalKey, hash)
	if err != nil {
		return result, err
	}
	if raw != nil {
		if json.Unmarshal(raw, &result) != nil {
			return result, teamUnavailable()
		}
		if err = validateCopyReplay(ctx, tx, storageRoot, scope, result); err != nil {
			return result, err
		}
		return result, nil
	}
	sources := []sourceTeamAsset{}
	existing := []sourceTeamAsset{}
	for _, id := range ids {
		a, err := loadTeamAsset(ctx, tx, id, true)
		if err != nil {
			return result, err
		}
		if e := AuthorizeProjectAssets(ctx, tx, actorID, targetProjectID, []string{id}); e == nil {
			existing = append(existing, a)
			continue
		} else {
			var policy *httpapi.Error
			if !errors.As(e, &policy) {
				return result, e
			}
		}
		if a.OwnerID == actorID && !a.ProjectDeleted {
			sources = append(sources, a)
			continue
		}
		if _, e := RequireProject(ctx, tx, actorID, a.ProjectID, "VIEWER", false); e != nil {
			var policy *httpapi.Error
			if !errors.As(e, &policy) || policy.Status != 404 {
				return result, e
			}
			if e = lockTeamReadGrant(ctx, tx, actorID, id); e != nil {
				return result, e
			}
		}
		sources = append(sources, a)
	}
	result, created, err := createTeamCopies(ctx, tx, storageRoot, scope, sources, logicalKey, operation)
	if err != nil {
		cleanupTeamCopies(created)
		return result, err
	}
	for _, a := range existing {
		result.AssetIDMap[a.ID] = a.ID
		result.Assets = append(result.Assets, a.TeamAssetDTO)
	}
	if err = saveCopyReceipt(ctx, tx, actorID, targetProjectID, operation, logicalKey, hash, result); err == nil {
		err = Audit(ctx, tx, actorID, "PROJECT_ASSET_IMPORT", "PROJECT", targetProjectID, map[string]any{"assetCount": len(result.Assets)})
	}
	if err != nil {
		cleanupTeamCopies(created)
		return result, err
	}
	// An uncertain COMMIT is reported as unavailable; preserve physical copies
	// so a later receipt replay can recover a commit that actually succeeded.
	if err = tx.Commit(ctx); err != nil {
		return result, teamUnavailable()
	}
	return result, nil
}

func remapTeamContent(content library.NodeContent, mapping map[string]string) (library.NodeContent, error) {
	out := content
	out.AssetIDs = append([]string{}, content.AssetIDs...)
	out.ModelAssetIDs = append([]string{}, content.ModelAssetIDs...)
	lookup := func(id string) (string, error) {
		v, ok := mapping[id]
		if !ok || ValidateID(v) != nil {
			return "", teamUnavailable()
		}
		return v, nil
	}
	for i, id := range out.AssetIDs {
		v, e := lookup(id)
		if e != nil {
			return out, e
		}
		out.AssetIDs[i] = v
	}
	for i, id := range out.ModelAssetIDs {
		v, e := lookup(id)
		if e != nil {
			return out, e
		}
		out.ModelAssetIDs[i] = v
	}
	if content.PrimaryAssetID != nil {
		v, e := lookup(*content.PrimaryAssetID)
		if e != nil {
			return out, e
		}
		out.PrimaryAssetID = &v
	}
	var node any
	if decodeTeamStrict(content.NodeContent, &node) != nil {
		return out, teamUnavailable()
	}
	var walk func(any, string, int) (any, error)
	walk = func(value any, key string, depth int) (any, error) {
		if depth > 64 {
			return nil, teamUnavailable()
		}
		switch v := value.(type) {
		case map[string]any:
			for k, x := range v {
				z, e := walk(x, k, depth+1)
				if e != nil {
					return nil, e
				}
				v[k] = z
			}
		case []any:
			for i, x := range v {
				z, e := walk(x, key, depth+1)
				if e != nil {
					return nil, e
				}
				v[i] = z
			}
		case string:
			if strings.HasPrefix(v, "rhtv-asset:") {
				z, e := lookup(strings.TrimPrefix(v, "rhtv-asset:"))
				if e != nil {
					return nil, e
				}
				return "rhtv-asset:" + z, nil
			}
			k := strings.ToLower(key)
			if v != "" && (strings.HasSuffix(k, "assetid") || strings.HasSuffix(k, "assetids")) {
				return lookup(v)
			}
		}
		return value, nil
	}
	node, err := walk(node, "", 0)
	if err != nil {
		return out, err
	}
	out.NodeContent, err = json.Marshal(node)
	if err != nil {
		return out, teamUnavailable()
	}
	return out, nil
}
