package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestDeleteRevisionAndIrreversibleVisibility(t *testing.T) {
	project := "project-a"
	c, err := NewConversation("conversation-a", VerifiedActor{OwnerID: "owner-a"}, Create{Kind: Canvas, ProjectID: &project, Title: ""}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var conflict *VersionConflict
	if err = c.SoftDelete(2, time.Now()); !errors.As(err, &conflict) || conflict.Current != 1 || c.DeletedAt != nil {
		t.Fatal("conflict must not mutate root")
	}
	if err = c.SoftDelete(1, time.Now()); err != nil || c.Revision != 2 || c.DeletedAt == nil {
		t.Fatal("delete must advance revision")
	}
	if !errors.Is(c.SoftDelete(2, time.Now()), ErrConversationNotFound) {
		t.Fatal("deleted root remained usable")
	}
}

func TestCreateBoundaries(t *testing.T) {
	p := "project-a"
	for _, input := range []Create{{Kind: Canvas}, {Kind: Global, ProjectID: &p}, {Kind: Global, HFProjectID: &p}, {Kind: Canvas, ProjectID: &p, HFProjectID: &p}, {Kind: HF, ProjectID: &p}, {Kind: "UNKNOWN"}, {Kind: Canvas, ProjectID: &p, Title: strings.Repeat("狐", 121)}} {
		if !errors.Is(input.Validate(), ErrInvalid) {
			t.Fatalf("expected invalid input: %+v", input)
		}
	}
	if err := (Create{Kind: HF}).Validate(); err != nil {
		t.Fatal("unbound private HF creation rejected", err)
	}
	if err := (Create{Kind: Canvas, ProjectID: &p, Title: strings.Repeat("狐", 120)}).Validate(); err != nil {
		t.Fatal("length is Unicode characters, not bytes")
	}
}

func TestGlobalConversationAndKindFilterBoundaries(t *testing.T) {
	c, err := NewConversation("homepage-a", VerifiedActor{OwnerID: "owner-a"}, Create{Kind: Global, Title: "首页会话"}, time.Now())
	if err != nil || c.Kind != Global || c.ProjectID != nil || c.OwnerID != "owner-a" {
		t.Fatalf("global root has false binding: %+v %v", c, err)
	}
	p := "project-a"
	global, canvas, hf, unknown, blank := Global, Canvas, HF, Kind("UNKNOWN"), Kind("")
	page := PageQuery{Page: 1, Size: 20}
	for _, q := range []ConversationQuery{{PageQuery: page, Kind: &global, ProjectID: &p}, {PageQuery: page, Kind: &global, HFProjectID: &p}, {PageQuery: page, Kind: &canvas, HFProjectID: &p}, {PageQuery: page, Kind: &hf, ProjectID: &p}, {PageQuery: page, Kind: &unknown}, {PageQuery: page, Kind: &blank}} {
		if !errors.Is(q.Validate(), ErrInvalid) {
			t.Fatalf("invalid filter accepted: %+v", q)
		}
	}
	if err := (ConversationQuery{PageQuery: page, Kind: &hf}).Validate(); err != nil {
		t.Fatal("HF kind filter rejected", err)
	}
	for _, q := range []ConversationQuery{{PageQuery: page}, {PageQuery: page, Kind: &global}, {PageQuery: page, Kind: &canvas}, {PageQuery: page, ProjectID: &p}} {
		if err = q.Validate(); err != nil {
			t.Fatalf("valid list rejected: %v", err)
		}
	}
}

func TestMessagePartsContractShapes(t *testing.T) {
	valid := []string{`[]`, `[{"type":"TEXT","text":""}]`, `[{"type":"ASSET","assetId":"image-a"},{"type":"STRUCTURED","schemaCode":"schema.v1","value":{"n":9007199254740993}}]`}
	for _, raw := range valid {
		if err := ValidateParts(json.RawMessage(raw)); err != nil {
			t.Fatalf("valid parts rejected: %s", raw)
		}
	}
	invalid := []string{`null`, `{}`, `[null]`, `[{"type":"TEXT","text":null}]`, `[{"type":"TEXT","text":"a","assetId":"x"}]`, `[{"type":"ASSET","assetId":""}]`, `[{"type":"STRUCTURED","schemaCode":"s","value":[]}]`, `[{"type":"STRUCTURED","schemaCode":"s","value":null}]`, `[{"type":"TASK_RESULT","taskId":"fake"}]`}
	for _, raw := range invalid {
		if ValidateParts(json.RawMessage(raw)) == nil {
			t.Fatalf("invalid parts accepted: %s", raw)
		}
	}
}
