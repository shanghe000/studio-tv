package application

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"strings"
)

var ErrNotFound = errors.New("model media not available")

// SizeError is disclosed only after the immutable asset's read grant is checked.
// It preserves the existing not-found status while allowing the authenticated
// model service to explain an unsupported size without reading the blob.
type SizeError struct{ Actual, Maximum int64 }

func (e *SizeError) Error() string { return "model media exceeds supported size" }
func (e *SizeError) Unwrap() error { return ErrNotFound }

const MaxImageBytes int64 = 10 << 20

var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Request struct {
	SubjectRef    string `json:"subjectRef"`
	SourceRef     string `json:"sourceRef"`
	SourceVersion string `json:"sourceVersion"`
	SHA256        string `json:"sha256"`
	ReadGrantRef  string `json:"readGrantRef"`
}
type Asset struct {
	ID, StorageKey, MimeType, SHA256 string
	ByteSize                         int64
	Width, Height                    *int
	DurationMs                       *int64
}
type Grants interface {
	Resolve(context.Context, Request) (Asset, error)
}
type Blobs interface {
	Read(context.Context, Asset) ([]byte, error)
}
type Reader struct {
	grants Grants
	blobs  Blobs
}

func New(g Grants, b Blobs) *Reader { return &Reader{g, b} }
func (s *Reader) Read(ctx context.Context, r Request) ([]byte, string, error) {
	body, a, err := s.ReadMedia(ctx, r, false)
	return body, a.MimeType, err
}

// ReferenceMediaPolicy is shared by model preflight and the authenticated byte reader.
func ReferenceMediaPolicy(kind string) (int64, []string) {
	switch kind {
	case "IMAGE":
		return MaxImageBytes, []string{"image/png", "image/jpeg", "image/webp"}
	case "AUDIO":
		return 16 << 20, []string{"audio/wav", "audio/mpeg"}
	case "VIDEO":
		return 64 << 20, []string{"video/mp4"}
	}
	return 0, nil
}
func MediaLimit(mime string) int64 {
	family, _, _ := strings.Cut(mime, "/")
	maximum, formats := ReferenceMediaPolicy(strings.ToUpper(family))
	if slices.Contains(formats, mime) {
		return maximum
	}
	return 0
}
func (s *Reader) ReadMedia(ctx context.Context, r Request, multimodal bool) ([]byte, Asset, error) {
	if r.SubjectRef == "" || r.SourceRef == "" || r.ReadGrantRef == "" || !digest.MatchString(r.SHA256) || r.SourceVersion != "sha256:"+r.SHA256 {
		return nil, Asset{}, ErrNotFound
	}
	a, err := s.grants.Resolve(ctx, r)
	if err != nil {
		return nil, Asset{}, err
	}
	if a.ID != r.SourceRef || a.SHA256 != r.SHA256 || a.ByteSize < 1 || MediaLimit(a.MimeType) == 0 || a.StorageKey != a.ID || (!multimodal && a.MimeType != "image/png" && a.MimeType != "image/jpeg" && a.MimeType != "image/webp") {
		return nil, Asset{}, ErrNotFound
	}
	if a.ByteSize > MediaLimit(a.MimeType) {
		return nil, Asset{}, &SizeError{Actual: a.ByteSize, Maximum: MediaLimit(a.MimeType)}
	}
	body, err := s.blobs.Read(ctx, a)
	return body, a, err
}
