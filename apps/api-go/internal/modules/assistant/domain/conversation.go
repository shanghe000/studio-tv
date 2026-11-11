// Package domain contains product conversations; it never executes a model.
package domain

import (
	"errors"
	"math"
	"time"
	"unicode/utf8"
)

var (
	ErrInvalid              = errors.New("invalid conversation parameter")
	ErrUnauthenticated      = errors.New("verified actor required")
	ErrProjectNotFound      = errors.New("project not visible")
	ErrConversationNotFound = errors.New("conversation not visible")
	ErrIdempotencyConflict  = errors.New("idempotency key used for another request")
	ErrHFUnavailable        = errors.New("HF persistence is not implemented")
	ErrUnavailable          = errors.New("conversation persistence unavailable")
)

type VersionConflict struct{ Current int64 }

func (e *VersionConflict) Error() string { return "conversation revision changed" }

type Kind string

const Canvas Kind = "CANVAS"
const HF Kind = "HF"
const Global Kind = "GLOBAL"

// VerifiedActor must be constructed from a verified local session after tv.access.
// Browser supplied owner, workspace, Router session or IPAC claims are not actors.
type VerifiedActor struct{ OwnerID string }

func (a VerifiedActor) Validate() error {
	if a.OwnerID == "" {
		return ErrUnauthenticated
	}
	return nil
}

func ValidID(id string) bool {
	return utf8.ValidString(id) && utf8.RuneCountInString(id) >= 1 && utf8.RuneCountInString(id) <= 200
}

type Create struct {
	Kind        Kind
	ProjectID   *string
	HFProjectID *string
	Title       string
}

func (c Create) Validate() error {
	if !utf8.ValidString(c.Title) || utf8.RuneCountInString(c.Title) > 120 {
		return ErrInvalid
	}
	if c.ProjectID != nil && !ValidID(*c.ProjectID) || c.HFProjectID != nil && !ValidID(*c.HFProjectID) {
		return ErrInvalid
	}
	switch c.Kind {
	case Global:
		if c.ProjectID != nil || c.HFProjectID != nil {
			return ErrInvalid
		}
	case Canvas:
		if c.ProjectID == nil || c.HFProjectID != nil {
			return ErrInvalid
		}
	case HF:
		if c.ProjectID != nil {
			return ErrInvalid
		}
		return nil
	default:
		return ErrInvalid
	}
	return nil
}

type Conversation struct {
	ID                  string
	OwnerID             string
	Kind                Kind
	ProjectID           *string
	HFProjectID         *string
	Title               string
	TitleGenerated      bool
	Revision            int64
	NextMessageSequence int64
	RouterKey           *string
	RouterSessionRef    *string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	DeletedAt           *time.Time
}

func NewConversation(id string, actor VerifiedActor, command Create, at time.Time) (Conversation, error) {
	if err := actor.Validate(); err != nil {
		return Conversation{}, err
	}
	if err := command.Validate(); err != nil {
		return Conversation{}, err
	}
	if !ValidID(id) || at.IsZero() {
		return Conversation{}, ErrInvalid
	}
	var project *string
	if command.ProjectID != nil {
		value := *command.ProjectID
		project = &value
	}
	return Conversation{ID: id, OwnerID: actor.OwnerID, Kind: command.Kind, ProjectID: project, HFProjectID: command.HFProjectID, Title: command.Title, Revision: 1, NextMessageSequence: 1, CreatedAt: at.UTC(), UpdatedAt: at.UTC()}, nil
}

// SoftDelete preserves history and Router references; deleted roots cannot reopen.
func (c *Conversation) SoftDelete(expected int64, at time.Time) error {
	if c.DeletedAt != nil {
		return ErrConversationNotFound
	}
	if expected != c.Revision {
		return &VersionConflict{Current: c.Revision}
	}
	if c.Revision < 1 || c.Revision == math.MaxInt64 || at.IsZero() {
		return ErrInvalid
	}
	at = at.UTC()
	c.Revision++
	c.UpdatedAt = at
	c.DeletedAt = &at
	return nil
}

type PageQuery struct {
	Page, Size int
	Keyword    string
}

func (q PageQuery) Validate() error {
	if q.Page < 1 || q.Page > 100000 || q.Size < 1 || q.Size > 100 || !utf8.ValidString(q.Keyword) || utf8.RuneCountInString(q.Keyword) > 300 {
		return ErrInvalid
	}
	return nil
}
func (q PageQuery) Offset() int64 { return int64(q.Page-1) * int64(q.Size) }

type ConversationQuery struct {
	PageQuery
	Kind        *Kind
	ProjectID   *string
	HFProjectID *string
}

func (q ConversationQuery) Validate() error {
	if err := q.PageQuery.Validate(); err != nil {
		return err
	}
	if q.ProjectID != nil && !ValidID(*q.ProjectID) || q.HFProjectID != nil && !ValidID(*q.HFProjectID) {
		return ErrInvalid
	}
	if q.ProjectID != nil && q.HFProjectID != nil {
		return ErrInvalid
	}
	if q.Kind != nil {
		switch *q.Kind {
		case Global:
			if q.ProjectID != nil || q.HFProjectID != nil {
				return ErrInvalid
			}
		case Canvas:
			if q.HFProjectID != nil {
				return ErrInvalid
			}
		case HF:
			if q.ProjectID != nil {
				return ErrInvalid
			}
			return nil
		default:
			return ErrInvalid
		}
	}
	if q.HFProjectID != nil {
		return nil
	}
	return nil
}

type Page[T any] struct {
	Records    []T
	Page, Size int
	Total      int64
	HasNext    bool
}

func NewPage[T any](q PageQuery, records []T, total int64) Page[T] {
	if records == nil {
		records = []T{}
	}
	return Page[T]{Records: records, Page: q.Page, Size: q.Size, Total: total, HasNext: int64(q.Page)*int64(q.Size) < total}
}
