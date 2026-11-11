package http

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"strconv"
	"strings"
)

func (h handler) registerStudio(reg func(string, string, httpapi.Handler)) {
	reg("GET", "/hf/projects", h.studioList)
	reg("POST", "/hf/projects", h.studioSave(true))
	reg("GET", "/hf/projects/{id}", h.studioGet)
	reg("PATCH", "/hf/projects/{id}", h.studioSave(false))
	reg("DELETE", "/hf/projects/{id}", h.studioDelete)
	reg("GET", "/hf/projects/{id}/sessions", h.sessions)
	reg("POST", "/hf/projects/{id}/sessions", h.bindSession)
	reg("GET", "/studio/projects/{id}", h.studioGet)
	reg("GET", "/studio/projects/{id}/files/*", h.file)
	for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		reg(m, "/studio/projects/{id}/files/*", h.writeFile)
	}
	reg("POST", "/studio/projects/{id}/duplicate-file", h.duplicate)
	reg("POST", "/studio/projects/{id}/upload", h.upload)
	reg("GET", "/studio/projects/{id}/lint", h.lint)
	reg("GET", "/studio/events", h.events)
	reg("GET", "/studio/fonts", h.fonts(false))
	reg("GET", "/studio/fonts/google", h.fonts(true))
	reg("GET", "/studio/registry/blocks", h.blocks)
	reg("POST", "/studio/projects/{id}/registry/install", h.install)
	reg("POST", "/studio/projects/{id}/file-mutations/remove-element/*", h.removeElement)
	for _, p := range []struct{ method, path string }{{"GET", "/studio/projects/{id}/renders"}, {"POST", "/studio/projects/{id}/render"}, {"GET", "/studio/render/{jobId}/progress"}, {"DELETE", "/studio/render/{jobId}"}, {"GET", "/studio/projects/{id}/preview/*"}} {
		reg(p.method, p.path, func(w http.ResponseWriter, r *http.Request) error {
			if id := chi.URLParam(r, "id"); id != "" {
				if _, e := h.s.Store.StudioGet(r.Context(), actor(r), id); e != nil {
					return e
				}
			}
			return domain.ErrUnsupported
		})
	}
}
func (h handler) studioList(w http.ResponseWriter, r *http.Request) error {
	q, e := query(r, "type")
	if e != nil {
		return e
	}
	if v := q.Fields["type"]; v != "" && v != "HYPER_FRAMES" {
		return domain.ErrInvalid
	}
	rows, total, e := h.s.Store.StudioList(r.Context(), actor(r), q)
	if e != nil {
		return e
	}
	p := domain.NewPage(q, nil, total)
	return output(w, r, 200, 0, map[string]any{"projects": rows, "records": rows, "total": total, "page": q.Page, "current": q.Page, "size": q.Size, "pages": p.Pages, "hasNext": p.HasNext})
}
func (h handler) studioGet(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	v, e := h.s.Store.StudioGet(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return output(w, r, 200, v.Revision, v)
}
func (h handler) studioSave(create bool) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		var i domain.StudioInput
		if e := httpapi.Decode(w, r, &i); e != nil {
			return e
		}
		if !create && (i.ID != "" || i.ProjectID != nil) {
			return domain.ErrInvalid
		}
		if e := i.Validate(); e != nil {
			return e
		}
		m, e := mutation(r, i, !create, create)
		if e != nil {
			return e
		}
		v, e := h.s.Store.StudioSave(r.Context(), actor(r), chi.URLParam(r, "id"), i, m)
		if e != nil {
			return e
		}
		status := 200
		if create {
			status = 201
		}
		return output(w, r, status, v.Revision, v)
	}
}
func (h handler) studioDelete(w http.ResponseWriter, r *http.Request) error {
	m, e := mutation(r, nil, true, false)
	if e != nil {
		return e
	}
	rev, e := h.s.Store.StudioDelete(r.Context(), actor(r), chi.URLParam(r, "id"), m)
	if e != nil {
		return e
	}
	return output(w, r, 200, rev, map[string]any{"accepted": true, "revision": rev})
}
func filename(r *http.Request) (string, error) {
	name := chi.URLParam(r, "*")
	decoded, e := url.PathUnescape(name)
	if e != nil {
		return "", domain.ErrInvalid
	}
	if domain.ValidPath(decoded) != nil {
		return "", domain.ErrInvalid
	}
	return decoded, nil
}
func (h handler) file(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r, "optional"); e != nil {
		return e
	}
	name, e := filename(r)
	if e != nil {
		return e
	}
	v, e := h.s.Store.File(r.Context(), actor(r), chi.URLParam(r, "id"), name)
	if e != nil {
		return e
	}
	return output(w, r, 200, v.Revision, v)
}
func (h handler) writeFile(w http.ResponseWriter, r *http.Request) error {
	name, e := filename(r)
	if e != nil {
		return e
	}
	id := chi.URLParam(r, "id")
	var body any
	var i domain.FileInput
	var newPath string
	op := "write"
	switch r.Method {
	case "POST":
		op = "create"
		fallthrough
	case "PUT":
		if e = httpapi.DecodeLimit(w, r, &i, 12*1024*1024); e != nil {
			return e
		}
		if _, e = i.Bytes(); e != nil {
			return e
		}
		body = i
	case "DELETE":
		op = "delete"
	case "PATCH":
		op = "rename"
		var input struct {
			NewPath string `json:"newPath"`
		}
		if e = httpapi.Decode(w, r, &input); e != nil {
			return e
		}
		newPath = input.NewPath
		if domain.ValidPath(newPath) != nil {
			return domain.ErrInvalid
		}
		body = input
	}
	m, e := mutation(r, map[string]any{"path": name, "body": body}, true, r.Method == "POST")
	if e != nil {
		return e
	}
	v, e := h.s.Store.WriteFiles(r.Context(), actor(r), id, op, []domain.FileWrite{{Path: name, Input: i}}, newPath, m)
	if e != nil {
		return e
	}
	return output(w, r, 200, v.Revision, v)
}
func (h handler) duplicate(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Path string `json:"path"`
	}
	if e := httpapi.Decode(w, r, &body); e != nil {
		return e
	}
	if domain.ValidPath(body.Path) != nil {
		return domain.ErrInvalid
	}
	m, e := mutation(r, body, true, true)
	if e != nil {
		return e
	}
	v, e := h.s.Store.WriteFiles(r.Context(), actor(r), chi.URLParam(r, "id"), "duplicate", []domain.FileWrite{{Path: body.Path}}, "", m)
	if e != nil {
		return e
	}
	newName := ""
	if len(v.WrittenPaths) == 1 {
		newName = v.WrittenPaths[0]
	} else {
		return domain.ErrUnavailable
	}
	return output(w, r, 200, v.Revision, map[string]any{"path": newName, "revision": v.Revision, "project": v})
}
func (h handler) upload(w http.ResponseWriter, r *http.Request) error {
	v, e := values(r, "dir")
	if e != nil {
		return e
	}
	dir := v.Get("dir")
	if dir != "" && domain.ValidPath(dir) != nil {
		return domain.ErrInvalid
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024*1024)
	if e = r.ParseMultipartForm(1024 * 1024); e != nil {
		return httpapi.Fail(413, "PAYLOAD_TOO_LARGE", "上传请求无效或超过16MiB。")
	}
	defer r.MultipartForm.RemoveAll()
	if len(r.MultipartForm.Value) > 0 || len(r.MultipartForm.File) != 1 || len(r.MultipartForm.File["file"]) == 0 || len(r.MultipartForm.File["file"]) > 100 {
		return domain.ErrInvalid
	}
	files := []domain.FileWrite{}
	for _, fh := range r.MultipartForm.File["file"] {
		name := fh.Filename
		if name != path.Base(name) || strings.Contains(name, "\\") {
			return domain.ErrInvalid
		}
		if dir != "" {
			name = dir + "/" + name
		}
		if domain.ValidPath(name) != nil || fh.Size > 8*1024*1024 {
			return domain.ErrInvalid
		}
		f, e := fh.Open()
		if e != nil {
			return domain.ErrInvalid
		}
		raw, e := io.ReadAll(io.LimitReader(f, 8*1024*1024+1))
		_ = f.Close()
		if e != nil || len(raw) > 8*1024*1024 {
			return domain.ErrInvalid
		}
		typ := mime.TypeByExtension(path.Ext(name))
		if typ == "" {
			typ = http.DetectContentType(raw)
		}
		files = append(files, domain.FileWrite{Path: name, Input: domain.FileInput{Content: base64.StdEncoding.EncodeToString(raw), Encoding: "base64", MimeType: typ}})
	}
	m, e := mutation(r, files, true, true)
	if e != nil {
		return e
	}
	p, e := h.s.Store.WriteFiles(r.Context(), actor(r), chi.URLParam(r, "id"), "upload", files, "", m)
	if e != nil {
		return e
	}
	names := []string{}
	for _, f := range files {
		names = append(names, f.Path)
	}
	return output(w, r, 200, p.Revision, map[string]any{"files": names, "revision": p.Revision, "project": p})
}
func (h handler) sessions(w http.ResponseWriter, r *http.Request) error {
	v, e := h.s.Store.StudioSessions(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	return output(w, r, 200, 0, map[string]any{"records": v})
}
func (h handler) bindSession(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		SessionID string `json:"sessionId"`
	}
	if e := httpapi.Decode(w, r, &body); e != nil {
		return e
	}
	if !domain.ID(body.SessionID) {
		return domain.ErrInvalid
	}
	m, e := mutation(r, body, false, true)
	if e != nil {
		return e
	}
	if e = h.s.Store.BindSession(r.Context(), actor(r), chi.URLParam(r, "id"), body.SessionID, m); e != nil {
		return e
	}
	return output(w, r, 200, 0, map[string]any{"accepted": true})
}
func (h handler) blocks(w http.ResponseWriter, r *http.Request) error {
	p, e := h.s.Store.Entries(r.Context(), actor(r), "STUDIO_BLOCK", domain.Query{Page: 1, Size: 100, CategoryIDs: []string{}, Fields: map[string]string{}})
	if e != nil {
		return e
	}
	records := []any{}
	for _, v := range p.Records {
		records = append(records, json.RawMessage(v.Content))
	}
	return output(w, r, 200, 0, records)
}
func (h handler) install(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		BlockName string `json:"blockName"`
	}
	if e := httpapi.Decode(w, r, &body); e != nil {
		return e
	}
	if !domain.ID(body.BlockName) {
		return domain.ErrInvalid
	}
	block, e := h.s.Store.Entry(r.Context(), actor(r), "STUDIO_BLOCK", body.BlockName)
	if e != nil {
		return e
	}
	var content struct {
		Files []struct {
			Path     string `json:"path"`
			Content  string `json:"content"`
			MimeType string `json:"mimeType"`
		}
	}
	if json.Unmarshal(block.Content, &content) != nil {
		return domain.ErrUnavailable
	}
	files := []domain.FileWrite{}
	for _, f := range content.Files {
		files = append(files, domain.FileWrite{Path: f.Path, Input: domain.FileInput{Content: f.Content, Encoding: "utf8", MimeType: f.MimeType}})
	}
	m, e := mutation(r, body, true, true)
	if e != nil {
		return e
	}
	p, e := h.s.Store.WriteFiles(r.Context(), actor(r), chi.URLParam(r, "id"), "install", files, "", m)
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, map[string]any{"written": p.WrittenPaths, "block": view(block), "revision": p.Revision})
}
func (h handler) lint(w http.ResponseWriter, r *http.Request) error {
	p, e := h.s.Store.StudioGet(r.Context(), actor(r), chi.URLParam(r, "id"))
	if e != nil {
		return e
	}
	findings := []any{}
	for _, name := range p.Files {
		if strings.HasSuffix(name, ".json") {
			f, e := h.s.Store.File(r.Context(), actor(r), p.ID, name)
			if e != nil {
				return e
			}
			raw := []byte(f.Content)
			if f.Encoding == "base64" {
				raw, e = base64.StdEncoding.DecodeString(f.Content)
				if e != nil {
					return domain.ErrUnavailable
				}
			}
			if !json.Valid(raw) {
				findings = append(findings, map[string]any{"severity": "error", "message": "Invalid JSON", "file": name, "fixHint": "Save valid JSON."})
			}
		}
	}
	return output(w, r, 200, p.Revision, map[string]any{"findings": findings})
}

type studioEventPort interface {
	StudioEvents(context.Context, domain.Actor, int64) ([]json.RawMessage, bool, error)
}

func (h handler) events(w http.ResponseWriter, r *http.Request) error {
	v, e := values(r, "after")
	if e != nil {
		return e
	}
	after := int64(0)
	if raw := v.Get("after"); raw != "" {
		after, e = strconv.ParseInt(raw, 10, 64)
		if e != nil || after < 0 {
			return domain.ErrInvalid
		}
	}
	repo, ok := h.s.Store.(studioEventPort)
	if !ok {
		return domain.ErrUnsupported
	}
	rows, more, e := repo.StudioEvents(r.Context(), actor(r), after)
	if e != nil {
		return e
	}
	return output(w, r, 200, 0, map[string]any{"records": rows, "hasMore": more})
}

type fontPort interface {
	Fonts(context.Context, domain.Actor, bool) ([]string, error)
}

func (h handler) fonts(google bool) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		if _, e := values(r); e != nil {
			return e
		}
		repo, ok := h.s.Store.(fontPort)
		if !ok {
			return domain.ErrUnsupported
		}
		rows, e := repo.Fonts(r.Context(), actor(r), google)
		if e != nil {
			return e
		}
		return output(w, r, 200, 0, map[string]any{"fonts": rows})
	}
}

func (h handler) removeElement(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Target domain.ElementTarget `json:"target"`
	}
	if e := httpapi.Decode(w, r, &body); e != nil {
		return e
	}
	name, e := filename(r)
	if e != nil {
		return e
	}
	id := chi.URLParam(r, "id")
	m, e := mutation(r, body, true, false)
	if e != nil {
		return e
	}
	f, e := h.s.Store.File(r.Context(), actor(r), id, name)
	if e != nil {
		return e
	}
	if f.Revision != m.Expected {
		return &domain.VersionConflict{Current: f.Revision}
	}
	if f.Encoding != "utf8" || !strings.HasSuffix(strings.ToLower(name), ".html") {
		return domain.ErrInvalid
	}
	content, e := domain.RemoveElement(f.Content, body.Target)
	if e != nil {
		return e
	}
	p, e := h.s.Store.WriteFiles(r.Context(), actor(r), id, "write", []domain.FileWrite{{Path: name, Input: domain.FileInput{Content: content, Encoding: "utf8", MimeType: f.MimeType}}}, "", m)
	if e != nil {
		return e
	}
	return output(w, r, 200, p.Revision, map[string]any{"content": content, "revision": p.Revision})
}
