// Package domain models a private ROLE or SCENE gallery, not a public catalog.
package domain

import (
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrInvalid             = errors.New("invalid library parameter")
	ErrUnauthenticated     = errors.New("verified actor required")
	ErrNotFound            = errors.New("library item not visible")
	ErrAssetNotFound       = errors.New("owned READY image not visible")
	ErrIdempotencyConflict = errors.New("idempotency key used for another request")
	ErrUnavailable         = errors.New("library persistence unavailable")
)

type VersionConflict struct{ Current int64 }

func (e *VersionConflict) Error() string { return "library revision changed" }

type Kind string

const Role Kind = "ROLE"
const Scene Kind = "SCENE"

type VerifiedActor struct{ OwnerID string }

func (a VerifiedActor) Validate() error {
	if a.OwnerID == "" {
		return ErrUnauthenticated
	}
	return nil
}
func ValidID(v string) bool {
	return utf8.ValidString(v) && !strings.ContainsRune(v, 0) && utf8.RuneCountInString(v) >= 1 && utf8.RuneCountInString(v) <= 200
}

// Input fully replaces the editable fields. Owner and kind cannot be changed.
type Input struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Kind        Kind     `json:"kind"`
	AssetIDs    []string `json:"assetIds"`
	MainAssetID *string  `json:"mainAssetId"`
}

func (c Input) Validate() error {
	if !utf8.ValidString(c.Title) || strings.ContainsRune(c.Title, 0) || strings.TrimSpace(c.Title) == "" || utf8.RuneCountInString(c.Title) > 120 || !utf8.ValidString(c.Description) || strings.ContainsRune(c.Description, 0) || utf8.RuneCountInString(c.Description) > 2000 || (c.Kind != Role && c.Kind != Scene) || c.AssetIDs == nil || len(c.AssetIDs) > 100 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, id := range c.AssetIDs {
		if !ValidID(id) || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
	}
	if c.MainAssetID != nil && !seen[*c.MainAssetID] {
		return ErrInvalid
	}
	return nil
}

type Gallery struct {
	ID           string
	OwnerID      string
	CategoryCode string
	FolderID     *string
	Input
	Revision  int64
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
}

func copyInput(c Input) Input {
	c.AssetIDs = append([]string{}, c.AssetIDs...)
	if c.MainAssetID != nil {
		v := *c.MainAssetID
		c.MainAssetID = &v
	}
	return c
}
func NewGallery(id string, a VerifiedActor, c Input, at time.Time) (Gallery, error) {
	if err := a.Validate(); err != nil {
		return Gallery{}, err
	}
	if err := c.Validate(); err != nil {
		return Gallery{}, err
	}
	if !ValidID(id) || at.IsZero() {
		return Gallery{}, ErrInvalid
	}
	return Gallery{ID: id, OwnerID: a.OwnerID, Input: copyInput(c), Revision: 1, CreatedAt: at.UTC(), UpdatedAt: at.UTC()}, nil
}
func (g *Gallery) Replace(c Input, expected int64, at time.Time) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if c.Kind != g.Kind {
		return ErrInvalid
	}
	if err := g.advance(expected, at); err != nil {
		return err
	}
	g.Input = copyInput(c)
	return nil
}
func (g *Gallery) SoftDelete(expected int64, at time.Time) error {
	if err := g.advance(expected, at); err != nil {
		return err
	}
	v := at.UTC()
	g.DeletedAt = &v
	return nil
}
func (g *Gallery) advance(expected int64, at time.Time) error {
	if g.DeletedAt != nil {
		return ErrNotFound
	}
	if expected != g.Revision {
		return &VersionConflict{Current: g.Revision}
	}
	if g.Revision < 1 || g.Revision == math.MaxInt64 || at.IsZero() {
		return ErrInvalid
	}
	g.Revision++
	g.UpdatedAt = at.UTC()
	return nil
}

type Query struct {
	Page, Size int
	Keyword    string
	Kind       *Kind
}

func (q Query) Validate() error {
	if q.Page < 1 || q.Page > 100000 || q.Size < 1 || q.Size > 100 || !utf8.ValidString(q.Keyword) || strings.ContainsRune(q.Keyword, 0) || utf8.RuneCountInString(q.Keyword) > 300 || q.Kind != nil && *q.Kind != Role && *q.Kind != Scene {
		return ErrInvalid
	}
	return nil
}
func (q Query) Offset() int64 { return int64(q.Page-1) * int64(q.Size) }

type Page struct {
	Records      []Gallery
	Page, Size   int
	Total, Pages int64
	HasNext      bool
}

func NewPage(q Query, records []Gallery, total int64) Page {
	if records == nil {
		records = []Gallery{}
	}
	pages := (total + int64(q.Size) - 1) / int64(q.Size)
	return Page{records, q.Page, q.Size, total, pages, int64(q.Page) < pages}
}
