package collaboration

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/httpapi"
)

func decodeTeamStrict(raw []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if decoder.Decode(out) != nil {
		return teamInvalid()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return teamInvalid()
	}
	return nil
}
func canonicalTeamJSON(raw []byte) (json.RawMessage, error) {
	var value any
	if e := decodeTeamStrict(raw, &value); e != nil {
		return nil, e
	}
	return json.Marshal(value)
}
func teamPageQuery(r *http.Request, allowed ...string) (int, int, error) {
	q := r.URL.Query()
	for key, values := range q {
		valid := key == "page" || key == "size"
		for _, a := range allowed {
			valid = valid || key == a
		}
		if !valid || len(values) != 1 {
			return 0, 0, teamInvalid()
		}
	}
	page, size := 1, 20
	var err error
	if q.Has("page") {
		page, err = strconv.Atoi(q.Get("page"))
		if err != nil {
			return 0, 0, teamInvalid()
		}
	}
	if q.Has("size") {
		size, err = strconv.Atoi(q.Get("size"))
		if err != nil {
			return 0, 0, teamInvalid()
		}
	}
	if page < 1 || page > 100000 || size < 1 || size > 100 {
		return 0, 0, teamInvalid()
	}
	return page, size, nil
}
func teamMatch(r *http.Request) (int64, error) {
	value := r.Header.Get("If-Match")
	if value == "" {
		return 0, httpapi.Fail(428, "IF_MATCH_REQUIRED", "需要当前内容强ETag。")
	}
	if len(value) < 3 || value[0] != '"' || value[len(value)-1] != '"' {
		return 0, teamInvalid()
	}
	n, e := strconv.ParseInt(value[1:len(value)-1], 10, 64)
	if e != nil || n < 1 || teamETag(n) != value {
		return 0, teamInvalid()
	}
	return n, nil
}
func RegisterAssetRoutes(r chi.Router, pool *pgxpool.Pool, storageRoot string, protect Protect) error {
	if r == nil || protect == nil {
		return errors.New("team asset routes require router and protection")
	}
	service, e := NewTeamAssetService(pool, storageRoot)
	if e != nil {
		return e
	}
	route := func(method, path string, h httpapi.Handler) {
		r.MethodFunc(method, "/api/v2/collaboration"+path, protect(authorization.TVAccess, h))
	}
	route("GET", "/teams/{teamId}/folders", func(w http.ResponseWriter, r *http.Request) error {
		page, size, e := teamPageQuery(r)
		if e != nil {
			return e
		}
		result, e := service.Folders(r.Context(), actor(r), chi.URLParam(r, "teamId"), page, size)
		if e != nil {
			return e
		}
		return httpapi.JSON(w, 200, result)
	})
	route("POST", "/teams/{teamId}/folders", func(w http.ResponseWriter, r *http.Request) error {
		var b struct {
			Name     string  `json:"name"`
			ParentID *string `json:"parentId"`
		}
		if e := httpapi.DecodeLimit(w, r, &b, 16384); e != nil {
			return e
		}
		key, e := teamAssetKey(r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		result, e := service.CreateFolder(r.Context(), actor(r), chi.URLParam(r, "teamId"), b.Name, b.ParentID, key)
		if e != nil {
			return e
		}
		w.Header().Set("ETag", teamETag(result.Revision))
		return httpapi.JSON(w, 201, result)
	})
	route("PATCH", "/teams/{teamId}/folders/{folderId}", func(w http.ResponseWriter, r *http.Request) error {
		revision, e := teamMatch(r)
		if e != nil {
			return e
		}
		var b struct {
			Name *string `json:"name"`
		}
		if e = httpapi.DecodeLimit(w, r, &b, 16384); e != nil {
			return e
		}
		result, e := service.ChangeFolder(r.Context(), actor(r), chi.URLParam(r, "teamId"), chi.URLParam(r, "folderId"), revision, b.Name, false, r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		w.Header().Set("ETag", teamETag(result.Revision))
		return httpapi.JSON(w, 200, result)
	})
	route("DELETE", "/teams/{teamId}/folders/{folderId}", func(w http.ResponseWriter, r *http.Request) error {
		revision, e := teamMatch(r)
		if e != nil {
			return e
		}
		_, e = service.ChangeFolder(r.Context(), actor(r), chi.URLParam(r, "teamId"), chi.URLParam(r, "folderId"), revision, nil, true, r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		w.WriteHeader(204)
		return nil
	})
	route("GET", "/teams/{teamId}/assets", func(w http.ResponseWriter, r *http.Request) error {
		page, size, e := teamPageQuery(r, "folderId", "keyword")
		if e != nil {
			return e
		}
		var folder *string
		if r.URL.Query().Has("folderId") {
			v := r.URL.Query().Get("folderId")
			folder = &v
		}
		result, e := service.Entries(r.Context(), actor(r), chi.URLParam(r, "teamId"), folder, r.URL.Query().Get("keyword"), page, size)
		if e != nil {
			return e
		}
		return httpapi.JSON(w, 200, result)
	})
	route("POST", "/teams/{teamId}/assets", func(w http.ResponseWriter, r *http.Request) error {
		var b PublishTeamAsset
		if e := httpapi.DecodeLimit(w, r, &b, 16384); e != nil {
			return e
		}
		result, e := service.Publish(r.Context(), actor(r), chi.URLParam(r, "teamId"), b, r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		w.Header().Set("ETag", teamETag(result.Revision))
		return httpapi.JSON(w, 201, result)
	})
	route("GET", "/teams/{teamId}/assets/{entryId}", func(w http.ResponseWriter, r *http.Request) error {
		result, e := service.Entry(r.Context(), actor(r), chi.URLParam(r, "teamId"), chi.URLParam(r, "entryId"))
		if e != nil {
			return e
		}
		w.Header().Set("ETag", teamETag(result.Revision))
		return httpapi.JSON(w, 200, result)
	})
	route("PATCH", "/teams/{teamId}/assets/{entryId}", func(w http.ResponseWriter, r *http.Request) error {
		revision, e := teamMatch(r)
		if e != nil {
			return e
		}
		var b TeamAssetPatch
		if e = httpapi.DecodeLimit(w, r, &b, 16384); e != nil {
			return e
		}
		result, e := service.ChangeEntry(r.Context(), actor(r), chi.URLParam(r, "teamId"), chi.URLParam(r, "entryId"), revision, b, false, r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		w.Header().Set("ETag", teamETag(result.Revision))
		return httpapi.JSON(w, 200, result)
	})
	route("DELETE", "/teams/{teamId}/assets/{entryId}", func(w http.ResponseWriter, r *http.Request) error {
		revision, e := teamMatch(r)
		if e != nil {
			return e
		}
		_, e = service.ChangeEntry(r.Context(), actor(r), chi.URLParam(r, "teamId"), chi.URLParam(r, "entryId"), revision, TeamAssetPatch{}, true, r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		w.WriteHeader(204)
		return nil
	})
	route("POST", "/teams/{teamId}/assets/{entryId}/import", func(w http.ResponseWriter, r *http.Request) error {
		var b struct {
			ProjectID string `json:"projectId"`
		}
		if e := httpapi.DecodeLimit(w, r, &b, 16384); e != nil {
			return e
		}
		result, e := service.Import(r.Context(), actor(r), chi.URLParam(r, "teamId"), chi.URLParam(r, "entryId"), b.ProjectID, r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		return httpapi.JSON(w, 201, result)
	})
	route("POST", "/projects/{projectId}/assets/import", func(w http.ResponseWriter, r *http.Request) error {
		var b struct {
			AssetIDs []string `json:"assetIds"`
		}
		if e := httpapi.DecodeLimit(w, r, &b, 16384); e != nil {
			return e
		}
		key, e := teamAssetKey(r.Header.Get("Idempotency-Key"))
		if e != nil {
			return e
		}
		result, e := CopyAssetsToProject(r.Context(), pool, storageRoot, actor(r), chi.URLParam(r, "projectId"), b.AssetIDs, key)
		if e != nil {
			return e
		}
		return httpapi.JSON(w, 201, result)
	})
	return nil
}
