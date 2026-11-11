package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"strconv"
	"time"
)

type entryHandler struct{ s *application.EntryService }

func RegisterEntryRoutes(router chi.Router, s *application.EntryService, protect Protect) error {
	if router == nil || s == nil || protect == nil {
		return errors.New("library entry router, service and protect required")
	}
	h := entryHandler{s}
	reg := func(method, path string, next httpapi.Handler) {
		router.MethodFunc(method, "/api/v2/library"+path, protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if e := actor(r).Validate(); e != nil {
				return mapError(e)
			}
			if r.Method != "GET" {
				if _, e := queryValues(r); e != nil {
					return mapError(e)
				}
			}
			return mapError(next(w, r))
		}))
	}
	reg("GET", "/state", h.state)
	reg("GET", "/folders", h.list(true))
	reg("POST", "/folders", h.createFolder)
	reg("GET", "/folders/{id}", h.folder)
	reg("PATCH", "/folders/{id}", h.updateFolder)
	reg("GET", "/entries", h.list(false))
	reg("GET", "/nodes/{id}", h.node)
	reg("PATCH", "/nodes/{id}", h.updateNode)
	reg("POST", "/batch-create", h.batchCreate)
	reg("POST", "/batch-delete", h.batchMutate(false))
	reg("POST", "/move", h.batchMutate(true))
	return nil
}
func entryMutation(r *http.Request, body any, version, uuid bool) (application.EntryMutation, error) {
	var m application.EntryMutation
	var e error
	if version {
		m.Expected, e = revision(r)
		if e != nil {
			return m, e
		}
	}
	if uuid {
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 {
			return m, httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要UUID格式Idempotency-Key。")
		}
		m.Key, e = application.NormalizeKey(keys[0])
		if e != nil {
			return m, e
		}
	}
	raw, e := json.Marshal(body)
	if e != nil {
		return m, e
	}
	var object map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&object) != nil {
		return m, domain.ErrInvalid
	}
	m.Hash, e = application.CreationHash(object)
	return m, e
}
func entryOutput(w http.ResponseWriter, r *http.Request, status int, rev int64, v any) error {
	if rev > 0 {
		w.Header().Set("ETag", etag(rev))
	}
	return httpapi.OK(w, r, status, v)
}
func (h entryHandler) state(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	rev, e := h.s.Repo.State(r.Context(), actor(r))
	if e != nil {
		return e
	}
	return entryOutput(w, r, 200, rev, map[string]any{"revision": rev})
}
func (h entryHandler) folder(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	v, e := h.s.Repo.Folder(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return entryOutput(w, r, 200, v.Revision, v)
}
func (h entryHandler) createFolder(w http.ResponseWriter, r *http.Request) error {
	var i domain.FolderInput
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	if e := i.Validate(); e != nil {
		return e
	}
	m, e := entryMutation(r, i, false, true)
	if e != nil {
		return e
	}
	v, e := h.s.Repo.CreateFolder(r.Context(), actor(r), i, m)
	if e != nil {
		return e
	}
	return entryOutput(w, r, 201, v.Revision, v)
}
func (h entryHandler) updateFolder(w http.ResponseWriter, r *http.Request) error {
	var i domain.FolderPatch
	if e := httpapi.Decode(w, r, &i); e != nil {
		return e
	}
	if e := i.Validate(); e != nil {
		return e
	}
	m, e := entryMutation(r, i, true, false)
	if e != nil {
		return e
	}
	v, e := h.s.Repo.UpdateFolder(r.Context(), actor(r), chi.URLParam(r, "id"), i, m)
	if e != nil {
		return e
	}
	return entryOutput(w, r, 200, v.Revision, v)
}
func entryQuery(r *http.Request) (domain.EntryQuery, error) {
	v, e := queryValues(r, "page", "size", "parentId", "categoryCode", "keyword", "recursive", "kind", "itemType", "afterTime", "beforeTime", "nodeKind", "nodeTypes")
	q := domain.EntryQuery{Page: 1, Size: 20}
	if e != nil {
		return q, e
	}
	for _, key := range []string{"page", "size"} {
		if raw := v.Get(key); raw != "" {
			n, e := strconv.Atoi(raw)
			if e != nil || strconv.Itoa(n) != raw {
				return q, domain.ErrInvalid
			}
			if key == "page" {
				q.Page = n
			} else {
				q.Size = n
			}
		}
	}
	if raw, ok := v["parentId"]; ok {
		q.ParentID = &raw[0]
	}
	q.CategoryCode = v.Get("categoryCode")
	q.Keyword = v.Get("keyword")
	q.Kind = v.Get("kind")
	q.ItemType = v.Get("itemType")
	q.NodeKind = v.Get("nodeKind")
	if raw := v.Get("nodeTypes"); raw != "" {
		if json.Unmarshal([]byte(raw), &q.NodeTypes) != nil {
			return q, domain.ErrInvalid
		}
	}
	if raw := v.Get("recursive"); raw != "" {
		if raw != "true" && raw != "false" {
			return q, domain.ErrInvalid
		}
		q.Recursive = raw == "true"
	}
	for _, key := range []string{"afterTime", "beforeTime"} {
		if raw := v.Get(key); raw != "" {
			t, e := time.Parse(time.RFC3339Nano, raw)
			if e != nil {
				return q, domain.ErrInvalid
			}
			if key == "afterTime" {
				q.AfterTime = &t
			} else {
				q.BeforeTime = &t
			}
		}
	}
	return q, q.Validate()
}
func (h entryHandler) list(folders bool) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		q, e := entryQuery(r)
		if e != nil {
			return e
		}
		var p domain.EntriesPage
		if folders {
			p, e = h.s.Repo.Folders(r.Context(), actor(r), q)
		} else {
			p, e = h.s.Repo.Entries(r.Context(), actor(r), q)
		}
		if e != nil {
			return e
		}
		return entryOutput(w, r, 200, 0, p)
	}
}
func (h entryHandler) node(w http.ResponseWriter, r *http.Request) error {
	if _, e := queryValues(r); e != nil {
		return e
	}
	v, e := h.s.Repo.Node(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return entryOutput(w, r, 200, v.Revision, v)
}
func (h entryHandler) updateNode(w http.ResponseWriter, r *http.Request) error {
	var i domain.NodeInput
	if e := httpapi.DecodeLimit(w, r, &i, 1100000); e != nil {
		return e
	}
	if e := i.Validate(); e != nil {
		return e
	}
	m, e := entryMutation(r, i, true, false)
	if e != nil {
		return e
	}
	v, e := h.s.Repo.UpdateNode(r.Context(), actor(r), chi.URLParam(r, "id"), i, m)
	if e != nil {
		return e
	}
	return entryOutput(w, r, 200, v.Revision, v)
}
func (h entryHandler) batchCreate(w http.ResponseWriter, r *http.Request) error {
	var b domain.BatchCreate
	if e := httpapi.DecodeLimit(w, r, &b, 8*1024*1024); e != nil {
		return e
	}
	if e := b.Validate(); e != nil {
		return e
	}
	m, e := entryMutation(r, b, false, true)
	if e != nil {
		return e
	}
	v, e := h.s.Repo.BatchCreate(r.Context(), actor(r), b, m)
	if e != nil {
		return e
	}
	return entryOutput(w, r, 201, v.Revision, v)
}
func (h entryHandler) batchMutate(move bool) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		var b domain.BatchMutation
		if e := httpapi.Decode(w, r, &b); e != nil {
			return e
		}
		if e := b.Validate(move); e != nil {
			return e
		}
		m, e := entryMutation(r, b, false, true)
		if e != nil {
			return e
		}
		v, e := h.s.Repo.BatchMutate(r.Context(), actor(r), b, move, m)
		if e != nil {
			return e
		}
		return entryOutput(w, r, 200, v.Revision, v)
	}
}
