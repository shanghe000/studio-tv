package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gabriel-vasile/mimetype"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"strconv"
	"strings"
	"time"
)

type Asset struct {
	ID, OwnerID, ProjectID, FileName, Kind, MimeType, Checksum, State string
	ByteSize                                                          int64
	Width, Height                                                     *int
	Duration                                                          *float64
	RejectionCode, StorageKey                                         *string
	CreatedAt                                                         time.Time
}

const assetColumns = "id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,duration_seconds,rejection_code,storage_key,created_at"

func scanAsset(row pgx.Row) (Asset, error) {
	var a Asset
	e := row.Scan(&a.ID, &a.OwnerID, &a.ProjectID, &a.FileName, &a.Kind, &a.MimeType, &a.ByteSize, &a.Checksum, &a.State, &a.Width, &a.Height, &a.Duration, &a.RejectionCode, &a.StorageKey, &a.CreatedAt)
	return a, e
}
func ownAsset(ctx context.Context, db DB, uid, aid string, lock bool) (Asset, error) {
	if e := requireID(aid); e != nil {
		return Asset{}, e
	}
	query := "SELECT " + assetColumns + " FROM assets WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL"
	if lock {
		query += " FOR UPDATE"
	}
	a, e := scanAsset(db.QueryRow(ctx, query, aid, uid))
	if errors.Is(e, pgx.ErrNoRows) {
		return a, httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	return a, e
}

// accessibleAsset leaves private importers' ownAsset semantics intact. Only
// explicitly authorized resource routes use project/team sharing.
func accessibleAsset(ctx context.Context, db DB, actorID, aid string, write bool) (Asset, error) {
	if e := requireID(aid); e != nil {
		return Asset{}, e
	}
	a, e := scanAsset(db.QueryRow(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1 AND deleted_at IS NULL", aid))
	if errors.Is(e, pgx.ErrNoRows) {
		return a, httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
	}
	if e != nil {
		return a, e
	}
	if write {
		if actorID == a.OwnerID {
			var internalID string
			err := db.QueryRow(ctx, `SELECT p.id FROM public.projects p JOIN public.users u ON u.id=$2 AND NOT u.disabled WHERE p.id=$1 AND p.owner_id=$2 AND p.internal_kind IS NOT NULL AND p.deleted_at IS NULL FOR UPDATE OF p`, a.ProjectID, actorID).Scan(&internalID)
			if err == nil {
				return scanAsset(db.QueryRow(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", aid))
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return a, err
			}
		}
		access, e := collaboration.RequireProject(ctx, db, actorID, a.ProjectID, collaboration.EDITOR, true)
		if e != nil {
			return a, e
		}
		if a.OwnerID != access.StorageOwnerID {
			return a, httpapi.Fail(404, "ASSET_NOT_FOUND", "素材不存在。")
		}
		return scanAsset(db.QueryRow(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", aid))
	}
	e = collaboration.RequireAssetProjectRead(ctx, db, actorID, aid)
	if e != nil {
		var api *httpapi.Error
		if !errors.As(e, &api) || api.Status != 404 {
			return a, e
		}
		if e = collaboration.RequireAssetGrant(ctx, db, actorID, aid); e != nil {
			return a, e
		}
	}
	return a, nil
}
func (s *Server) publicAsset(r *http.Request, a Asset) (map[string]any, error) {
	var media, expiry any
	if a.State == "READY" {
		token, e := s.tokens.Sign(map[string]any{"sub": owner(r), "aid": a.ID, "sid": httpapi.IdentityFrom(r).SessionID}, "asset-read", 15*time.Minute)
		if e != nil {
			return nil, e
		}
		media = s.cfg.PublicBaseURL + "/storage/assets/" + a.ID + "?token=" + url.QueryEscape(token)
		expiry = iso(time.Now().Add(15 * time.Minute))
	}
	return map[string]any{"id": a.ID, "projectId": a.ProjectID, "fileName": a.FileName, "kind": a.Kind, "mimeType": a.MimeType, "byteSize": a.ByteSize, "checksumSha256": a.Checksum, "state": a.State, "width": nullableInt(a.Width), "height": nullableInt(a.Height), "durationSeconds": nullableFloat(a.Duration), "previewUrl": media, "downloadUrl": media, "urlsExpireAt": expiry, "rejectionCode": nullableString(a.RejectionCode), "createdAt": iso(a.CreatedAt)}, nil
}

type Upload struct {
	ID, AssetID, OwnerID, GrantID string
	ExpiresAt, Deadline           time.Time
	UploadedAt, CompletedAt       *time.Time
	ETag                          *string
}

const uploadColumns = "id,asset_id,owner_id,grant_id,expires_at,complete_deadline_at,uploaded_at,completed_at,object_etag"

func scanUpload(row pgx.Row) (Upload, error) {
	var u Upload
	e := row.Scan(&u.ID, &u.AssetID, &u.OwnerID, &u.GrantID, &u.ExpiresAt, &u.Deadline, &u.UploadedAt, &u.CompletedAt, &u.ETag)
	return u, e
}
func ownUpload(ctx context.Context, db DB, uid, id string) (Upload, error) {
	if e := requireID(id); e != nil {
		return Upload{}, e
	}
	// Resolve the upload's actual project before locking upload/asset rows; all
	// writers use project -> upload -> asset ordering, including revocation.
	var pid string
	e := db.QueryRow(ctx, `SELECT a.project_id FROM asset_uploads u JOIN assets a ON a.id=u.asset_id AND a.deleted_at IS NULL WHERE u.id=$1 AND u.owner_id=$2`, id, uid).Scan(&pid)
	if errors.Is(e, pgx.ErrNoRows) {
		return Upload{}, httpapi.Fail(404, "UPLOAD_NOT_FOUND", "上传会话不存在。")
	}
	if e != nil {
		return Upload{}, e
	}
	if _, e = collaboration.RequireProject(ctx, db, uid, pid, collaboration.EDITOR, true); e != nil {
		return Upload{}, e
	}
	u, e := scanUpload(db.QueryRow(ctx, "SELECT "+uploadColumns+" FROM asset_uploads WHERE id=$1 AND owner_id=$2 FOR UPDATE", id, uid))
	if errors.Is(e, pgx.ErrNoRows) {
		return u, httpapi.Fail(404, "UPLOAD_NOT_FOUND", "上传会话不存在。")
	}
	return u, e
}
func (s *Server) uploadResponse(r *http.Request, u Upload, a Asset) (map[string]any, error) {
	ttl := time.Until(u.ExpiresAt)
	if ttl < time.Second {
		ttl = time.Second
	}
	token, e := s.tokens.Sign(map[string]any{"sub": u.OwnerID, "uid": u.ID, "gid": u.GrantID, "sid": httpapi.IdentityFrom(r).SessionID}, "asset-upload", ttl)
	if e != nil {
		return nil, e
	}
	return map[string]any{"id": u.ID, "assetId": a.ID, "method": "PUT", "url": s.cfg.PublicBaseURL + "/storage/uploads/" + u.ID + "?token=" + url.QueryEscape(token), "headers": map[string]string{"Content-Type": a.MimeType, "x-checksum-sha256": a.Checksum}, "expiresAt": iso(u.ExpiresAt), "completeDeadlineAt": iso(u.Deadline), "expectedByteSize": a.ByteSize, "checksumSha256": a.Checksum}, nil
}

var mimeKinds = map[string]string{"image/png": "IMAGE", "image/jpeg": "IMAGE", "image/webp": "IMAGE", "image/gif": "IMAGE", "image/avif": "IMAGE", "video/mp4": "VIDEO", "video/webm": "VIDEO", "video/quicktime": "VIDEO", "audio/mpeg": "AUDIO", "audio/wav": "AUDIO", "audio/ogg": "AUDIO", "audio/flac": "AUDIO", "audio/mp4": "AUDIO", "audio/webm": "AUDIO"}

func (s *Server) assets(r chi.Router) {
	s.assetBatch(r)
	for _, method := range []string{"GET", "HEAD"} {
		s.route(r, method, canvasMediaRoot+"{scope}/{assetId}", false, s.readCanvasMedia)
	}
	s.route(r, "POST", "/api/v1/asset-uploads", true, s.createUpload)
	s.route(r, "POST", "/api/v1/asset-uploads/{uploadId}/renew", true, s.renewUpload)
	s.route(r, "POST", "/api/v1/asset-uploads/{uploadId}/complete", true, s.completeUpload)
	s.route(r, "PUT", "/storage/uploads/{uploadId}", false, s.putUpload)
	s.route(r, "GET", "/api/v1/assets", true, s.listAssets)
	s.route(r, "GET", "/api/v1/assets/{assetId}", true, func(w http.ResponseWriter, r *http.Request) error {
		a, e := accessibleAsset(r.Context(), s.db, owner(r), chi.URLParam(r, "assetId"), false)
		if e != nil {
			return e
		}
		data, e := s.publicAsset(r, a)
		if e != nil {
			return e
		}
		return httpapi.OK(w, r, 200, data)
	})
	s.route(r, "DELETE", "/api/v1/assets/{assetId}", true, s.deleteAsset)
	s.route(r, "GET", "/storage/assets/{assetId}", false, s.readAsset)
	s.route(r, "HEAD", "/storage/assets/{assetId}", false, s.readAsset)
}
func (s *Server) createUpload(w http.ResponseWriter, r *http.Request) error {
	body, e := s.body(w, r, "AssetUploadRequest")
	if e != nil {
		return e
	}
	kind := mimeKinds[body["mimeType"].(string)]
	if kind == "" {
		return httpapi.Fail(422, "MIME_UNSUPPORTED", "仅允许登记的图片、视频、音频格式。")
	}
	number, e := body["byteSize"].(json.Number).Float64()
	size := int64(number)
	if e != nil || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < 1 || number > float64(s.cfg.MaxUploadBytes) {
		return httpapi.Fail(413, "PAYLOAD_TOO_LARGE", "文件超过服务器上传限制。")
	}
	// JavaScript parsed integer-equivalent forms into one Number before hashing.
	// Preserve that canonical request identity across the Node-to-Go migration.
	body["byteSize"] = size
	result, e := s.idempotent(r, "createAssetUpload", body, func(tx pgx.Tx) (Result, error) {
		access, e := collaboration.RequireProject(r.Context(), tx, owner(r), body["projectId"].(string), collaboration.EDITOR, true)
		if e != nil {
			return Result{}, e
		}
		a, e := scanAsset(tx.QueryRow(r.Context(), "INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING "+assetColumns, newID("ast"), access.StorageOwnerID, body["projectId"], body["fileName"], kind, body["mimeType"], size, body["checksumSha256"], owner(r)))
		if e != nil {
			return Result{}, e
		}
		u, e := scanUpload(tx.QueryRow(r.Context(), "INSERT INTO asset_uploads(id,asset_id,owner_id,grant_id,expires_at,complete_deadline_at)VALUES($1,$2,$3,$4,now()+interval '15 minutes',now()+interval '24 hours')RETURNING "+uploadColumns, newID("upl"), a.ID, owner(r), uuid.NewString()))
		if e != nil {
			return Result{}, e
		}
		data, e := s.uploadResponse(r, u, a)
		return Result{201, data}, e
	})
	if e != nil {
		return e
	}
	return httpapi.OK(w, r, result.Status, result.Data)
}
func (s *Server) renewUpload(w http.ResponseWriter, r *http.Request) error {
	result, e := s.idempotent(r, "renewAssetUpload", nil, func(tx pgx.Tx) (Result, error) {
		u, e := ownUpload(r.Context(), tx, owner(r), chi.URLParam(r, "uploadId"))
		if e != nil {
			return Result{}, e
		}
		if u.CompletedAt != nil || !u.Deadline.After(time.Now()) {
			return Result{}, httpapi.Fail(409, "UPLOAD_CLOSED", "上传会话已完成或超时。")
		}
		a, e := accessibleAsset(r.Context(), tx, owner(r), u.AssetID, true)
		if e != nil {
			return Result{}, e
		}
		if a.State == "REJECTED" {
			return Result{}, httpapi.Fail(409, "UPLOAD_REJECTED", "上传已被拒绝。")
		}
		u, e = scanUpload(tx.QueryRow(r.Context(), "UPDATE asset_uploads SET grant_id=$2,expires_at=LEAST(now()+interval '15 minutes',complete_deadline_at)WHERE id=$1 RETURNING "+uploadColumns, u.ID, uuid.NewString()))
		if e != nil {
			return Result{}, e
		}
		data, e := s.uploadResponse(r, u, a)
		return Result{200, data}, e
	})
	if e != nil {
		return e
	}
	return httpapi.OK(w, r, result.Status, result.Data)
}
func (s *Server) putUpload(w http.ResponseWriter, r *http.Request) error {
	if r.Header.Get("Authorization") != "" {
		return httpapi.Fail(400, "STORAGE_AUTH_FORBIDDEN", "存储PUT不应携带业务Bearer。")
	}
	claims, e := s.tokens.Verify(r.URL.Query().Get("token"), "asset-upload")
	if e != nil {
		return e
	}
	uid, ok := claims["sub"].(string)
	if !ok || claims["uid"] != chi.URLParam(r, "uploadId") {
		return httpapi.Fail(401, "UNAUTHENTICATED", "上传签名不匹配。")
	}
	sessionID, _ := claims["sid"].(string)
	r, e = s.signedRequest(r, uid, sessionID, authorization.TVAccess)
	if e != nil {
		return e
	}
	w.Header().Set("Cache-Control", "no-store")
	temp, e := os.CreateTemp(s.cfg.StorageRoot, ".upload-")
	if e != nil {
		return e
	}
	name := temp.Name()
	defer os.Remove(name)
	defer temp.Close()
	etagValue, e := database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (string, error) {
		u, e := ownUpload(r.Context(), tx, uid, chi.URLParam(r, "uploadId"))
		if e != nil {
			return "", e
		}
		if u.GrantID != claims["gid"] || !u.ExpiresAt.After(time.Now()) {
			return "", httpapi.Fail(401, "UPLOAD_EXPIRED", "上传签名已过期或已更新。")
		}
		if u.CompletedAt != nil {
			return "", httpapi.Fail(409, "UPLOAD_CLOSED", "上传已经完成。")
		}
		a, e := accessibleAsset(r.Context(), tx, uid, u.AssetID, true)
		if e != nil {
			return "", e
		}
		if a.State == "REJECTED" {
			return "", httpapi.Fail(409, "UPLOAD_REJECTED", "上传已拒绝。")
		}
		media, params, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if e != nil || media != a.MimeType || len(params) > 0 || r.Header.Get("X-Checksum-Sha256") != a.Checksum {
			return "", httpapi.Fail(422, "UPLOAD_HEADERS_MISMATCH", "上传MIME或校验值与申请不一致。")
		}
		if r.ContentLength >= 0 && r.ContentLength != a.ByteSize {
			return "", httpapi.Fail(422, "UPLOAD_SIZE_MISMATCH", "真实上传大小与申请不一致。")
		}
		hash := sha256.New()
		n, e := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(r.Body, a.ByteSize+1))
		if e != nil {
			return "", e
		}
		if n > a.ByteSize {
			return "", httpapi.Fail(413, "PAYLOAD_TOO_LARGE", "上传超出申请大小。")
		}
		if n != a.ByteSize {
			return "", httpapi.Fail(422, "UPLOAD_SIZE_MISMATCH", "真实上传大小与申请不一致。")
		}
		sum := hex.EncodeToString(hash.Sum(nil))
		if sum != a.Checksum {
			return "", httpapi.Fail(422, "UPLOAD_CHECKSUM_MISMATCH", "真实SHA256与申请不一致。")
		}
		if e = temp.Sync(); e != nil {
			return "", e
		}
		if e = temp.Close(); e != nil {
			return "", e
		}
		if e = os.Chmod(name, 0640); e != nil {
			return "", e
		}
		if e = os.Rename(name, filepath.Join(s.cfg.StorageRoot, a.ID)); e != nil {
			return "", e
		}
		etagValue := "\"" + sum + "\""
		if _, e = tx.Exec(r.Context(), "UPDATE asset_uploads SET uploaded_at=now(),object_etag=$2 WHERE id=$1", u.ID, etagValue); e != nil {
			return "", e
		}
		_, e = tx.Exec(r.Context(), "UPDATE assets SET storage_key=$2 WHERE id=$1", a.ID, a.ID)
		return etagValue, e
	})
	if e != nil {
		return e
	}
	w.Header().Set("ETag", etagValue)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	return nil
}
func (s *Server) completeUpload(w http.ResponseWriter, r *http.Request) error {
	body, e := s.body(w, r, "UploadCompleteRequest")
	if e != nil {
		return e
	}
	result, e := s.idempotent(r, "completeAssetUpload", body, func(tx pgx.Tx) (Result, error) {
		u, e := ownUpload(r.Context(), tx, owner(r), chi.URLParam(r, "uploadId"))
		if e != nil {
			return Result{}, e
		}
		a, e := accessibleAsset(r.Context(), tx, owner(r), u.AssetID, true)
		if e != nil {
			return Result{}, e
		}
		if a.State == "REJECTED" {
			return Result{}, httpapi.Fail(409, "UPLOAD_REJECTED", "真实媒体校验已拒绝此素材。")
		}
		if u.CompletedAt != nil {
			data, e := s.publicAsset(r, a)
			return Result{202, data}, e
		}
		if !u.Deadline.After(time.Now()) {
			return Result{}, httpapi.Fail(409, "UPLOAD_EXPIRED", "上传完成窗口已过期。")
		}
		if u.UploadedAt == nil || u.ETag == nil || *u.ETag != body["etag"] {
			return Result{}, httpapi.Fail(422, "UPLOAD_NOT_VERIFIED", "真实上传对象不存在或ETag不匹配。")
		}
		file := filepath.Join(s.cfg.StorageRoot, a.ID)
		f, e := os.Open(file)
		if e != nil {
			return Result{}, httpapi.Fail(422, "UPLOAD_NOT_VERIFIED", "上传文件不存在。")
		}
		info, e := f.Stat()
		if e != nil {
			f.Close()
			return Result{}, e
		}
		if info.Size() != a.ByteSize {
			f.Close()
			return Result{}, httpapi.Fail(422, "UPLOAD_SIZE_MISMATCH", "真实文件大小不符。")
		}
		hash := sha256.New()
		_, e = io.Copy(hash, f)
		f.Close()
		if e != nil {
			return Result{}, e
		}
		if hex.EncodeToString(hash.Sum(nil)) != a.Checksum {
			return Result{}, httpapi.Fail(422, "UPLOAD_CHECKSUM_MISMATCH", "真实文件SHA256不符。")
		}
		width, height, duration, e := s.inspectMedia(r.Context(), file, a.MimeType, a.Kind)
		if e != nil {
			return Result{}, e
		}
		if e = os.Chmod(file, 0440); e != nil {
			return Result{}, e
		}
		a, e = scanAsset(tx.QueryRow(r.Context(), "UPDATE assets SET state='READY',width=$2,height=$3,duration_seconds=$4 WHERE id=$1 RETURNING "+assetColumns, a.ID, width, height, duration))
		if e != nil {
			return Result{}, e
		}
		if _, e = tx.Exec(r.Context(), "UPDATE asset_uploads SET completed_at=now() WHERE id=$1", u.ID); e != nil {
			return Result{}, e
		}
		data, e := s.publicAsset(r, a)
		return Result{202, data}, e
	})
	if e != nil {
		var api *httpapi.Error
		if errors.As(e, &api) && strings.Contains(" MIME_MISMATCH MEDIA_KIND_MISMATCH MEDIA_INVALID UPLOAD_SIZE_MISMATCH UPLOAD_CHECKSUM_MISMATCH ", " "+api.Code+" ") {
			_, _ = s.db.Exec(r.Context(), "UPDATE assets a SET state='REJECTED',rejection_code=$3 FROM asset_uploads u WHERE u.asset_id=a.id AND u.id=$1 AND u.owner_id=$2 AND a.state='UPLOADING'", chi.URLParam(r, "uploadId"), owner(r), api.Code)
		}
		return e
	}
	data := result.Data.(map[string]any)
	w.Header().Set("Location", "/api/v1/assets/"+data["id"].(string))
	return httpapi.OK(w, r, result.Status, result.Data)
}
func (s *Server) listAssets(w http.ResponseWriter, r *http.Request) error {
	if e := queryKeys(r, "page", "pageSize", "q", "projectId", "kind", "state"); e != nil {
		return e
	}
	page, e := integerQuery(r, "page", 1, 2147483647)
	if e != nil {
		return e
	}
	size, e := integerQuery(r, "pageSize", 20, 100)
	if e != nil {
		return e
	}
	q := r.URL.Query()
	if len([]rune(q.Get("q"))) > 200 {
		return httpapi.Fail(400, "VALIDATION_FAILED", "搜索长度超限。")
	}
	var pid, kind, state, search any
	storageOwner := owner(r)
	if v := q.Get("projectId"); v != "" {
		var access collaboration.ProjectAccess
		if access, e = collaboration.RequireProject(r.Context(), s.db, owner(r), v, collaboration.VIEWER, false); e != nil {
			return e
		}
		pid = v
		storageOwner = access.StorageOwnerID
	}
	if v := q.Get("kind"); v != "" {
		if v != "IMAGE" && v != "VIDEO" && v != "AUDIO" {
			return httpapi.Fail(400, "VALIDATION_FAILED", "素材类型无效。")
		}
		kind = v
	}
	if v := q.Get("state"); v != "" {
		if !strings.Contains(" UPLOADING PROCESSING READY REJECTED ", " "+v+" ") {
			return httpapi.Fail(400, "VALIDATION_FAILED", "素材状态无效。")
		}
		state = v
	}
	if v := q.Get("q"); v != "" {
		search = "%" + escapeLike(v) + "%"
	}
	filter := "owner_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR project_id=$2)AND ($3::text IS NULL OR kind=$3)AND ($4::text IS NULL OR state=$4)AND ($5::text IS NULL OR file_name ILIKE $5) AND project_id IN (SELECT id FROM projects WHERE owner_id=$1 AND deleted_at IS NULL)"
	var total int
	if e = s.db.QueryRow(r.Context(), "SELECT count(*)::int FROM assets WHERE "+filter, storageOwner, pid, kind, state, search).Scan(&total); e != nil {
		return e
	}
	rows, e := s.db.Query(r.Context(), "SELECT "+assetColumns+" FROM assets WHERE "+filter+" ORDER BY created_at DESC,id LIMIT $6 OFFSET $7", storageOwner, pid, kind, state, search, size, (int64(page)-1)*int64(size))
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		a, e := scanAsset(rows)
		if e != nil {
			return e
		}
		data, e := s.publicAsset(r, a)
		if e != nil {
			return e
		}
		items = append(items, data)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return httpapi.OK(w, r, 200, map[string]any{"items": items, "page": page, "pageSize": size, "total": total, "hasMore": int64(page)*int64(size) < int64(total)})
}
func (s *Server) deleteAsset(w http.ResponseWriter, r *http.Request) error {
	aid := chi.URLParam(r, "assetId")
	at, e := database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (time.Time, error) {
		if _, e := accessibleAsset(r.Context(), tx, owner(r), aid, true); e != nil {
			return time.Time{}, e
		}
		var used bool
		e := tx.QueryRow(r.Context(), `SELECT
		 EXISTS(SELECT 1 FROM projects WHERE deleted_at IS NULL AND (cover_asset_id=$1 OR graph::text LIKE $2))
		 OR EXISTS(SELECT 1 FROM library.item_media_refs refs
		 JOIN library.items item ON item.id=refs.item_id AND item.owner_id=refs.owner_id
			 WHERE refs.asset_id=$1 AND item.deleted_at IS NULL)
			 OR EXISTS(SELECT 1 FROM assistant.message_assets refs JOIN assistant.conversations c ON c.id=refs.conversation_id AND c.owner_id=refs.owner_id JOIN assistant.messages m ON m.id=refs.message_id AND m.conversation_id=refs.conversation_id AND m.owner_id=refs.owner_id WHERE refs.asset_id=$1 AND c.deleted_at IS NULL AND m.deleted_at IS NULL AND (c.business='GLOBAL' OR (c.business='HF' AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL AND (h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=h.project_id AND hp.owner_id=h.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL))))) OR (c.business='CANVAS' AND EXISTS(SELECT 1 FROM public.projects cp WHERE cp.id=c.canvas_project_id AND cp.deleted_at IS NULL AND cp.internal_kind IS NULL))))
 OR EXISTS(SELECT 1 FROM resources.active_asset_references refs WHERE refs.asset_id=$1)
			 OR EXISTS(SELECT 1 FROM execution.task_assets refs JOIN execution.tasks t ON t.id=refs.task_id AND t.owner_id=refs.owner_id
			 WHERE refs.asset_id=$1 AND (
			 (refs.direction='INPUT' AND t.state IN ('QUEUED','RUNNING')) OR
			 (refs.direction='OUTPUT' AND t.history_deleted_at IS NULL AND EXISTS(
			 SELECT 1 FROM jsonb_array_elements(t.payload->'task'->'plans') p CROSS JOIN LATERAL jsonb_array_elements(p->'outputs') o
			 WHERE p->>'historyDeletedAt' IS NULL AND o->>'deletedAt' IS NULL AND o->>'assetId'=$1))))`, aid, "%"+escapeLike(aid)+"%").Scan(&used)
		if e != nil {
			return time.Time{}, e
		}
		pinned, e := collaboration.TeamAssetPinned(r.Context(), tx, aid)
		if e != nil {
			return time.Time{}, e
		}
		used = used || pinned
		if used {
			return time.Time{}, httpapi.Fail(409, "ASSET_IN_USE", "素材仍被项目或图库引用，不能删除。")
		}
		var at time.Time
		e = tx.QueryRow(r.Context(), "UPDATE assets SET state='DELETED',deleted_at=now()WHERE id=$1 RETURNING deleted_at", aid).Scan(&at)
		return at, e
	})
	if e != nil {
		return e
	}
	return httpapi.OK(w, r, 200, map[string]any{"id": aid, "deletedAt": iso(at)})
}

type ByteRange struct{ Start, End int64 }

func ParseRange(header string, size int64) (*ByteRange, error) {
	if header == "" {
		return nil, nil
	}
	bad := func() (*ByteRange, error) {
		return nil, httpapi.Fail(416, "RANGE_NOT_SATISFIABLE", "仅支持有效的单段bytes Range。")
	}
	if !strings.HasPrefix(header, "bytes=") {
		return bad()
	}
	parts := strings.Split(strings.TrimPrefix(header, "bytes="), "-")
	if len(parts) != 2 || parts[0] == "" && parts[1] == "" {
		return bad()
	}
	var start, end int64
	end = size - 1
	if parts[0] == "" {
		n, e := strconv.ParseInt(parts[1], 10, 64)
		if e != nil || n <= 0 {
			return bad()
		}
		start = max(int64(0), size-n)
	} else {
		n, e := strconv.ParseInt(parts[0], 10, 64)
		if e != nil {
			return bad()
		}
		start = n
		if parts[1] != "" {
			n, e = strconv.ParseInt(parts[1], 10, 64)
			if e != nil {
				return bad()
			}
			end = min(n, size-1)
		}
	}
	if start < 0 || start >= size || end < start {
		return bad()
	}
	return &ByteRange{start, end}, nil
}

// If-None-Match uses weak comparison, including a list of quoted entity tags.
// Splitting on commas would incorrectly split commas inside an opaque tag.
func assetETagMatches(header, current string) bool {
	header = strings.TrimSpace(header)
	if header == "*" {
		return true
	}
	matched := false
	for header != "" {
		header = strings.TrimSpace(header)
		if header == "" {
			break
		}
		if strings.HasPrefix(header, ",") {
			header = header[1:]
			continue
		}
		start := 0
		if strings.HasPrefix(header, "W/") {
			start = 2
		}
		if len(header[start:]) < 2 || header[start] != '"' {
			return false
		}
		end := start + 1
		for ; end < len(header) && header[end] != '"'; end++ {
			c := header[end]
			if !(c == 0x21 || c >= 0x23 && c <= 0x7e || c >= 0x80) {
				return false
			}
		}
		if end == len(header) {
			return false
		}
		if header[start:end+1] == current {
			matched = true
		}
		header = strings.TrimSpace(header[end+1:])
		if header != "" && header[0] != ',' {
			return false
		}
	}
	return matched
}

func (s *Server) readAsset(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Cache-Control", "no-store")
	claims, e := s.tokens.Verify(r.URL.Query().Get("token"), "asset-read")
	if e != nil {
		return e
	}
	uid, ok := claims["sub"].(string)
	if !ok || claims["aid"] != chi.URLParam(r, "assetId") {
		return httpapi.Fail(401, "UNAUTHENTICATED", "素材签名不匹配。")
	}
	sessionID, _ := claims["sid"].(string)
	r, e = s.signedRequest(r, uid, sessionID, authorization.TVAccess)
	if e != nil {
		return e
	}
	a, e := accessibleAsset(r.Context(), s.db, uid, chi.URLParam(r, "assetId"), false)
	if e != nil {
		return e
	}
	return s.serveAssetBytes(w, r, a)
}

func (s *Server) serveAssetBytes(w http.ResponseWriter, r *http.Request, a Asset) error {
	if a.State != "READY" {
		return httpapi.Fail(409, "ASSET_NOT_READY", "素材尚未就绪。")
	}
	file, e := os.Open(filepath.Join(s.cfg.StorageRoot, a.ID))
	if e != nil {
		return httpapi.Retry(503, "ASSET_STORAGE_UNAVAILABLE", "素材文件暂不可用。")
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() || info.Size() != a.ByteSize {
		return httpapi.Retry(503, "ASSET_STORAGE_UNAVAILABLE", "素材文件暂不可用。")
	}
	// Native video posters request a still from the same authorized media URL.
	// Never return the original video bytes to this image request, including on
	// extraction failure. Both signed assets and canvas-media reach this gate.
	if r.URL.Query().Has("ci-process") {
		return s.serveVideoPreview(w, r, a, file)
	}
	if strings.HasPrefix(r.URL.Path, canvasMediaRoot) && r.URL.Query().Has("previewWidth") {
		served, err := s.serveCanvasPreview(w, r, a, file)
		if served || err != nil {
			return err
		}
	}
	etag := "\"" + a.Checksum + "\""
	// Authorization, readiness and the local file are checked before permitting
	// reuse of browser bytes. Revoked access must never receive a successful 304.
	if (r.Method == "GET" || r.Method == "HEAD") && assetETagMatches(strings.Join(r.Header.Values("If-None-Match"), ","), etag) {
		w.Header().Set("Cache-Control", "private, no-cache, must-revalidate")
		w.Header().Set("ETag", etag)
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	rangeHeader := r.Header.Get("Range")
	// This immutable asset endpoint publishes an ETag, not Last-Modified. Only
	// an identical strong tag proves that the requested byte range is current.
	if value := strings.TrimSpace(r.Header.Get("If-Range")); value != "" && value != etag {
		rangeHeader = ""
	}
	rangeValue, e := ParseRange(rangeHeader, info.Size())
	if e != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", info.Size()))
		return e
	}
	w.Header().Set("Content-Type", a.MimeType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, no-cache, must-revalidate")
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(a.FileName))
	length := info.Size()
	status := 200
	if rangeValue != nil {
		status = 206
		length = rangeValue.End - rangeValue.Start + 1
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", rangeValue.Start, rangeValue.End, info.Size()))
		if _, e = file.Seek(rangeValue.Start, io.SeekStart); e != nil {
			return e
		}
	}
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(status)
	if r.Method == "HEAD" {
		return nil
	}
	_, e = io.CopyN(w, file, length)
	if e != nil {
		slog.Warn("asset stream interrupted", "requestId", httpapi.RequestID(r), "assetId", a.ID)
	}
	return nil
}

type mediaProbe struct {
	Streams []struct {
		CodecType     string `json:"codec_type"`
		Width, Height int
		Duration      string
		Disposition   struct {
			AttachedPic int `json:"attached_pic"`
		}
	}
	Format struct{ Duration string }
}
type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("ffprobe output too large")
	}
	return b.Buffer.Write(p)
}
func (s *Server) inspectMedia(ctx context.Context, file, expected, kind string) (*int, *int, *float64, error) {
	detected, e := mimetype.DetectFile(file)
	if e != nil {
		return nil, nil, nil, e
	}
	actual, _, e := mime.ParseMediaType(detected.String())
	if e != nil {
		return nil, nil, nil, e
	}
	switch actual {
	case "audio/x-wav", "audio/vnd.wave":
		actual = "audio/wav"
	case "audio/x-m4a":
		actual = "audio/mp4"
	case "video/x-m4v":
		actual = "video/mp4"
	}
	compatible := actual == expected || expected == "audio/mp4" && actual == "video/mp4" || expected == "audio/webm" && actual == "video/webm" || expected == "image/png" && actual == "image/apng"
	if !compatible {
		return nil, nil, nil, httpapi.Fail(422, "MIME_MISMATCH", "真实文件类型与声明MIME不一致。")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.cfg.FFprobePath, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "stream=codec_type,width,height,duration:stream_disposition=attached_pic:format=duration", "-of", "json", file)
	output := &boundedBuffer{limit: 262144}
	errOutput := &boundedBuffer{limit: 16384}
	cmd.Stdout = output
	cmd.Stderr = errOutput
	if e = cmd.Run(); e != nil {
		if errors.Is(e, exec.ErrNotFound) || errors.Is(e, os.ErrNotExist) {
			return nil, nil, nil, httpapi.Retry(503, "MEDIA_INSPECTOR_UNAVAILABLE", "服务器媒体校验器尚未安装。")
		}
		return nil, nil, nil, httpapi.Fail(422, "MEDIA_INVALID", "媒体无法解码或元数据无效。")
	}
	var probe mediaProbe
	if e = json.Unmarshal(output.Bytes(), &probe); e != nil {
		return nil, nil, nil, httpapi.Fail(422, "MEDIA_INVALID", "媒体元数据无效。")
	}
	video := -1
	audio := -1
	for i, stream := range probe.Streams {
		if stream.CodecType == "video" && stream.Disposition.AttachedPic != 1 {
			video = i
		}
		if stream.CodecType == "audio" {
			audio = i
		}
	}
	if kind == "AUDIO" && (audio < 0 || video >= 0) {
		return nil, nil, nil, httpapi.Fail(422, "MEDIA_KIND_MISMATCH", "声明音频不能包含视频轨道。")
	}
	var width, height *int
	if kind != "AUDIO" {
		if video < 0 || probe.Streams[video].Width <= 0 || probe.Streams[video].Height <= 0 {
			return nil, nil, nil, httpapi.Fail(422, "MEDIA_INVALID", "媒体宽高无效。")
		}
		width = &probe.Streams[video].Width
		height = &probe.Streams[video].Height
	}
	var duration *float64
	if kind != "IMAGE" {
		raw := probe.Format.Duration
		if raw == "" {
			if video >= 0 {
				raw = probe.Streams[video].Duration
			} else if audio >= 0 {
				raw = probe.Streams[audio].Duration
			}
		}
		value, e := strconv.ParseFloat(raw, 64)
		if e != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return nil, nil, nil, httpapi.Fail(422, "MEDIA_INVALID", "媒体时长无效。")
		}
		duration = &value
	}
	return width, height, duration, nil
}
