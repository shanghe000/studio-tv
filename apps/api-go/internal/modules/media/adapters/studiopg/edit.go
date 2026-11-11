package studiopg

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/httpapi"
	execdomain "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/media/application"
	"studiotv.local/service/api/internal/modules/media/domain"
)

func (r *Repository) EditFile(ctx context.Context, owner, id, name, key string, expected int64, cmd domain.EditCommand) (domain.EditResult, error) {
	var result domain.EditResult
	parsed, err := uuid.Parse(key)
	if err != nil || parsed.String() != key || expected < 1 || !domain.ValidPath(name) || cmd.Validate() != nil {
		return result, domain.ErrInvalid
	}
	raw, err := json.Marshal(struct {
		Project, Path string
		Revision      int64
		Command       domain.EditCommand
	}{id, name, expected, cmd})
	if err != nil {
		return result, err
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	operation := "studioBridgeEdit:" + id + ":" + name
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	// Match the resource writer's owner lock so all file edits share one
	// project revision, receipt and file-change event transaction.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner+":studio"); err != nil {
		return result, err
	}
	var project *string
	var current int64
	err = tx.QueryRow(ctx, rootSQL+" FOR UPDATE OF s", id, owner).Scan(&project, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, execdomain.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	var previousHash string
	var previous []byte
	err = tx.QueryRow(ctx, "SELECT request_hash,response_body FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3", owner, operation, key).Scan(&previousHash, &previous)
	if err == nil {
		if previousHash != hash {
			return result, httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "相同幂等键对应了不同文件修改。")
		}
		if json.Unmarshal(previous, &result) != nil {
			return result, errors.New("studio edit receipt invalid")
		}
		return result, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if current != expected {
		return result, httpapi.Fail(412, "REVISION_CONFLICT", "项目文件已改变，请刷新后重试。")
	}
	var content []byte
	var typ string
	err = tx.QueryRow(ctx, "SELECT content,mime_type FROM resources.studio_files WHERE project_id=$1 AND owner_id=$2 AND path=$3 FOR UPDATE", id, owner, name).Scan(&content, &typ)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, execdomain.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if !strings.HasPrefix(typ, "text/html") {
		return result, domain.ErrInvalid
	}
	edited, err := domain.EditHTML(string(content), cmd)
	if errors.Is(err, domain.ErrElementNotFound) {
		return result, httpapi.Fail(404, "STUDIO_ELEMENT_NOT_FOUND", "指定元素不存在。")
	}
	if err != nil {
		return result, err
	}
	result = domain.EditResult{Path: name, Content: edited, MimeType: typ, Revision: current + 1}
	if _, err = tx.Exec(ctx, "UPDATE resources.studio_files SET content=$4,revision=$5,updated_at=now() WHERE project_id=$1 AND owner_id=$2 AND path=$3", id, owner, name, []byte(edited), result.Revision); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, "UPDATE resources.studio_projects SET revision=$3,updated_at=now() WHERE id=$1 AND owner_id=$2", id, owner, result.Revision); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO resources.studio_events(owner_id,project_id,path,event,revision) VALUES($1,$2,$3,'file-change',$4)", owner, id, name, result.Revision); err != nil {
		return result, err
	}
	response, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,200,$5)", owner, operation, key, hash, response); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

var _ application.StudioEditPort = (*Repository)(nil)
