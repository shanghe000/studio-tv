package stylecatalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	resourcePG "studiotv.local/service/api/internal/modules/resources/adapters/postgres"
	resourceDomain "studiotv.local/service/api/internal/modules/resources/domain"
	"testing"
)

func TestPostgresImageRecipeImportIsIdempotentAndKeepsLegacyStyleVersion(t *testing.T) {
	ctx, pool, catalog := fixture(t)
	for i := 0; i < 2; i++ {
		if err := catalog.Import(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM resources.items WHERE source_version='studio-image-recipes-1'").Scan(&count); err != nil || count != 189 {
		t.Fatal(count, err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM resources.categories WHERE source_version='studio-image-recipes-1' AND context @> '{\"menuType\":\"role_design\",\"scope\":\"IMAGE\"}'").Scan(&count); err != nil || count != 6 {
		t.Fatal(count, err)
	}
	for _, def := range catalog.seed.Styles {
		got, err := catalog.Definition(ctx, "owner", def.ID)
		if err != nil || got != def {
			t.Fatal("legacy style changed", err)
		}
	}
	// Collision/tampering cannot be silently overwritten on restart.
	if _, err := pool.Exec(ctx, "UPDATE resources.items SET revision=revision+1,content=jsonb_set(content,'{prefixPrompt}','\"changed\"') WHERE id='studio-role-basic-woman-v1'"); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Import(ctx); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("changed recipe accepted", err)
	}
}

func TestPostgresImageRecipeOwnerIsolationRevisionAndDeletion(t *testing.T) {
	ctx, pool, catalog := fixture(t)
	if _, err := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('recipe-owner','recipe@example.test','Recipe owner'),('recipe-other','other-recipe@example.test','Other')`); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"PROMPT", "STYLE"} {
		raw, _ := json.Marshal(map[string]any{"prefixPrompt": "Soft light", "suffixPrompt": "Preserve details", "promptType": kind, "mediaScope": "IMAGE"})
		id := "own-" + kind
		if _, err := pool.Exec(ctx, `INSERT INTO resources.items(id,family,scope,owner_id,name,content,revision) VALUES($1,'PROMPT','USER','recipe-owner','Owned recipe',$2,3)`, id, raw); err != nil {
			t.Fatal(err)
		}
		got, err := catalog.Definition(ctx, "recipe-owner", id)
		key := "customPrompt"
		if kind == "STYLE" {
			key = "styleLibrary"
		}
		want := application.StyleDefinition{SchemaVersion: "1", SourceScope: "USER", Revision: 3, ID: id, Key: key, Label: "Owned recipe", Prompt: "Soft light\nPreserve details", PrefixPrompt: "Soft light", SuffixPrompt: "Preserve details", PromptType: kind}
		if kind == "STYLE" {
			want.Prompt = "Soft light"
		}
		if err != nil || got != want {
			t.Fatal(got, err)
		}
		if _, err = catalog.Definition(ctx, "recipe-other", id); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("foreign recipe visible", err)
		}
		if _, err = catalog.Definition(ctx, "", id); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("anonymous recipe visible", err)
		}
		if _, err = pool.Exec(ctx, "UPDATE resources.items SET revision=revision+1,deleted_at=now() WHERE id=$1", id); err != nil {
			t.Fatal(err)
		}
		if _, err = catalog.Definition(ctx, "recipe-owner", id); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("deleted recipe visible", err)
		}
	}
}

func TestPostgresImageRecipeNativePresetCategoriesAndCompleteStylePage(t *testing.T) {
	ctx, pool, catalog := fixture(t)
	for i := 0; i < 2; i++ {
		if err := catalog.Import(ctx); err != nil {
			t.Fatal(err)
		}
	}
	repo, err := resourcePG.New(pool)
	if err != nil {
		t.Fatal(err)
	}
	categories, err := repo.Categories(ctx, "PROMPT", map[string]string{"scope": "IMAGE"})
	if err != nil || len(categories) != 4 {
		t.Fatalf("general picker got %d roots: %v", len(categories), err)
	}
	var styles presetCategory
	for _, raw := range categories {
		var cat presetCategory
		if err := json.Unmarshal(raw, &cat); err != nil {
			t.Fatal(err)
		}
		if cat.Name == "风格库" {
			styles = cat
		}
	}
	if len(styles.Children) != 2 {
		t.Fatal("native style tree has no real leaf IDs", styles)
	}
	ids := []string{}
	for _, child := range styles.Children {
		ids = append(ids, fmt.Sprint(child.ID))
	}
	page, err := repo.List(ctx, resourceDomain.Actor{OwnerID: "viewer"}, resourceDomain.Prompt, resourceDomain.Query{Scope: "SYSTEM", Page: 1, Size: 20, CategoryIDs: ids})
	if err != nil || page.Total != 4 || len(page.Records) != 4 {
		t.Fatalf("native all-style page: %#v %v", page, err)
	}
	seen := map[string]bool{}
	for _, row := range page.Records {
		seen[row.ID] = true
	}
	for _, def := range catalog.seed.Styles {
		if !seen[def.ID] {
			t.Fatal("missing style", def.ID)
		}
		got, err := catalog.Definition(ctx, "viewer", def.ID)
		if err != nil || got != def {
			t.Fatal("style identity changed", err)
		}
	}
	for _, id := range []string{"930002", "930003", "930004"} {
		page, err := repo.List(ctx, resourceDomain.Actor{OwnerID: "viewer"}, resourceDomain.Prompt, resourceDomain.Query{Scope: "SYSTEM", Page: 1, Size: 20, CategoryIDs: []string{id}})
		if err != nil || page.Total != 3 {
			t.Fatal("missing public preset group", id, page.Total, err)
		}
	}
	role, err := repo.Categories(ctx, "PROMPT", map[string]string{"scope": "IMAGE", "menuType": "role_design"})
	if err != nil || len(role) != 6 {
		t.Fatal("role menu lost", len(role), err)
	}
	portrait, err := repo.Categories(ctx, "PROMPT", map[string]string{"scope": "IMAGE", "menuType": "portrait"})
	if err != nil || len(portrait) == 0 {
		t.Fatal("portrait menu lost", err)
	}
}
