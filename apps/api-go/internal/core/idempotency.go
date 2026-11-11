package core

import (
	"bytes"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
	"strings"
)

type Result struct {
	Status int
	Data   any
}

func (s *Server) idempotent(r *http.Request, operation string, body any, fn func(pgx.Tx) (Result, error)) (Result, error) {
	key := r.Header.Get("Idempotency-Key")
	parsed, err := uuid.Parse(key)
	if err != nil || len(key) != 36 || strings.ToLower(key) != parsed.String() {
		return Result{}, httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式的Idempotency-Key。")
	}
	key = parsed.String()
	uid := owner(r)
	params := map[string]any{}
	rc := chi.RouteContext(r.Context())
	if rc != nil {
		for i, key := range rc.URLParams.Keys {
			params[key] = rc.URLParams.Values[i]
		}
	}
	hashInput := map[string]any{"body": body, "params": params, "team": nil}
	var hashBytes bytes.Buffer
	encoder := json.NewEncoder(&hashBytes)
	encoder.SetEscapeHTML(false)
	if e := encoder.Encode(hashInput); e != nil {
		return Result{}, e
	}
	hash := security.Digest(string(bytes.TrimSuffix(hashBytes.Bytes(), []byte("\n"))))
	return database.Transaction(r.Context(), s.db, func(tx pgx.Tx) (Result, error) {
		// Replays retain actor-keyed receipts but do not retain stale resource
		// authority. A revoked editor must not replay an earlier upload grant.
		switch operation {
		case "createAssetUpload":
			b, ok := body.(map[string]any)
			if !ok {
				return Result{}, httpapi.Fail(400, "VALIDATION_FAILED", "上传请求无效。")
			}
			pid, _ := b["projectId"].(string)
			if _, e := collaboration.RequireProject(r.Context(), tx, uid, pid, collaboration.EDITOR, true); e != nil {
				return Result{}, e
			}
		case "renewAssetUpload", "completeAssetUpload":
			if _, e := ownUpload(r.Context(), tx, uid, chi.URLParam(r, "uploadId")); e != nil {
				return Result{}, e
			}
		}
		if _, err := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", uid+":"+operation+":"+key); err != nil {
			return Result{}, err
		}
		var storedHash string
		var status int
		var response []byte
		err := tx.QueryRow(r.Context(), "SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3", uid, operation, key).Scan(&storedHash, &status, &response)
		if err == nil {
			if storedHash != hash {
				return Result{}, httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "该Idempotency-Key已用于不同请求。")
			}
			var data any
			decoder := json.NewDecoder(bytes.NewReader(response))
			decoder.UseNumber()
			if err = decoder.Decode(&data); err != nil {
				return Result{}, err
			}
			return Result{status, data}, nil
		}
		if err != pgx.ErrNoRows {
			return Result{}, err
		}
		result, err := fn(tx)
		if err != nil {
			return Result{}, err
		}
		_, err = tx.Exec(r.Context(), "INSERT INTO idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body)VALUES($1,$2,$3,$4,$5,$6)", uid, operation, key, hash, result.Status, encode(result.Data))
		return result, err
	})
}
