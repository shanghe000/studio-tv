package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/httpapi"
	library "studiotv.local/service/api/internal/modules/library/domain"
)

type TeamFolder struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"teamId"`
	ParentID  *string   `json:"parentId"`
	Name      string    `json:"name"`
	Revision  int64     `json:"revision"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type TeamAssetDTO struct {
	ID              string   `json:"id"`
	Kind            string   `json:"kind"`
	MimeType        string   `json:"mimeType"`
	FileName        string   `json:"fileName"`
	ByteSize        int64    `json:"byteSize"`
	ChecksumSHA256  string   `json:"checksumSha256"`
	Width           *int     `json:"width"`
	Height          *int     `json:"height"`
	DurationSeconds *float64 `json:"durationSeconds"`
}
type TeamEntry struct {
	ID               string              `json:"id"`
	TeamID           string              `json:"teamId"`
	FolderID         *string             `json:"folderId"`
	Name             string              `json:"name"`
	Kind             string              `json:"kind"`
	Revision         int64               `json:"revision"`
	Content          library.NodeContent `json:"content"`
	ThumbnailAssetID *string             `json:"thumbnailAssetId"`
	Assets           []TeamAssetDTO      `json:"assets"`
	CreatedAt        time.Time           `json:"createdAt"`
	UpdatedAt        time.Time           `json:"updatedAt"`
}
type TeamPage[T any] struct {
	Records []T   `json:"records"`
	Page    int   `json:"page"`
	Size    int   `json:"size"`
	Total   int64 `json:"total"`
	HasNext bool  `json:"hasNext"`
}
type PublishTeamAsset struct {
	SourceAssetID  string  `json:"sourceAssetId,omitempty"`
	SourceNodeID   string  `json:"sourceNodeId,omitempty"`
	SourceRevision *int64  `json:"sourceRevision,omitempty"`
	FolderID       *string `json:"folderId"`
	Name           string  `json:"name,omitempty"`
}
type TeamAssetPatch struct {
	Name          *string `json:"name"`
	FolderID      *string `json:"folderId"`
	folderPresent bool
}

func (p *TeamAssetPatch) UnmarshalJSON(raw []byte) error {
	type values struct {
		Name     *string `json:"name"`
		FolderID *string `json:"folderId"`
	}
	var v values
	if err := decodeTeamStrict(raw, &v); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return teamInvalid()
	}
	p.Name, p.FolderID, p.folderPresent = v.Name, v.FolderID, fields["folderId"] != nil
	return nil
}

type TeamAssetService struct {
	pool        *pgxpool.Pool
	storageRoot string
}

func NewTeamAssetService(pool *pgxpool.Pool, storageRoot string) (*TeamAssetService, error) {
	if pool == nil || storageRoot == "" {
		return nil, errors.New("team assets require pool and storage")
	}
	return &TeamAssetService{pool: pool, storageRoot: storageRoot}, nil
}
func teamInvalid() error {
	return httpapi.Fail(400, "TEAM_ASSET_INVALID", "团队素材参数无效。")
}
func teamNotFound() error {
	return httpapi.Fail(404, "TEAM_ASSET_NOT_FOUND", "团队素材不存在。")
}
func teamUnavailable() error {
	return httpapi.Retry(503, "TEAM_ASSET_BACKEND_UNAVAILABLE", "团队素材服务暂不可用。")
}
func teamVersion() error {
	return httpapi.Fail(412, "REVISION_MISMATCH", "内容已更新，请刷新后重试。")
}
func validTeamName(value string) bool {
	if !utf8.ValidString(value) || strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > 120 {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func teamID(prefix string) string {
	return prefix + "_" + strings.ReplaceAll(uuid.NewString(), "-", "")
}
func teamTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return teamUnavailable()
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return teamUnavailable()
	}
	return nil
}
func requireTeamFolder(ctx context.Context, db DB, team string, id *string) error {
	if id == nil {
		return nil
	}
	if ValidateID(*id) != nil {
		return teamInvalid()
	}
	var exists bool
	err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.team_folders WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL)`, *id, team).Scan(&exists)
	if err != nil {
		return teamUnavailable()
	}
	if !exists {
		return teamNotFound()
	}
	return nil
}
func scanTeamFolder(row pgx.Row) (TeamFolder, error) {
	var f TeamFolder
	err := row.Scan(&f.ID, &f.TeamID, &f.ParentID, &f.Name, &f.Revision, &f.CreatedAt, &f.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return f, teamNotFound()
	}
	if err != nil {
		return f, teamUnavailable()
	}
	return f, nil
}

const teamFolderColumns = `id,team_id,parent_id,name,revision,created_at,updated_at`

func (s *TeamAssetService) Folders(ctx context.Context, actor, team string, page, size int) (TeamPage[TeamFolder], error) {
	result := TeamPage[TeamFolder]{Records: []TeamFolder{}, Page: page, Size: size}
	if page < 1 || page > 100000 || size < 1 || size > 100 {
		return result, teamInvalid()
	}
	err := teamTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := RequireTeam(ctx, tx, actor, team, "VIEWER", false); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM collaboration.team_folders WHERE team_id=$1 AND deleted_at IS NULL`, team).Scan(&result.Total); err != nil {
			return teamUnavailable()
		}
		rows, err := tx.Query(ctx, `SELECT `+teamFolderColumns+` FROM collaboration.team_folders WHERE team_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3`, team, size, int64(page-1)*int64(size))
		if err != nil {
			return teamUnavailable()
		}
		defer rows.Close()
		for rows.Next() {
			f, err := scanTeamFolder(rows)
			if err != nil {
				return err
			}
			result.Records = append(result.Records, f)
		}
		if rows.Err() != nil {
			return teamUnavailable()
		}
		result.HasNext = int64(page)*int64(size) < result.Total
		return nil
	})
	return result, err
}
func (s *TeamAssetService) CreateFolder(ctx context.Context, actor, team, name string, parent *string, key string) (TeamFolder, error) {
	var result TeamFolder
	if !validTeamName(name) {
		return result, teamInvalid()
	}
	key, e := teamAssetKey(key)
	if e != nil {
		return result, e
	}
	hash, _ := copyHash(map[string]any{"name": name, "parentId": parent})
	err := teamTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := RequireTeam(ctx, tx, actor, team, "EDITOR", true); err != nil {
			return err
		}
		operation := "TEAM_FOLDER_CREATE:" + team
		raw, e := teamWriteReceipt(ctx, tx, actor, operation, key, hash)
		if e != nil {
			return e
		}
		if raw != nil {
			if json.Unmarshal(raw, &result) != nil {
				return teamUnavailable()
			}
			return nil
		}
		if err := requireTeamFolder(ctx, tx, team, parent); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM collaboration.team_folders WHERE team_id=$1 AND deleted_at IS NULL`, team).Scan(&count); err != nil {
			return teamUnavailable()
		}
		if count >= 1000 {
			return httpapi.Fail(409, "TEAM_FOLDER_LIMIT", "团队文件夹数量已达上限。")
		}
		var err error
		result, err = scanTeamFolder(tx.QueryRow(ctx, `INSERT INTO collaboration.team_folders(id,team_id,parent_id,name,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING `+teamFolderColumns, teamID("tfd"), team, parent, strings.TrimSpace(name), actor))
		if err != nil {
			return err
		}
		if err = Audit(ctx, tx, actor, "TEAM_FOLDER_CREATE", "TEAM_FOLDER", result.ID, map[string]any{"teamId": team}); err != nil {
			return err
		}
		return saveTeamWriteReceipt(ctx, tx, actor, operation, key, hash, result)
	})
	return result, err
}
func (s *TeamAssetService) ChangeFolder(ctx context.Context, actor, team, id string, expected int64, name *string, remove bool, key string) (TeamFolder, error) {
	var result TeamFolder
	if ValidateID(id) != nil || expected < 1 || !remove && (name == nil || !validTeamName(*name)) {
		return result, teamInvalid()
	}
	key, e := teamAssetKey(key)
	if e != nil {
		return result, e
	}
	hash, _ := copyHash(map[string]any{"expected": expected, "name": name, "remove": remove})
	operation := fmt.Sprintf("TEAM_FOLDER_MUTATE:%s:%s:%t", team, id, remove)
	err := teamTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := RequireTeam(ctx, tx, actor, team, "EDITOR", true); err != nil {
			return err
		}
		raw, e := teamWriteReceipt(ctx, tx, actor, operation, key, hash)
		if e != nil {
			return e
		}
		if raw != nil {
			if json.Unmarshal(raw, &result) != nil {
				return teamUnavailable()
			}
			return nil
		}
		var err error
		result, err = scanTeamFolder(tx.QueryRow(ctx, `SELECT `+teamFolderColumns+` FROM collaboration.team_folders WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL FOR UPDATE`, id, team))
		if err != nil {
			return err
		}
		if result.Revision != expected {
			return teamVersion()
		}
		if remove {
			var used bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.team_folders WHERE parent_id=$1 AND team_id=$2 AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM collaboration.team_entries WHERE folder_id=$1 AND team_id=$2 AND deleted_at IS NULL)`, id, team).Scan(&used); err != nil {
				return teamUnavailable()
			}
			if used {
				return httpapi.Fail(409, "TEAM_FOLDER_NOT_EMPTY", "文件夹仍含共享内容。")
			}
			_, err = tx.Exec(ctx, `UPDATE collaboration.team_folders SET deleted_at=now(),revision=revision+1,updated_at=now(),updated_by=$2 WHERE id=$1`, id, actor)
		} else {
			result, err = scanTeamFolder(tx.QueryRow(ctx, `UPDATE collaboration.team_folders SET name=$3,revision=revision+1,updated_at=now(),updated_by=$2 WHERE id=$1 RETURNING `+teamFolderColumns, id, actor, strings.TrimSpace(*name)))
		}
		if err != nil {
			return teamUnavailable()
		}
		action := "TEAM_FOLDER_RENAME"
		if remove {
			action = "TEAM_FOLDER_DELETE"
			result.Revision++
		}
		if err = Audit(ctx, tx, actor, action, "TEAM_FOLDER", id, map[string]any{"teamId": team}); err != nil {
			return err
		}
		return saveTeamWriteReceipt(ctx, tx, actor, operation, key, hash, result)
	})
	return result, err
}

const teamEntryColumns = `id,team_id,folder_id,name,kind,revision,content,thumbnail_asset_id,created_at,updated_at`

func teamEntry(ctx context.Context, db DB, team, id string, lock bool) (TeamEntry, error) {
	var e TeamEntry
	var raw []byte
	query := `SELECT ` + teamEntryColumns + ` FROM collaboration.team_entries WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL`
	if lock {
		query += ` FOR UPDATE`
	}
	err := db.QueryRow(ctx, query, id, team).Scan(&e.ID, &e.TeamID, &e.FolderID, &e.Name, &e.Kind, &e.Revision, &raw, &e.ThumbnailAssetID, &e.CreatedAt, &e.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return e, teamNotFound()
	}
	if err != nil || json.Unmarshal(raw, &e.Content) != nil {
		return e, teamUnavailable()
	}
	e.Content.NodeContent, err = canonicalTeamJSON(e.Content.NodeContent)
	if err != nil {
		return e, teamUnavailable()
	}
	e.Assets = []TeamAssetDTO{}
	rows, err := db.Query(ctx, `SELECT a.id,a.kind,a.mime_type,a.file_name,a.byte_size,a.checksum_sha256,a.width,a.height,a.duration_seconds FROM collaboration.team_asset_refs r JOIN public.assets a ON a.id=r.asset_id AND a.owner_id=r.asset_owner_id WHERE r.entry_id=$1 AND r.team_id=$2 AND a.state='READY' AND a.deleted_at IS NULL ORDER BY r.sort_order`, id, team)
	if err != nil {
		return e, teamUnavailable()
	}
	defer rows.Close()
	for rows.Next() {
		var a TeamAssetDTO
		if err := rows.Scan(&a.ID, &a.Kind, &a.MimeType, &a.FileName, &a.ByteSize, &a.ChecksumSHA256, &a.Width, &a.Height, &a.DurationSeconds); err != nil {
			return e, teamUnavailable()
		}
		e.Assets = append(e.Assets, a)
	}
	if rows.Err() != nil {
		return e, teamUnavailable()
	}
	rows.Close()
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM collaboration.team_asset_refs WHERE entry_id=$1 AND team_id=$2`, id, team).Scan(&count); err != nil || count != len(e.Assets) {
		return e, teamUnavailable()
	}
	return e, nil
}
func (s *TeamAssetService) Entry(ctx context.Context, actor, team, id string) (TeamEntry, error) {
	var result TeamEntry
	err := teamTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := RequireTeam(ctx, tx, actor, team, "VIEWER", false); err != nil {
			return err
		}
		var err error
		result, err = teamEntry(ctx, tx, team, id, false)
		return err
	})
	return result, err
}
func (s *TeamAssetService) Entries(ctx context.Context, actor, team string, folder *string, keyword string, page, size int) (TeamPage[TeamEntry], error) {
	result := TeamPage[TeamEntry]{Records: []TeamEntry{}, Page: page, Size: size}
	if page < 1 || page > 100000 || size < 1 || size > 100 || len(keyword) > 300 {
		return result, teamInvalid()
	}
	err := teamTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := RequireTeam(ctx, tx, actor, team, "VIEWER", false); err != nil {
			return err
		}
		if err := requireTeamFolder(ctx, tx, team, folder); err != nil {
			return err
		}
		pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(keyword) + "%"
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM collaboration.team_entries WHERE team_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR folder_id=$2) AND name ILIKE $3`, team, folder, pattern).Scan(&result.Total); err != nil {
			return teamUnavailable()
		}
		rows, err := tx.Query(ctx, `SELECT id FROM collaboration.team_entries WHERE team_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR folder_id=$2) AND name ILIKE $3 ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5`, team, folder, pattern, size, int64(page-1)*int64(size))
		if err != nil {
			return teamUnavailable()
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if rows.Scan(&id) != nil {
				rows.Close()
				return teamUnavailable()
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return teamUnavailable()
		}
		for _, id := range ids {
			entry, err := teamEntry(ctx, tx, team, id, false)
			if err != nil {
				return err
			}
			result.Records = append(result.Records, entry)
		}
		result.HasNext = int64(page)*int64(size) < result.Total
		return nil
	})
	return result, err
}
func (s *TeamAssetService) ChangeEntry(ctx context.Context, actor, team, id string, expected int64, patch TeamAssetPatch, remove bool, key string) (TeamEntry, error) {
	var result TeamEntry
	if ValidateID(id) != nil || expected < 1 || !remove && (patch.Name == nil && !patch.folderPresent || patch.Name != nil && !validTeamName(*patch.Name)) {
		return result, teamInvalid()
	}
	key, e := teamAssetKey(key)
	if e != nil {
		return result, e
	}
	hash, _ := copyHash(map[string]any{"expected": expected, "name": patch.Name, "folderId": patch.FolderID, "folderPresent": patch.folderPresent, "remove": remove})
	operation := fmt.Sprintf("TEAM_ENTRY_MUTATE:%s:%s:%t", team, id, remove)
	err := teamTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := RequireTeam(ctx, tx, actor, team, "EDITOR", true); err != nil {
			return err
		}
		raw, e := teamWriteReceipt(ctx, tx, actor, operation, key, hash)
		if e != nil {
			return e
		}
		if raw != nil {
			if json.Unmarshal(raw, &result) != nil {
				return teamUnavailable()
			}
			return nil
		}
		var err error
		result, err = teamEntry(ctx, tx, team, id, true)
		if err != nil {
			return err
		}
		if result.Revision != expected {
			return teamVersion()
		}
		if remove {
			_, err = tx.Exec(ctx, `UPDATE collaboration.team_entries SET deleted_at=now(),revision=revision+1,updated_at=now(),updated_by=$2 WHERE id=$1`, id, actor)
			result.Revision++
		} else {
			if patch.folderPresent {
				if err := requireTeamFolder(ctx, tx, team, patch.FolderID); err != nil {
					return err
				}
				result.FolderID = patch.FolderID
			}
			if patch.Name != nil {
				result.Name = strings.TrimSpace(*patch.Name)
			}
			_, err = tx.Exec(ctx, `UPDATE collaboration.team_entries SET name=$3,folder_id=$4,revision=revision+1,updated_at=now(),updated_by=$2 WHERE id=$1`, id, actor, result.Name, result.FolderID)
			if err == nil {
				result, err = teamEntry(ctx, tx, team, id, false)
			}
		}
		if err != nil {
			return teamUnavailable()
		}
		action := "TEAM_ASSET_UPDATE"
		if remove {
			action = "TEAM_ASSET_UNPUBLISH"
		}
		if err = Audit(ctx, tx, actor, action, "TEAM_ASSET", id, map[string]any{"teamId": team}); err != nil {
			return err
		}
		return saveTeamWriteReceipt(ctx, tx, actor, operation, key, hash, result)
	})
	return result, err
}

// TeamAssetPinned ignores the source project's soft deletion. Publication pins
// its real immutable asset until every active team entry has been unpublished.
func TeamAssetPinned(ctx context.Context, db DB, assetID string) (bool, error) {
	var pinned bool
	err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration.team_asset_refs r JOIN collaboration.team_entries e ON e.id=r.entry_id AND e.team_id=r.team_id JOIN collaboration.teams t ON t.id=e.team_id WHERE r.asset_id=$1 AND e.deleted_at IS NULL AND t.deleted_at IS NULL)`, assetID).Scan(&pinned)
	if err != nil {
		return false, teamUnavailable()
	}
	return pinned, nil
}

func teamAssetKey(key string) (string, error) {
	parsed, err := uuid.Parse(key)
	if err != nil || parsed == uuid.Nil {
		return "", httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式Idempotency-Key。")
	}
	return parsed.String(), nil
}
func teamETag(revision int64) string { return fmt.Sprintf(`"%d"`, revision) }
