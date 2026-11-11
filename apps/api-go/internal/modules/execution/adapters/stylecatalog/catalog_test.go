package stylecatalog

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/execution/domain"
	resourcePG "studiotv.local/service/api/internal/modules/resources/adapters/postgres"
	resource "studiotv.local/service/api/internal/modules/resources/application"
	resourceDomain "studiotv.local/service/api/internal/modules/resources/domain"
	"studiotv.local/service/api/internal/testdb"
)

func TestStyleSeedPreservesFourPublishedStudioOptionsAndAuditsFrozenSource(t *testing.T) {
	var source seed
	if err := strict(seedJSON, &source); err != nil {
		t.Fatal(err)
	}
	if source.Version != "studio-style-library-1" || len(source.Styles) != 4 || source.SourceSHA256 != "25a16354d04d8e5c4760e4607aa48ccb5622dd8cf798c79fe9ddda75e39b5bba" {
		t.Fatal("style seed provenance missing")
	}
	// Where the frozen Web baseline is present, compare every original string
	// to it. API-only test snapshots may omit the immutable compiled bundle.
	path := filepath.Join("..", "..", "..", "..", "..", "..", "web", "public", "project", "assets", "index-DeyN_Phq.js")
	baseline, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	ids := map[string]bool{"cinematic_realism": true, "anime_illustration": true, "product_ad": true, "editorial_fashion": true}
	for _, def := range source.Styles {
		if !ids[def.ID] || def.Key != "styleLibrary" || def.SchemaVersion != "1" || def.Revision != 1 || !strings.HasPrefix(def.CoverURL, "https://assets.example.invalid/styles/") || def.ReferenceImageURL != def.CoverURL {
			t.Fatal("seed changed published style identity")
		}
		delete(ids, def.ID)
		if err == nil && (!strings.Contains(string(baseline), `id:"`+def.ID+`"`) || !strings.Contains(string(baseline), `label:"`+def.Label+`"`) || !strings.Contains(string(baseline), `prompt:"`+def.Prompt+`"`)) {
			t.Fatal("seed does not preserve frozen published style bytes")
		}
	}
	if len(ids) != 0 {
		t.Fatal("seed omitted published styles")
	}
}

func fixture(t *testing.T) (context.Context, *pgxpool.Pool, *Catalog) {
	t.Helper()
	pool := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	catalog, err := New(pool)
	if err != nil {
		t.Fatal(err)
	}
	return ctx, pool, catalog
}

func TestPostgresStyleSeedConcurrentImportRestartLegacyUsageAndTamperRejection(t *testing.T) {
	ctx, pool, catalog := fixture(t)
	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- catalog.Import(ctx) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM resources.items WHERE source_version='studio-style-library-1'").Scan(&count); err != nil || count != 4 {
		t.Fatal("seed not exactly four immutable styles", count, err)
	}
	restarted, err := New(pool)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range catalog.seed.Styles {
		for _, owner := range []string{"actor-a", "actor-b"} {
			actual, err := restarted.Definition(ctx, owner, expected.ID)
			if err != nil || actual != expected {
				t.Fatal("restart lost server style", err)
			}
		}
	}
	if _, err = restarted.Definition(ctx, "actor-a", "unknown"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("unknown style accepted", err)
	}
	if _, err = restarted.Definition(ctx, "", "cinematic_realism"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("unauthenticated read accepted", err)
	}
	if _, err = pool.Exec(ctx, "INSERT INTO public.users(id,email,display_name) VALUES('style-owner','style-owner@example.test','Style owner')"); err != nil {
		t.Fatal(err)
	}
	repo, err := resourcePG.New(pool)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := resource.New(repo)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := svc.Get(ctx, resourceDomain.Actor{OwnerID: "style-owner"}, resourceDomain.Prompt, "cinematic_realism")
	if err != nil || entry.Scope != "SYSTEM" {
		t.Fatal("legacy prompt detail remains missing", err)
	}
	mutation, err := resource.Command(0, "3c5c4b48-78a2-4563-a0fa-e71170be3b89", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Use(ctx, resourceDomain.Actor{OwnerID: "style-owner"}, resourceDomain.Prompt, "cinematic_realism", nil, nil, mutation); err != nil {
		t.Fatal("legacy prompt usage remains missing", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE resources.items SET revision=2,content=jsonb_set(content,'{preset,prompt}','"tampered"') WHERE id='cinematic_realism'`); err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.Definition(ctx, "style-owner", "cinematic_realism"); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("tampered catalog definition accepted", err)
	}
	if err = restarted.Import(ctx); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("startup import overwrote tampered definition", err)
	}
}

func TestPostgresStyleSeedDoesNotOverwriteForeignResourceIdentity(t *testing.T) {
	ctx, pool, catalog := fixture(t)
	if _, err := pool.Exec(ctx, "INSERT INTO public.users(id,email,display_name) VALUES('foreign-owner','foreign-owner@example.test','Foreign owner')"); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"prefixPrompt": "foreign prompt"})
	if _, err := pool.Exec(ctx, `INSERT INTO resources.items(id,family,scope,owner_id,name,content) VALUES('cinematic_realism','PROMPT','USER','foreign-owner','Foreign', $1)`, body); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Import(ctx); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("foreign identity was replaced", err)
	}
	var owner string
	var count int
	if err := pool.QueryRow(ctx, "SELECT owner_id FROM resources.items WHERE id='cinematic_realism'").Scan(&owner); err != nil || owner != "foreign-owner" {
		t.Fatal("foreign resource changed", err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM resources.catalog_imports WHERE version='studio-style-library-1'").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed import left partial catalog audit", err)
	}
}
