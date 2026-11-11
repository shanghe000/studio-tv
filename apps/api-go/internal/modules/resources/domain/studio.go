package domain

import (
	"encoding/base64"
	"path"
	"strings"
	"time"
)

func ValidPath(v string) error {
	if !Text(v, 512, true) || v != path.Clean(v) || strings.HasPrefix(v, "/") || strings.Contains(v, "\\") || strings.Contains(v, ":") || v == "." || v == ".." || strings.HasPrefix(v, "../") || strings.ContainsAny(v, "\r\n") {
		return ErrInvalid
	}
	for _, s := range strings.Split(v, "/") {
		if len(s) > 200 || s == "" || s == ".." || s == "." {
			return ErrInvalid
		}
	}
	return nil
}

type StudioProject struct {
	ID           string    `json:"id"`
	OwnerID      string    `json:"-"`
	Title        string    `json:"title"`
	ProjectID    *string   `json:"projectId"`
	Revision     int64     `json:"revision"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	Files        []string  `json:"files"`
	WrittenPaths []string  `json:"writtenPaths,omitempty"`
}
type StudioInput struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	ProjectID *string `json:"projectId"`
}

func (i StudioInput) Validate() error {
	if !Text(i.Title, 120, true) || (i.ID != "" && !ID(i.ID)) || (i.ProjectID != nil && !ID(*i.ProjectID)) {
		return ErrInvalid
	}
	return nil
}

type FileInput struct {
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	MimeType string `json:"mimeType"`
}

func (i FileInput) Bytes() ([]byte, error) {
	if !Text(i.MimeType, 150, true) || strings.ContainsAny(i.MimeType, "\r\n") {
		return nil, ErrInvalid
	}
	var b []byte
	switch i.Encoding {
	case "", "utf8":
		b = []byte(i.Content)
	case "base64":
		var e error
		b, e = base64.StdEncoding.Strict().DecodeString(i.Content)
		if e != nil {
			return nil, ErrInvalid
		}
	default:
		return nil, ErrInvalid
	}
	if len(b) > 8*1024*1024 {
		return nil, ErrInvalid
	}
	return b, nil
}

type StudioFile struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	MimeType string `json:"mimeType"`
	Revision int64  `json:"revision"`
}
type FileWrite struct {
	Path  string
	Input FileInput
}
