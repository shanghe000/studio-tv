package domain

import (
	"strings"
	"testing"
)

func TestOwnerAndBoundedOrganizationInputs(t *testing.T) {
	if (Actor{}).Validate() != ErrUnauthenticated || (Actor{OwnerID: "verified_1"}).Validate() != nil {
		t.Fatal("actor validation")
	}
	for _, q := range []Query{{Page: 0, Size: 20}, {Page: 1, Size: 101}, {Page: 1, Size: 20, Scope: "TEAM"}, {Page: 1, Size: 20, Sort: "UPSTREAM"}, {Page: 1, Size: 20, Keyword: "line\ncontrol"}} {
		if q.Validate() == nil {
			t.Fatal("invalid query accepted", q)
		}
	}
	for _, sort := range []string{"UPDATED_ASC", "UPDATED_DESC", "CREATED_ASC", "CREATED_DESC", "NAME_ASC", "NAME_DESC", "SIZE_ASC", "SIZE_DESC"} {
		if (Query{Page: 1, Size: 100, Sort: sort, Scope: "CANVAS"}).Validate() != nil {
			t.Fatal(sort)
		}
	}
	if (FolderInput{Name: strings.Repeat("狐", 100)}).Validate() != nil || (FolderInput{Name: strings.Repeat("狐", 101)}).Validate() == nil {
		t.Fatal("folder Unicode bound")
	}
	for _, ids := range [][]string{nil, {"a", "a"}, {"../a"}, make([]string, 101)} {
		if IDs(ids) {
			t.Fatal("invalid ID set accepted")
		}
	}
	p := NewPage(Query{Page: 10, Size: 20}, []Entry{}, 21, 8)
	if p.Total != 21 || p.Pages != 2 || p.HasNext || p.Records == nil {
		t.Fatal("empty page lost metadata")
	}
}
