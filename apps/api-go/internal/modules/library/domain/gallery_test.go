package domain_test

import (
	"errors"
	"studiotv.local/service/api/internal/modules/library/domain"
	"testing"
	"time"
)

func TestGalleryOwnershipCopyVersionAndDeletion(t *testing.T) {
	now := time.Now()
	main := "image-a"
	c := domain.Input{Title: "角色", Description: "本人作品", Kind: domain.Role, AssetIDs: []string{main}, MainAssetID: &main}
	g, e := domain.NewGallery("gallery", domain.VerifiedActor{OwnerID: "owner"}, c, now)
	if e != nil {
		t.Fatal(e)
	}
	c.AssetIDs[0] = "mutated"
	main = "mutated"
	if g.AssetIDs[0] != "image-a" || *g.MainAssetID != "image-a" {
		t.Fatal("mutable command aliases aggregate")
	}
	next := g.Input
	next.Title = "changed"
	if e = g.Replace(next, 2, now); e == nil {
		t.Fatal("stale write accepted")
	}
	if g.Revision != 1 || g.Title != "角色" {
		t.Fatal("conflict mutated aggregate")
	}
	next.Kind = domain.Scene
	if !errors.Is(g.Replace(next, 1, now), domain.ErrInvalid) {
		t.Fatal("kind changed")
	}
	next.Kind = domain.Role
	if e = g.Replace(next, 1, now.Add(time.Second)); e != nil || g.Revision != 2 {
		t.Fatal("replace failed")
	}
	if e = g.SoftDelete(2, now.Add(2*time.Second)); e != nil || g.Revision != 3 || g.DeletedAt == nil {
		t.Fatal("delete failed")
	}
	if !errors.Is(g.Replace(next, 3, now), domain.ErrNotFound) {
		t.Fatal("deleted root reopened")
	}
}
func TestGalleryInputRejectsInvalidMediaAndActor(t *testing.T) {
	valid := domain.Input{Title: "x", Kind: domain.Scene, AssetIDs: []string{}}
	for _, c := range []domain.Input{{Title: " ", Kind: domain.Scene, AssetIDs: []string{}}, {Title: "x", Kind: "PUBLIC", AssetIDs: []string{}}, {Title: "x", Kind: domain.Role}, {Title: "x", Kind: domain.Role, AssetIDs: []string{"a", "a"}}, {Title: "x", Kind: domain.Role, AssetIDs: []string{""}}} {
		if c.Validate() == nil {
			t.Fatalf("invalid input accepted: %+v", c)
		}
	}
	main := "not-present"
	valid.MainAssetID = &main
	if valid.Validate() == nil {
		t.Fatal("main image outside gallery accepted")
	}
	valid.MainAssetID = nil
	if _, e := domain.NewGallery("x", domain.VerifiedActor{}, valid, time.Now()); !errors.Is(e, domain.ErrUnauthenticated) {
		t.Fatal("unverified actor accepted")
	}
}
func TestGalleryPageEmptyAndBoundaries(t *testing.T) {
	q := domain.Query{Page: 3, Size: 2}
	p := domain.NewPage(q, nil, 5)
	if p.Pages != 3 || p.HasNext || p.Records == nil {
		t.Fatal("page arithmetic wrong")
	}
	p = domain.NewPage(q, nil, 0)
	if p.Pages != 0 || p.Total != 0 || p.HasNext {
		t.Fatal("empty library page wrong")
	}
	for _, q := range []domain.Query{{Page: 0, Size: 20}, {Page: 1, Size: 101}, {Page: 100001, Size: 1}} {
		if q.Validate() == nil {
			t.Fatal("unbounded page accepted")
		}
	}
}
