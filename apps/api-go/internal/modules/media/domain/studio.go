package domain

import (
	"encoding/json"
	"math"
	"path"
	"strings"
	"unicode"
)

type RenderCommand struct {
	FPS         int    `json:"fps"`
	Quality     string `json:"quality"`
	Format      string `json:"format"`
	Resolution  string `json:"resolution,omitempty"`
	Composition string `json:"composition,omitempty"`
}

func (c RenderCommand) Validate() error {
	if c.FPS != 24 && c.FPS != 30 && c.FPS != 60 {
		return ErrInvalid
	}
	if c.Quality != "draft" && c.Quality != "standard" && c.Quality != "high" {
		return ErrInvalid
	}
	if c.Format != "mp4" && c.Format != "webm" && c.Format != "mov" {
		return ErrInvalid
	}
	if c.Resolution != "" && c.Resolution != "1080p" && c.Resolution != "4k" {
		return ErrInvalid
	}
	if c.Composition != "" && (!ValidPath(c.Composition) || !strings.HasSuffix(strings.ToLower(c.Composition), ".html") && !strings.HasSuffix(strings.ToLower(c.Composition), ".htm")) {
		return ErrInvalid
	}
	return nil
}
func ValidPath(v string) bool {
	if v == "" || len(v) > 512 || path.IsAbs(v) || path.Clean(v) != v || strings.ContainsAny(v, "\\:") {
		return false
	}
	for _, part := range strings.Split(v, "/") {
		if part == ".." || part == "." || part == "" || len(part) > 200 {
			return false
		}
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

type StudioFile struct {
	Path     string `json:"path"`
	MimeType string `json:"mimeType"`
	Content  []byte `json:"content"`
}
type StudioBundle struct {
	ID        string        `json:"id"`
	ProjectID *string       `json:"projectId"`
	Revision  int64         `json:"revision"`
	Files     []StudioFile  `json:"files"`
	Command   RenderCommand `json:"command"`
}

func (b StudioBundle) Validate() error {
	if b.ID == "" || b.Revision < 1 || b.Command.Validate() != nil || len(b.Files) < 1 || len(b.Files) > 100 {
		return ErrInvalid
	}
	total := 0
	seen := map[string]bool{}
	index := false
	selected := b.Command.Composition == ""
	for _, f := range b.Files {
		if !ValidPath(f.Path) || seen[f.Path] || len(f.Content) > 8<<20 || len(f.MimeType) > 200 {
			return ErrInvalid
		}
		seen[f.Path] = true
		total += len(f.Content)
		if f.Path == "index.html" {
			index = true
		}
		if f.Path == b.Command.Composition && strings.HasPrefix(f.MimeType, "text/html") {
			selected = true
		}
	}
	if !index || !selected || total > 32<<20 {
		return ErrInvalid
	}
	return nil
}
func RenderMetadata(duration float64, width, height int) error {
	if duration <= 0 || duration > 120 || math.IsNaN(duration) || math.IsInf(duration, 0) || width < 2 || width > 3840 || height < 2 || height > 2160 {
		return ErrInvalid
	}
	return nil
}
func DecodeBundle(raw json.RawMessage) (StudioBundle, error) {
	var b StudioBundle
	if len(raw) > 48<<20 || json.Unmarshal(raw, &b) != nil {
		return b, ErrInvalid
	}
	return b, b.Validate()
}
