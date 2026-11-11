package domain_test

import (
	"encoding/json"
	"studiotv.local/service/api/internal/modules/library/domain"
	"testing"
)

func TestNodeReferencesAreCompleteAndBounded(t *testing.T) {
	i := domain.NodeInput{Name: "node", Kind: "IMAGE", CategoryCode: "USER_OTHER", ItemType: "NODE", Content: domain.NodeContent{NodeType: "rh-image", NodeContent: json.RawMessage(`{"data":{"url":"rhtv-asset:image"}}`), AssetIDs: []string{"image"}}}
	if e := i.Validate(); e != nil {
		t.Fatal(e)
	}
	i.Content.AssetIDs = nil
	if i.Validate() == nil {
		t.Fatal("unlisted embedded reference")
	}
	i.Content.AssetIDs = []string{"image", "unused"}
	if i.Validate() == nil {
		t.Fatal("unauthoritative extra asset")
	}
	i.Content.AssetIDs = []string{"image"}
	i.Content.NodeContent = json.RawMessage(`{"data":{"url":"https://evil/image"}}`)
	if i.Validate() == nil {
		t.Fatal("URL accepted")
	}
	if (domain.FolderInput{Name: "x", CategoryCode: "ALL"}).Validate() == nil {
		t.Fatal("synthetic ALL category persisted")
	}
}
func TestBatchDuplicateAndMoveValidation(t *testing.T) {
	b := domain.BatchMutation{ItemIDs: []string{"x"}, FolderIDs: []string{"x"}, ExpectedCollectionRevision: 1, TargetCategoryCode: "USER_OTHER"}
	if b.Validate(true) == nil {
		t.Fatal("duplicated root")
	}
	b.FolderIDs = nil
	if b.Validate(true) != nil {
		t.Fatal("valid move")
	}
	if b.Validate(false) == nil {
		t.Fatal("delete with move fields")
	}
}
