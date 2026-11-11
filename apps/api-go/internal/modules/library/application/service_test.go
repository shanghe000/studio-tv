package application_test

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"studiotv.local/service/api/internal/modules/library/testkit"
	"sync"
	"testing"
)

func command(title, key string) application.CreateCommand {
	hash, _ := application.CreationHash(map[string]any{"title": title, "description": "", "kind": "ROLE", "assetIds": []any{}})
	return application.CreateCommand{Input: domain.Input{Title: title, Kind: domain.Role, AssetIDs: []string{}}, IdempotencyKey: key, RequestHash: hash}
}
func TestCreationAtomicIdempotencyAndIsolation(t *testing.T) {
	ctx := context.Background()
	f := testkit.New()
	s, _ := application.New(f)
	a := domain.VerifiedActor{OwnerID: "a"}
	key := uuid.NewString()
	var ids [8]string
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			g, e := s.Create(ctx, a, command("title", key))
			if e != nil {
				t.Error(e)
			}
			ids[i] = g.ID
		}(i)
	}
	wg.Wait()
	for _, id := range ids {
		if id != ids[0] {
			t.Fatal("replay changed identity")
		}
	}
	if len(f.Roots) != 1 || len(f.Receipts) != 1 || f.CollectionRevision["a"] != 2 {
		t.Fatal("creation not singular")
	}
	if _, e := s.Create(ctx, a, command("other", key)); !errors.Is(e, domain.ErrIdempotencyConflict) {
		t.Fatal("hash conflict accepted")
	}
	if _, e := s.Get(ctx, domain.VerifiedActor{OwnerID: "b"}, ids[0]); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("cross-owner read")
	}
	if _, e := s.Delete(ctx, a, ids[0], 1); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Create(ctx, a, command("title", key)); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("replay resurrected deleted root")
	}
	f.FailSave = true
	if _, e := s.Create(ctx, a, command("rollback", uuid.NewString())); !errors.Is(e, domain.ErrUnavailable) {
		t.Fatal("missing write failure")
	}
	if len(f.Roots) != 1 || len(f.Receipts) != 1 {
		t.Fatal("failed transaction left root or receipt")
	}
}
func TestMediaAuthorizationAndProjectionBatching(t *testing.T) {
	ctx := context.Background()
	f := testkit.New()
	f.Assets["ok"] = testkit.Asset{Owner: "a", Kind: "IMAGE", State: "READY"}
	f.Assets["foreign"] = testkit.Asset{Owner: "b", Kind: "IMAGE", State: "READY"}
	f.Assets["pending"] = testkit.Asset{Owner: "a", Kind: "IMAGE", State: "UPLOADING"}
	f.Assets["video"] = testkit.Asset{Owner: "a", Kind: "VIDEO", State: "READY"}
	s, _ := application.New(f)
	a := domain.VerifiedActor{OwnerID: "a"}
	for _, id := range []string{"foreign", "pending", "video", "missing"} {
		c := command(id, uuid.NewString())
		c.Input.AssetIDs = []string{id}
		if _, e := s.Create(ctx, a, c); !errors.Is(e, domain.ErrAssetNotFound) {
			t.Fatal("invalid asset accepted", id)
		}
	}
	main := "ok"
	c := command("kept", uuid.NewString())
	c.Input.AssetIDs = []string{main}
	c.Input.MainAssetID = &main
	g, e := s.Create(ctx, a, c)
	if e != nil {
		t.Fatal(e)
	}
	c = command("another", uuid.NewString())
	c.Input.AssetIDs = []string{"ok"}
	if _, e = s.Create(ctx, a, c); e != nil {
		t.Fatal(e)
	}
	queries := f.AssetQueries
	p, e := s.List(ctx, a, domain.Query{Page: 1, Size: 20})
	if e != nil || len(p.Records) != 2 || f.AssetQueries != queries+1 {
		t.Fatal("list media authorization was not batched")
	}
	v := f.Assets["ok"]
	v.Deleted = true
	f.Assets["ok"] = v
	g, e = s.Get(ctx, a, g.ID)
	if e != nil || len(g.AssetIDs) != 0 || g.MainAssetID != nil {
		t.Fatal("deleted media leaked in projection")
	}
	if len(f.Roots[g.ID].AssetIDs) != 1 {
		t.Fatal("read filtering changed stored history")
	}
}
func TestUpdateConflictPreventsWritesAndCanonicalHash(t *testing.T) {
	ctx := context.Background()
	f := testkit.New()
	s, _ := application.New(f)
	a := domain.VerifiedActor{OwnerID: "a"}
	g, _ := s.Create(ctx, a, command("first", uuid.NewString()))
	input := g.Input
	input.Title = "second"
	updated, e := s.Update(ctx, a, g.ID, input, 1)
	if e != nil || updated.Revision != 2 {
		t.Fatal("update failed")
	}
	input.Title = "third"
	if _, e = s.Update(ctx, a, g.ID, input, 1); e == nil {
		t.Fatal("stale update accepted")
	}
	if f.Roots[g.ID].Title != "second" || f.CollectionRevision["a"] != 3 {
		t.Fatal("conflict changed state")
	}
	one, _ := application.CreationHash(map[string]any{"b": "<x>", "a": "狐"})
	two, _ := application.CreationHash(map[string]any{"a": "狐", "b": "<x>"})
	if one != two {
		t.Fatal("field ordering changed hash")
	}
	calls := f.Calls
	if _, e = s.Create(ctx, domain.VerifiedActor{}, command("unauth", uuid.NewString())); !errors.Is(e, domain.ErrUnauthenticated) || f.Calls != calls {
		t.Fatal("invalid actor reached repository")
	}
}
