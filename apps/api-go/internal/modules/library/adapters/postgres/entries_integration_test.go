package postgres_test

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/library/adapters/postgres"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"testing"
)

func entryCommand(t *testing.T, rev int64, body any) application.EntryMutation {
	t.Helper()
	raw, e := json.Marshal(body)
	if e != nil {
		t.Fatal(e)
	}
	var object map[string]any
	_ = json.Unmarshal(raw, &object)
	hash, e := application.CreationHash(object)
	if e != nil {
		t.Fatal(e)
	}
	return application.EntryMutation{Expected: rev, Key: uuid.NewString(), Hash: hash}
}
func TestFoldersNodesAtomicMoveDeleteAndReadyMedia(t *testing.T) {
	db, ctx := migrated(t)
	owner, other, image, foreign := seed(t, db, ctx)
	a, b := domain.VerifiedActor{OwnerID: owner}, domain.VerifiedActor{OwnerID: other}
	repo, e := postgres.NewEntries(db)
	if e != nil {
		t.Fatal(e)
	}
	rootIn := domain.FolderInput{Name: "root", CategoryCode: "USER_OTHER", Kind: "MIXED"}
	root, e := repo.CreateFolder(ctx, a, rootIn, entryCommand(t, 0, rootIn))
	if e != nil {
		t.Fatal(e)
	}
	childIn := domain.FolderInput{Name: "child", CategoryCode: "USER_OTHER", ParentID: &root.ID}
	child, e := repo.CreateFolder(ctx, a, childIn, entryCommand(t, 0, childIn))
	if e != nil {
		t.Fatal(e)
	}
	state, e := repo.State(ctx, a)
	if e != nil {
		t.Fatal(e)
	}
	nodeIn := domain.NodeInput{Name: "stored node", Kind: "IMAGE", CategoryCode: "USER_OTHER", FolderID: &child.ID, ItemType: "NODE", Content: domain.NodeContent{NodeType: "rh-image", NodeContent: json.RawMessage(`{"id":"original","data":{"url":"rhtv-asset:` + image + `","params":{"prompt":"kept"}}}`), AssetIDs: []string{image}}, ThumbnailAssetID: &image}
	batch := domain.BatchCreate{Items: []domain.NodeInput{nodeIn}, ExpectedCollectionRevision: state}
	key := entryCommand(t, 0, batch)
	created, e := repo.BatchCreate(ctx, a, batch, key)
	if e != nil || len(created.Items) != 1 {
		t.Fatal(e)
	}
	replayed, e := repo.BatchCreate(ctx, a, batch, key)
	if e != nil || replayed.Items[0].ID != created.Items[0].ID {
		t.Fatal("duplicate batch", e)
	}
	id := created.Items[0].ID
	if _, e = repo.Node(ctx, b, id); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign node", e)
	}
	bad := nodeIn
	bad.Content.AssetIDs = []string{foreign}
	bad.Content.NodeContent = json.RawMessage(`{"data":{"url":"rhtv-asset:` + foreign + `"}}`)
	if _, e = repo.UpdateNode(ctx, a, id, bad, application.EntryMutation{Expected: 1}); !errors.Is(e, domain.ErrAssetNotFound) {
		t.Fatal("foreign ref accepted", e)
	}
	page, e := repo.Entries(ctx, a, domain.EntryQuery{Page: 9, Size: 1, Recursive: true})
	if e != nil || page.Total != 3 || len(page.Records) != 0 {
		t.Fatal("union total", page, e)
	}
	for kind, want := range map[string]int64{"ITEM": 1, "GROUP": 2} {
		filtered, e := repo.Entries(ctx, a, domain.EntryQuery{Page: 1, Size: 100, Recursive: true, NodeKind: kind})
		if e != nil || filtered.Total != want || int64(len(filtered.Records)) != want {
			t.Fatalf("native nodeKind=%s total=%d want%d err%v", kind, filtered.Total, want, e)
		}
	}
	loop := domain.BatchMutation{FolderIDs: []string{root.ID}, ExpectedCollectionRevision: created.Revision, TargetCategoryCode: "USER_OTHER", TargetFolderID: &child.ID}
	if _, e = repo.BatchMutate(ctx, a, loop, true, entryCommand(t, 0, loop)); !errors.Is(e, domain.ErrInvalid) {
		t.Fatal("parent cycle", e)
	}
	state, e = repo.State(ctx, a)
	if e != nil || state != created.Revision {
		t.Fatal("failed move committed")
	}
	patch := domain.FolderPatch{ThumbnailAssetIDs: []string{image}}
	if _, e = repo.UpdateFolder(ctx, a, root.ID, patch, application.EntryMutation{Expected: root.Revision}); e != nil {
		t.Fatal(e)
	}
	state, _ = repo.State(ctx, a)
	del := domain.BatchMutation{FolderIDs: []string{root.ID}, ExpectedCollectionRevision: state}
	done, e := repo.BatchMutate(ctx, a, del, false, entryCommand(t, 0, del))
	if e != nil || len(done.ChangedIDs) != 3 {
		t.Fatal("subtree delete", done, e)
	}
	if _, e = repo.Node(ctx, a, id); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("deleted parent node exposed", e)
	}
	if _, e = repo.Folder(ctx, a, child.ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("deleted child exposed", e)
	}
	var active bool
	if e = db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM resources.active_asset_references WHERE asset_id=$1 AND owner_id=$2)", image, owner).Scan(&active); e != nil || active {
		t.Fatal("deleted refs active", e)
	}
	restarted, _ := postgres.NewEntries(db)
	page, e = restarted.Entries(ctx, a, domain.EntryQuery{Page: 1, Size: 100, Recursive: true})
	if e != nil || page.Total != 0 {
		t.Fatal("deletion not durable")
	}
}
