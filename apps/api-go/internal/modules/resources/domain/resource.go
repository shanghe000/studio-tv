// Package domain contains bounded resource, preference and studio rules. It has no environment or transport dependencies.
package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrInvalid         = errors.New("invalid resource parameter")
	ErrUnauthenticated = errors.New("verified resource actor required")
	ErrNotFound        = errors.New("resource not visible")
	ErrConflict        = errors.New("idempotency conflict")
	ErrUnavailable     = errors.New("resource storage unavailable")
	ErrUnsupported     = errors.New("resource operation not implemented")
)

type VersionConflict struct{ Current int64 }

func (e *VersionConflict) Error() string { return "resource revision changed" }

type Actor struct{ OwnerID string }

func (a Actor) Validate() error {
	if a.OwnerID == "" {
		return ErrUnauthenticated
	}
	return nil
}
func Text(s string, max int, required bool) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && utf8.RuneCountInString(s) <= max && (!required || strings.TrimSpace(s) != "")
}
func ID(s string) bool { return Text(s, 200, true) }

type Family string

const (
	Character       Family = "CHARACTER"
	Prompt          Family = "PROMPT"
	Skill           Family = "SKILL"
	Workflow        Family = "WORKFLOW"
	App             Family = "APP"
	Voice           Family = "VOICE"
	DirectorProject Family = "DIRECTOR_PROJECT"
	DirectorModel   Family = "DIRECTOR_MODEL"
)

func (f Family) PrivateWritable() bool {
	return f == Prompt || f == Skill || f == Workflow || f == DirectorProject || f == DirectorModel
}
func (f Family) Valid() bool { return f.PrivateWritable() || f == Character || f == App || f == Voice }

type Input struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	CategoryIDs  []string        `json:"categoryIds"`
	CoverAssetID *string         `json:"coverAssetId"`
	Content      json.RawMessage `json:"content"`
}
type PromptContent struct {
	PrefixPrompt     string  `json:"prefixPrompt"`
	SuffixPrompt     string  `json:"suffixPrompt"`
	PromptType       string  `json:"promptType"`
	MediaScope       string  `json:"mediaScope"`
	MenuType         string  `json:"menuType"`
	ReferenceAssetID *string `json:"referenceAssetId"`
}
type SkillFile struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	MimeType string `json:"mimeType"`
	Type     string `json:"type"`
	Primary  bool   `json:"primary"`
}
type SkillContent struct {
	Intro             string          `json:"intro"`
	Markdown          string          `json:"markdown"`
	Files             []SkillFile     `json:"files"`
	Category          string          `json:"category"`
	PresetPrompt      string          `json:"presetPrompt"`
	UseScenario       string          `json:"useScenario"`
	UseGuide          string          `json:"useGuide"`
	OutputContentDesc string          `json:"outputContentDesc"`
	OutputType        string          `json:"outputType"`
	Code              string          `json:"code"`
	Samples           json.RawMessage `json:"samples,omitempty"`
}
type WorkflowContent struct {
	WorkflowContent json.RawMessage `json:"workflowContent"`
	CustomNodes     json.RawMessage `json:"customNodes,omitempty"`
}
type DirectorContent struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
}
type DirectorModelContent struct {
	ModelAssetID   string  `json:"modelAssetId"`
	PreviewAssetID *string `json:"previewAssetId"`
	CategoryID     string  `json:"categoryId"`
}

func Strict(raw []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(out); e != nil {
		return ErrInvalid
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return ErrInvalid
	}
	return nil
}
func (i Input) Validate(f Family) error {
	if !f.PrivateWritable() || !Text(i.Name, 120, true) || !Text(i.Description, 4000, false) || i.CategoryIDs == nil || len(i.CategoryIDs) > 100 || (len(i.Content) > 1024*1024 && (f != Skill || len(i.Content) > 16*1024*1024)) || !json.Valid(i.Content) {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, id := range i.CategoryIDs {
		if !ID(id) || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
	}
	if i.CoverAssetID != nil && !ID(*i.CoverAssetID) {
		return ErrInvalid
	}
	switch f {
	case Prompt:
		var p PromptContent
		if Strict(i.Content, &p) != nil || !Text(p.PrefixPrompt, 200000, false) || !Text(p.SuffixPrompt, 200000, false) || (p.PrefixPrompt == "" && p.SuffixPrompt == "") || !one(p.PromptType, "", "PROMPT", "STYLE") || !one(p.MediaScope, "", "IMAGE", "VIDEO") || !one(p.MenuType, "", "portrait", "role_design") || p.ReferenceAssetID != nil && !ID(*p.ReferenceAssetID) {
			return ErrInvalid
		}
	case Skill:
		var s SkillContent
		if Strict(i.Content, &s) != nil || !Text(s.Markdown, 500000, false) || !Text(s.Intro, 4000, false) || len(s.Files) > 100 || !one(s.Category, "", "CANVAS_AGENT") {
			return ErrInvalid
		}
		for _, v := range []string{s.PresetPrompt, s.UseScenario, s.UseGuide, s.OutputContentDesc} {
			if !Text(v, 200000, false) {
				return ErrInvalid
			}
		}
		if !Text(s.OutputType, 100, false) || !Text(s.Code, 100, false) {
			return ErrInvalid
		}
		paths := map[string]bool{}
		for _, file := range s.Files {
			if ValidPath(file.Path) != nil || paths[file.Path] {
				return ErrInvalid
			}
			if file.Encoding == "" || file.Encoding == "utf8" {
				if !Text(file.Content, 8*1024*1024, false) {
					return ErrInvalid
				}
			}
			mimeType := file.MimeType
			if mimeType == "" {
				mimeType = "text/markdown"
			}
			if _, e := (FileInput{Content: file.Content, Encoding: file.Encoding, MimeType: mimeType}).Bytes(); e != nil {
				return ErrInvalid
			}
			if !Text(file.Type, 50, false) {
				return ErrInvalid
			}
			paths[file.Path] = true
		}
		if s.Markdown == "" && len(s.Files) == 0 && s.PresetPrompt == "" {
			return ErrInvalid
		}
	case Workflow:
		var v WorkflowContent
		if Strict(i.Content, &v) != nil || ValidGraph(v.WorkflowContent) != nil {
			return ErrInvalid
		}
		if len(v.CustomNodes) > 0 && !json.Valid(v.CustomNodes) {
			return ErrInvalid
		}
	case DirectorProject:
		var v DirectorContent
		if Strict(i.Content, &v) != nil || !one(v.Type, "2D", "3D") || len(v.Content) == 0 || !json.Valid(v.Content) || (string(v.Content) != "null" && v.Content[0] != '{') {
			return ErrInvalid
		}
	case DirectorModel:
		var v DirectorModelContent
		if Strict(i.Content, &v) != nil || !ID(v.ModelAssetID) || v.PreviewAssetID != nil && !ID(*v.PreviewAssetID) || !Text(v.CategoryID, 200, false) {
			return ErrInvalid
		}
	}
	_, e := i.AssetRefs(f)
	return e
}
func one(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}
func ValidGraph(raw []byte) error {
	var g struct {
		Nodes []json.RawMessage `json:"nodes"`
		Edges []json.RawMessage `json:"edges"`
	}
	if json.Unmarshal(raw, &g) != nil || len(g.Nodes) > 2000 || len(g.Edges) > 10000 || g.Nodes == nil || g.Edges == nil {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, n := range g.Nodes {
		var v struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(n, &v) != nil || !ID(v.ID) || seen[v.ID] {
			return ErrInvalid
		}
		seen[v.ID] = true
	}
	for _, n := range g.Edges {
		var v struct {
			Source string `json:"source"`
			Target string `json:"target"`
		}
		if json.Unmarshal(n, &v) != nil || !seen[v.Source] || !seen[v.Target] {
			return ErrInvalid
		}
	}
	return nil
}

type AssetRef struct {
	ID   string
	Kind string
}

func (i Input) AssetRefs(f Family) ([]AssetRef, error) {
	refs := []AssetRef{}
	seen := map[string]string{}
	add := func(id, kind string) {
		if _, ok := seen[id]; !ok {
			refs = append(refs, AssetRef{id, kind})
			seen[id] = kind
		} else if kind != "" {
			for n := range refs {
				if refs[n].ID == id {
					refs[n].Kind = kind
				}
			}
		}
	}
	if i.CoverAssetID != nil {
		add(*i.CoverAssetID, "IMAGE")
	}
	switch f {
	case Prompt:
		var v PromptContent
		_ = json.Unmarshal(i.Content, &v)
		if v.ReferenceAssetID != nil {
			add(*v.ReferenceAssetID, "IMAGE")
		}
	case DirectorModel:
		var v DirectorModelContent
		_ = json.Unmarshal(i.Content, &v)
		add(v.ModelAssetID, "MODEL")
		if v.PreviewAssetID != nil {
			add(*v.PreviewAssetID, "IMAGE")
		}
	case Skill:
		var v SkillContent
		_ = json.Unmarshal(i.Content, &v)
		if len(v.Samples) > 0 {
			ids, e := ExtractAssets(v.Samples)
			if e != nil {
				return nil, e
			}
			for _, id := range ids {
				add(id, "")
			}
		}
	case Workflow, DirectorProject:
		ids, e := ExtractAssets(i.Content)
		if e != nil {
			return nil, e
		}
		for _, id := range ids {
			add(id, "")
		}
	}
	if len(refs) > 500 {
		return nil, ErrInvalid
	}
	return refs, nil
}

// ExtractAssets canonicalizes media references. Untrusted remote/local media locations never become execution inputs.
func ExtractAssets(raw []byte) ([]string, error) {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil, ErrInvalid
	}
	ids := []string{}
	seen := map[string]bool{}
	var walk func(any, string, int) error
	walk = func(v any, key string, depth int) error {
		if depth > 64 {
			return ErrInvalid
		}
		switch x := v.(type) {
		case map[string]any:
			for k, z := range x {
				if e := walk(z, k, depth+1); e != nil {
					return e
				}
			}
		case []any:
			for _, z := range x {
				if e := walk(z, key, depth+1); e != nil {
					return e
				}
			}
		case string:
			if strings.HasPrefix(x, "rhtv-asset:") {
				id := strings.TrimPrefix(x, "rhtv-asset:")
				if !ID(id) {
					return ErrInvalid
				}
				if !seen[id] {
					ids = append(ids, id)
					seen[id] = true
				}
			} else {
				lk := strings.ToLower(key)
				media := strings.Contains(lk, "url")
				for _, suffix := range []string{"uri", "src", "thumbnail", "cover", "image", "video", "audio"} {
					if strings.HasSuffix(lk, suffix) {
						media = true
					}
				}
				if strings.HasSuffix(lk, "model") && (strings.Contains(x, ":") || strings.Contains(x, "/")) {
					media = true
				}
				if media && x != "" {
					return ErrInvalid
				}
				if (strings.HasSuffix(lk, "assetid") || strings.HasSuffix(lk, "assetids")) && x != "" {
					if !ID(x) {
						return ErrInvalid
					}
					if !seen[x] {
						ids = append(ids, x)
						seen[x] = true
					}
				}
			}
		}
		return nil
	}
	if e := walk(v, "", 0); e != nil {
		return nil, e
	}
	if len(ids) > 500 {
		return nil, ErrInvalid
	}
	return ids, nil
}

type Resource struct {
	ID      string  `json:"id"`
	Family  Family  `json:"-"`
	OwnerID *string `json:"-"`
	Scope   string  `json:"scope"`
	Input
	Revision  int64     `json:"revision"`
	Version   string    `json:"version"`
	CoverURL  string    `json:"coverUrl"`
	Favorited bool      `json:"favorited"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type Filter struct {
	CategoryCode string   `json:"categoryCode"`
	OptionCodes  []string `json:"optionCodes"`
}
type Query struct {
	Page         int
	Size         int
	Keyword      string
	Scope        string
	CategoryIDs  []string
	FavoriteOnly bool
	RecentOnly   bool
	Filters      []Filter
	Fields       map[string]string
	SceneIDs     []string
	Keys         []string
}

func (q Query) Validate() error {
	if q.Page < 1 || q.Page > 100000 || q.Size < 1 || q.Size > 100 || !Text(q.Keyword, 300, false) || !one(q.Scope, "", "SYSTEM", "USER", "COMMON") || len(q.CategoryIDs) > 100 || len(q.Filters) > 50 || len(q.SceneIDs) > 100 || len(q.Keys) > 100 {
		return ErrInvalid
	}
	for _, id := range append(append([]string{}, q.SceneIDs...), q.Keys...) {
		if !ID(id) {
			return ErrInvalid
		}
	}
	for _, id := range q.CategoryIDs {
		if !ID(id) {
			return ErrInvalid
		}
	}
	for _, f := range q.Filters {
		if !ID(f.CategoryCode) || len(f.OptionCodes) > 100 {
			return ErrInvalid
		}
		for _, id := range f.OptionCodes {
			if !ID(id) {
				return ErrInvalid
			}
		}
	}
	for _, v := range q.Fields {
		if !Text(v, 200, false) {
			return ErrInvalid
		}
	}
	return nil
}

type Page struct {
	Records []Resource `json:"records"`
	Page    int        `json:"page"`
	Current int        `json:"current"`
	Size    int        `json:"size"`
	Total   int64      `json:"total"`
	Pages   int64      `json:"pages"`
	HasNext bool       `json:"hasNext"`
}

func NewPage(q Query, rows []Resource, total int64) Page {
	if rows == nil {
		rows = []Resource{}
	}
	pages := (total + int64(q.Size) - 1) / int64(q.Size)
	return Page{rows, q.Page, q.Page, q.Size, total, pages, int64(q.Page) < pages}
}

type Usage struct {
	ID         string    `json:"id"`
	ResourceID string    `json:"resourceId"`
	ProjectID  *string   `json:"projectId"`
	NodeID     *string   `json:"nodeId"`
	CreatedAt  time.Time `json:"createdAt"`
}

// Defaults are server-owned typed content policy, not browser/static catalog fallbacks.
func (i Input) WithDefaults(f Family) Input {
	switch f {
	case Prompt:
		var p PromptContent
		if Strict(i.Content, &p) == nil {
			if p.PromptType == "" {
				p.PromptType = "PROMPT"
			}
			if p.MediaScope == "" {
				p.MediaScope = "IMAGE"
			}
			i.Content, _ = json.Marshal(p)
		}
	case Skill:
		var v SkillContent
		if Strict(i.Content, &v) == nil {
			if v.Category == "" {
				v.Category = "CANVAS_AGENT"
			}
			if v.Files == nil {
				v.Files = []SkillFile{}
			}
			i.Content, _ = json.Marshal(v)
		}
	}
	return i
}
