// Package testkit supplies a rollback-capable in-memory fixture for use-case and
// transport tests. It makes no claim to test PostgreSQL locks or constraints.
package testkit

import (
	"context"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"sort"
	"strings"
	"sync"
)

type Asset struct {
	Owner, Kind, State string
	Deleted            bool
}
type Fixture struct {
	mu                  sync.Mutex
	Roots               map[string]domain.Gallery
	Receipts            map[string]application.Receipt
	Assets              map[string]Asset
	CollectionRevision  map[string]int64
	Calls, AssetQueries int
	FailSave            bool
}

func New() *Fixture {
	return &Fixture{Roots: map[string]domain.Gallery{}, Receipts: map[string]application.Receipt{}, Assets: map[string]Asset{}, CollectionRevision: map[string]int64{}}
}
func clone[T any](values map[string]T) map[string]T {
	copy := map[string]T{}
	for k, v := range values {
		copy[k] = v
	}
	return copy
}
func (f *Fixture) Within(_ context.Context, fn func(application.Repositories) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls++
	roots, receipts, revision := clone(f.Roots), clone(f.Receipts), clone(f.CollectionRevision)
	e := fn(f)
	if e != nil {
		f.Roots, f.Receipts, f.CollectionRevision = roots, receipts, revision
	}
	return e
}
func (f *Fixture) LockCollection(_ context.Context, owner string) error {
	if f.CollectionRevision[owner] == 0 {
		f.CollectionRevision[owner] = 1
	}
	return nil
}
func (f *Fixture) AdvanceCollection(_ context.Context, owner string) error {
	f.CollectionRevision[owner]++
	return nil
}
func (*Fixture) LockIdempotency(context.Context, string, string, string) error { return nil }
func (f *Fixture) FindReceipt(_ context.Context, owner, op, key string) (*application.Receipt, error) {
	v, ok := f.Receipts[owner+op+key]
	if !ok {
		return nil, nil
	}
	return &v, nil
}
func (f *Fixture) SaveReceipt(_ context.Context, owner, op, key string, v application.Receipt) error {
	if f.FailSave {
		return domain.ErrUnavailable
	}
	f.Receipts[owner+op+key] = v
	return nil
}
func (f *Fixture) VisibleAssets(_ context.Context, owner string, ids []string, _ bool) ([]string, error) {
	f.AssetQueries++
	visible := []string{}
	for _, id := range ids {
		v, ok := f.Assets[id]
		if ok && v.Owner == owner && v.Kind == "IMAGE" && v.State == "READY" && !v.Deleted {
			visible = append(visible, id)
		}
	}
	return visible, nil
}
func (f *Fixture) CreateGallery(_ context.Context, g domain.Gallery) error {
	f.Roots[g.ID] = g
	return nil
}
func (f *Fixture) Gallery(_ context.Context, owner, id string, _ bool) (domain.Gallery, error) {
	g, ok := f.Roots[id]
	if !ok || g.OwnerID != owner || g.DeletedAt != nil {
		return domain.Gallery{}, domain.ErrNotFound
	}
	return g, nil
}
func (f *Fixture) SaveGallery(_ context.Context, g domain.Gallery, _ int64) error {
	if f.FailSave {
		return domain.ErrUnavailable
	}
	f.Roots[g.ID] = g
	return nil
}
func (f *Fixture) Galleries(_ context.Context, owner string, q domain.Query) (domain.Page, error) {
	roots := []domain.Gallery{}
	for _, g := range f.Roots {
		if g.OwnerID == owner && g.DeletedAt == nil && (q.Kind == nil || g.Kind == *q.Kind) && strings.Contains(strings.ToLower(g.Title+" "+g.Description), strings.ToLower(q.Keyword)) {
			roots = append(roots, g)
		}
	}
	sort.Slice(roots, func(i, j int) bool {
		if roots[i].UpdatedAt.Equal(roots[j].UpdatedAt) {
			return roots[i].ID < roots[j].ID
		}
		return roots[i].UpdatedAt.After(roots[j].UpdatedAt)
	})
	total := int64(len(roots))
	start := q.Offset()
	if start >= total {
		roots = []domain.Gallery{}
	} else {
		roots = roots[start:min(start+int64(q.Size), total)]
	}
	return domain.NewPage(q, roots, total), nil
}
