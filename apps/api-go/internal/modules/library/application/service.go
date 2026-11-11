// Package application owns transactions and image authorization for private galleries.
package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/library/domain"
	"strings"
	"time"
)

const CreateOperation = "libraryCreateItem"

type Receipt struct {
	RequestHash string
	Gallery     domain.Gallery
}

// Every repository instance belongs to one transaction. READY images are checked
// under a SHARE lock before writes; reads hide unavailable references.
type Repositories interface {
	LockCollection(context.Context, string) error
	AdvanceCollection(context.Context, string) error
	LockIdempotency(context.Context, string, string, string) error
	FindReceipt(context.Context, string, string, string) (*Receipt, error)
	SaveReceipt(context.Context, string, string, string, Receipt) error
	VisibleAssets(context.Context, string, []string, bool) ([]string, error)
	CreateGallery(context.Context, domain.Gallery) error
	Gallery(context.Context, string, string, bool) (domain.Gallery, error)
	SaveGallery(context.Context, domain.Gallery, int64) error
	Galleries(context.Context, string, domain.Query) (domain.Page, error)
}
type UnitOfWork interface {
	Within(context.Context, func(Repositories) error) error
}
type Service struct {
	uow   UnitOfWork
	now   func() time.Time
	newID func() string
}

func New(uow UnitOfWork) (*Service, error) {
	if uow == nil {
		return nil, errors.New("library unit of work is required")
	}
	return &Service{uow: uow, now: time.Now, newID: func() string { return "lib_" + strings.ReplaceAll(uuid.NewString(), "-", "") }}, nil
}
func NormalizeKey(key string) (string, error) {
	v, e := uuid.Parse(key)
	if e != nil || len(key) != 36 || strings.ToLower(key) != v.String() {
		return "", domain.ErrInvalid
	}
	return v.String(), nil
}
func CreationHash(body map[string]any) (string, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if e := enc.Encode(map[string]any{"body": body, "params": map[string]any{}, "team": nil}); e != nil {
		return "", e
	}
	v := sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
	return hex.EncodeToString(v[:]), nil
}

type CreateCommand struct {
	Input                       domain.Input
	IdempotencyKey, RequestHash string
}

func (s *Service) Create(ctx context.Context, a domain.VerifiedActor, c CreateCommand) (domain.Gallery, error) {
	var result domain.Gallery
	if e := a.Validate(); e != nil {
		return result, e
	}
	if e := c.Input.Validate(); e != nil {
		return result, e
	}
	key, e := NormalizeKey(c.IdempotencyKey)
	if e != nil {
		return result, e
	}
	hash, e := hex.DecodeString(c.RequestHash)
	if e != nil || len(hash) != sha256.Size {
		return result, domain.ErrInvalid
	}
	e = s.uow.Within(ctx, func(tx Repositories) error {
		if e := tx.LockIdempotency(ctx, a.OwnerID, CreateOperation, key); e != nil {
			return e
		}
		receipt, e := tx.FindReceipt(ctx, a.OwnerID, CreateOperation, key)
		if e != nil {
			return e
		}
		if receipt != nil {
			if receipt.RequestHash != c.RequestHash {
				return domain.ErrIdempotencyConflict
			}
			if _, e = tx.Gallery(ctx, a.OwnerID, receipt.Gallery.ID, false); e != nil {
				return e
			}
			result = receipt.Gallery
			return authorizeProjection(ctx, tx, &result)
		}
		if e = tx.LockCollection(ctx, a.OwnerID); e != nil {
			return e
		}
		if e = validateAssets(ctx, tx, a.OwnerID, c.Input.AssetIDs); e != nil {
			return e
		}
		result, e = domain.NewGallery(s.newID(), a, c.Input, s.now())
		if e != nil {
			return e
		}
		if e = tx.CreateGallery(ctx, result); e != nil {
			return e
		}
		if e = tx.AdvanceCollection(ctx, a.OwnerID); e != nil {
			return e
		}
		return tx.SaveReceipt(ctx, a.OwnerID, CreateOperation, key, Receipt{c.RequestHash, result})
	})
	return result, e
}
func (s *Service) Get(ctx context.Context, a domain.VerifiedActor, id string) (domain.Gallery, error) {
	var g domain.Gallery
	if e := a.Validate(); e != nil {
		return g, e
	}
	if !domain.ValidID(id) {
		return g, domain.ErrInvalid
	}
	e := s.uow.Within(ctx, func(tx Repositories) error {
		var e error
		g, e = tx.Gallery(ctx, a.OwnerID, id, false)
		if e != nil {
			return e
		}
		return authorizeProjection(ctx, tx, &g)
	})
	return g, e
}
func (s *Service) List(ctx context.Context, a domain.VerifiedActor, q domain.Query) (domain.Page, error) {
	var p domain.Page
	if e := a.Validate(); e != nil {
		return p, e
	}
	q.Keyword = strings.TrimSpace(q.Keyword)
	if e := q.Validate(); e != nil {
		return p, e
	}
	e := s.uow.Within(ctx, func(tx Repositories) error {
		var e error
		p, e = tx.Galleries(ctx, a.OwnerID, q)
		if e != nil {
			return e
		}
		// Authorize the entire ID page in one repository query. References from
		// multiple galleries do not cause per-image or per-gallery queries.
		ids := []string{}
		seen := map[string]bool{}
		for _, g := range p.Records {
			for _, id := range g.AssetIDs {
				if !seen[id] {
					ids = append(ids, id)
					seen[id] = true
				}
			}
		}
		visible, e := tx.VisibleAssets(ctx, a.OwnerID, ids, false)
		if e != nil {
			return e
		}
		allowed := map[string]bool{}
		for _, id := range visible {
			allowed[id] = true
		}
		for i := range p.Records {
			filterProjection(&p.Records[i], allowed)
		}
		return nil
	})
	return p, e
}
func (s *Service) Update(ctx context.Context, a domain.VerifiedActor, id string, c domain.Input, expected int64) (domain.Gallery, error) {
	var g domain.Gallery
	if e := a.Validate(); e != nil {
		return g, e
	}
	if !domain.ValidID(id) || expected < 1 {
		return g, domain.ErrInvalid
	}
	if e := c.Validate(); e != nil {
		return g, e
	}
	e := s.uow.Within(ctx, func(tx Repositories) error {
		if e := tx.LockCollection(ctx, a.OwnerID); e != nil {
			return e
		}
		var e error
		g, e = tx.Gallery(ctx, a.OwnerID, id, true)
		if e != nil {
			return e
		}
		if e = g.Replace(c, expected, s.now()); e != nil {
			return e
		}
		if e = validateAssets(ctx, tx, a.OwnerID, c.AssetIDs); e != nil {
			return e
		}
		if e = tx.SaveGallery(ctx, g, expected); e != nil {
			return e
		}
		return tx.AdvanceCollection(ctx, a.OwnerID)
	})
	return g, e
}
func (s *Service) Delete(ctx context.Context, a domain.VerifiedActor, id string, expected int64) (int64, error) {
	if e := a.Validate(); e != nil {
		return 0, e
	}
	if !domain.ValidID(id) || expected < 1 {
		return 0, domain.ErrInvalid
	}
	var revision int64
	e := s.uow.Within(ctx, func(tx Repositories) error {
		if e := tx.LockCollection(ctx, a.OwnerID); e != nil {
			return e
		}
		g, e := tx.Gallery(ctx, a.OwnerID, id, true)
		if e != nil {
			return e
		}
		if e = g.SoftDelete(expected, s.now()); e != nil {
			return e
		}
		if e = tx.SaveGallery(ctx, g, expected); e != nil {
			return e
		}
		revision = g.Revision
		return tx.AdvanceCollection(ctx, a.OwnerID)
	})
	return revision, e
}
func validateAssets(ctx context.Context, tx Repositories, owner string, ids []string) error {
	visible, e := tx.VisibleAssets(ctx, owner, ids, true)
	if e != nil {
		return e
	}
	if len(visible) != len(ids) {
		return domain.ErrAssetNotFound
	}
	return nil
}
func authorizeProjection(ctx context.Context, tx Repositories, g *domain.Gallery) error {
	visible, e := tx.VisibleAssets(ctx, g.OwnerID, g.AssetIDs, false)
	if e != nil {
		return e
	}
	allowed := map[string]bool{}
	for _, id := range visible {
		allowed[id] = true
	}
	filterProjection(g, allowed)
	return nil
}
func filterProjection(g *domain.Gallery, allowed map[string]bool) {
	ids := []string{}
	for _, id := range g.AssetIDs {
		if allowed[id] {
			ids = append(ids, id)
		}
	}
	g.AssetIDs = ids
	if g.MainAssetID != nil && !allowed[*g.MainAssetID] {
		g.MainAssetID = nil
	}
}
