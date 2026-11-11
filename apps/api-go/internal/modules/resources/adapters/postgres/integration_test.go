package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/resources/adapters/postgres"
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"studiotv.local/service/api/internal/testdb"
	"strings"
	"sync"
	"testing"
	"time"
)

// testdb exclusively accepts TEST_DATABASE_URL and creates/deletes a randomly owned database.
// Neither default DATABASE_URL nor any production configuration is read here.
func fixture(t *testing.T) (context.Context, *pgxpool.Pool, *postgres.Repository, domain.Actor, domain.Actor, string) {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	a, b := domain.Actor{OwnerID: "res_a_" + suffix}, domain.Actor{OwnerID: "res_b_" + suffix}
	for _, owner := range []string{a.OwnerID, b.OwnerID} {
		if _, e := db.Exec(ctx, "INSERT INTO public.users(id,email,display_name) VALUES($1,$1||'@example.test','Resource test')", owner); e != nil {
			t.Fatal(e)
		}
		if _, e := db.Exec(ctx, "INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,'Resource test')", "project_"+owner, owner); e != nil {
			t.Fatal(e)
		}
	}
	image := "image_" + suffix
	if _, e := db.Exec(ctx, "INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES($1,$2,$3,'actual.png','IMAGE','image/png',1,$4,'READY')", image, a.OwnerID, "project_"+a.OwnerID, strings.Repeat("a", 64)); e != nil {
		t.Fatal(e)
	}
	repo, e := postgres.New(db)
	if e != nil {
		t.Fatal(e)
	}
	return ctx, db, repo, a, b, image
}
func command(t *testing.T, rev int64, body any) application.Mutation {
	t.Helper()
	m, e := application.Command(rev, uuid.NewString(), body)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func TestPrivateResourcesPersistenceIsolationConcurrencyAndReferences(t *testing.T) {
	ctx, db, repo, a, b, image := fixture(t)
	svc, _ := application.New(repo)
	i := domain.Input{Name: "my prompt", CategoryIDs: []string{}, CoverAssetID: &image, Content: json.RawMessage(`{"prefixPrompt":"real prompt","suffixPrompt":"style"}`)}
	m := command(t, 0, i)
	var wg sync.WaitGroup
	results := make(chan domain.Resource, 6)
	errs := make(chan error, 6)
	for n := 0; n < 6; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); v, e := svc.Save(ctx, a, domain.Prompt, "", i, m); results <- v; errs <- e }()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	id := ""
	for v := range results {
		if id != "" && id != v.ID {
			t.Fatal("concurrent duplicate")
		}
		id = v.ID
	}
	var count int
	if e := db.QueryRow(ctx, "SELECT count(*) FROM resources.items WHERE owner_id=$1", a.OwnerID).Scan(&count); e != nil || count != 1 {
		t.Fatal("not one durable row", count, e)
	}
	if _, e := svc.Get(ctx, b, domain.Prompt, id); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("cross-owner detail", e)
	}
	if _, e := svc.Save(ctx, b, domain.Prompt, "", i, command(t, 0, i)); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("cross-owner asset", e)
	}
	changed := i
	changed.Name = "changed"
	if _, e := svc.Save(ctx, a, domain.Prompt, "", changed, commandWithKey(t, m.Key, changed)); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("idempotency conflict", e)
	}
	v, e := svc.Save(ctx, a, domain.Prompt, id, changed, command(t, 1, changed))
	if e != nil || v.Revision != 2 {
		t.Fatal(e)
	}
	if _, e = svc.Save(ctx, a, domain.Prompt, id, changed, command(t, 1, changed)); e == nil {
		t.Fatal("stale write")
	}
	if _, e = svc.Favorite(ctx, a, domain.Prompt, id, true, application.Mutation{Expected: 2}); e != nil {
		t.Fatal(e)
	}
	project := "project_" + a.OwnerID
	u, e := svc.Use(ctx, a, domain.Prompt, id, &project, nil, command(t, 0, map[string]any{"projectId": project}))
	if e != nil || u.ID == "" {
		t.Fatal(e)
	}
	foreignProject := "project_" + b.OwnerID
	if _, e = svc.Use(ctx, a, domain.Prompt, id, &foreignProject, nil, command(t, 0, map[string]any{"projectId": foreignProject})); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign project", e)
	}
	restarted, _ := postgres.New(db)
	restored, _ := application.New(restarted)
	p, e := restored.List(ctx, a, domain.Prompt, domain.Query{Page: 99, Size: 1, FavoriteOnly: true, RecentOnly: true})
	if e != nil || p.Total != 1 || len(p.Records) != 0 || p.Pages != 1 {
		t.Fatal("truthful pagination", p, e)
	}
	p, e = restored.List(ctx, b, domain.Prompt, domain.Query{Page: 1, Size: 100})
	if e != nil || p.Total != 0 {
		t.Fatal("private collection leaked")
	}
	var active bool
	if e = db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM resources.active_asset_references WHERE asset_id=$1 AND owner_id=$2)", image, a.OwnerID).Scan(&active); e != nil || !active {
		t.Fatal("missing active reference", e)
	}
	if _, e = svc.Delete(ctx, a, domain.Prompt, id, application.Mutation{Expected: 2}); e != nil {
		t.Fatal(e)
	}
	if e = db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM resources.active_asset_references WHERE asset_id=$1 AND owner_id=$2)", image, a.OwnerID).Scan(&active); e != nil || active {
		t.Fatal("deleted root blocks asset", e)
	}
	if _, e = svc.Save(ctx, a, domain.Prompt, "", i, m); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("receipt resurrected deleted root", e)
	}
}
func commandWithKey(t *testing.T, key string, body any) application.Mutation {
	m, e := application.Command(0, key, body)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func TestCatalogImportAuditRealFavoritesAndNoOwnersModelsCosts(t *testing.T) {
	ctx, db, repo, a, b, _ := fixture(t)
	if e := repo.ImportCatalog(ctx); e != nil {
		t.Fatal(e)
	}
	if e := repo.ImportCatalog(ctx); e != nil {
		t.Fatal("import repeat", e)
	}
	var imports, owners int
	if e := db.QueryRow(ctx, "SELECT count(*) FROM resources.catalog_imports").Scan(&imports); e != nil || imports != 2 {
		t.Fatal(e)
	}
	if e := db.QueryRow(ctx, "SELECT count(*) FROM resources.items WHERE owner_id IS NOT NULL").Scan(&owners); e != nil || owners != 0 {
		t.Fatal("owner rows seeded")
	}
	p, e := repo.List(ctx, a, domain.Character, domain.Query{Page: 1, Size: 20})
	if e != nil || p.Total == 0 || len(p.Records) == 0 {
		t.Fatal("catalog absent", e)
	}
	id := p.Records[0].ID
	if _, e = repo.Favorite(ctx, a, domain.Character, id, true, application.Mutation{Expected: 2}); e != nil {
		t.Fatal(e)
	}
	p, e = repo.List(ctx, a, domain.Character, domain.Query{Page: 1, Size: 100, FavoriteOnly: true})
	if e != nil || p.Total != 1 {
		t.Fatal("favorite did not persist", e)
	}
	p, e = repo.List(ctx, b, domain.Character, domain.Query{Page: 1, Size: 100, FavoriteOnly: true})
	if e != nil || p.Total != 0 {
		t.Fatal("favorite owner leaked", e)
	}
	filters, e := repo.Values(ctx, "CHARACTER_FILTERS", nil)
	if e != nil || len(filters) != 1 {
		t.Fatal("filter catalog", e)
	}
	var raw []byte
	if e = db.QueryRow(ctx, "SELECT content FROM resources.items WHERE id=$1", id).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(raw), "https://") {
		t.Fatal("catalog remote media retained")
	}
	cat, e := repo.Categories(ctx, "APP", nil)
	if e != nil || len(cat) != 21 {
		t.Fatal("native tree root duplicated", len(cat), e)
	}
	source, e := repo.CatalogMedia(ctx, a, "/project/assets/non-existent.png", "project_"+a.OwnerID)
	if !errors.Is(e, domain.ErrNotFound) || source.ID != "" {
		t.Fatal("arbitrary media source allowed", e)
	}
}
func TestPreferencesTagsDurableOwnerAndOrder(t *testing.T) {
	ctx, db, repo, a, b, _ := fixture(t)
	pref, e := repo.Preferences(ctx, a)
	if e != nil || pref.Revision != 1 {
		t.Fatal(e)
	}
	flag := true
	next, e := repo.UpdatePreferences(ctx, a, domain.PreferenceInput{BuzzyPopFlag: &flag, ShortcutKeyConfig: json.RawMessage(`{"submitTask":"shift-enter","newline":"enter","zoomSensitivity":25,"interactionMode":"rhtv"}`)}, application.Mutation{Expected: 1})
	if e != nil || next.Revision != 2 || !next.BuzzyPopFlag {
		t.Fatal(e)
	}
	tags, e := repo.Tags(ctx, a)
	if e != nil {
		t.Fatal(e)
	}
	one, e := repo.MutateTags(ctx, a, "create", "", domain.Tag{Name: "first", Color: "#AABBCC"}, nil, false, command(t, tags.Revision, map[string]any{"name": "first"}))
	if e != nil {
		t.Fatal(e)
	}
	two, e := repo.MutateTags(ctx, a, "create", "", domain.Tag{Name: "second", Color: "#112233"}, nil, false, command(t, one.Revision, map[string]any{"name": "second"}))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = repo.MutateTags(ctx, b, "update", one.Tags[0].ID, domain.Tag{Name: "steal", Color: "#112233"}, nil, false, application.Mutation{Expected: 1}); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign tag", e)
	}
	order := []string{two.Tags[1].ID, two.Tags[0].ID}
	sorted, e := repo.MutateTags(ctx, a, "order", "", domain.Tag{}, order, false, application.Mutation{Expected: two.Revision})
	if e != nil || sorted.Tags[0].ID != order[0] {
		t.Fatal(e)
	}
	restarted, _ := postgres.New(db)
	restored, e := restarted.Preferences(ctx, a)
	if e != nil || !restored.BuzzyPopFlag || !strings.Contains(string(restored.ShortcutKeyConfig), "shift-enter") {
		t.Fatal("preferences lost", e)
	}
	if _, e = repo.MutateTags(ctx, a, "preset", "missing", domain.Tag{}, nil, false, command(t, sorted.Revision, map[string]any{"preset": "missing"})); !errors.Is(e, domain.ErrUnsupported) {
		t.Fatal("fake preset", e)
	}
}
func TestStudioAtomicFilesPrefixEventsRestartAndParentIsolation(t *testing.T) {
	ctx, db, repo, a, b, _ := fixture(t)
	canvas := "project_" + a.OwnerID
	input := domain.StudioInput{Title: "durable HF", ProjectID: &canvas}
	p, e := repo.StudioSave(ctx, a, "", input, command(t, 0, input))
	if e != nil {
		t.Fatal(e)
	}
	files := []domain.FileWrite{{Path: "folder/index.html", Input: domain.FileInput{Content: "<p>actual</p>", Encoding: "utf8", MimeType: "text/html"}}, {Path: "fonts/font.woff2", Input: domain.FileInput{Content: "d09GMg==", Encoding: "base64", MimeType: "font/woff2"}}}
	written, e := repo.WriteFiles(ctx, a, p.ID, "upload", files, "", command(t, p.Revision, files))
	if e != nil || written.Revision != 2 {
		t.Fatal(e)
	}
	if _, e = repo.File(ctx, b, p.ID, "folder/index.html"); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign studio", e)
	}
	if _, e = repo.WriteFiles(ctx, a, p.ID, "write", files, "", application.Mutation{Expected: 1}); e == nil {
		t.Fatal("stale studio write")
	}
	renamed, e := repo.WriteFiles(ctx, a, p.ID, "rename", []domain.FileWrite{{Path: "folder"}}, "new", application.Mutation{Expected: 2})
	if e != nil || renamed.Revision != 3 {
		t.Fatal("directory rename", e)
	}
	f, e := repo.File(ctx, a, p.ID, "new/index.html")
	if e != nil || f.Content != "<p>actual</p>" {
		t.Fatal("bytes changed", e)
	}
	restarted, _ := postgres.New(db)
	f, e = restarted.File(ctx, a, p.ID, "fonts/font.woff2")
	if e != nil || f.Content != "d09GMg==" || f.Encoding != "base64" {
		t.Fatal("font bytes lost", e)
	}
	fonts, e := repo.Fonts(ctx, a, false)
	if e != nil || len(fonts) != 1 {
		t.Fatal("actual font catalog", e)
	}
	events, more, e := repo.StudioEvents(ctx, a, 0)
	if e != nil || more || len(events) != 4 {
		t.Fatal("events not atomic", len(events), e)
	}
	other, _, e := repo.StudioEvents(ctx, b, 0)
	if e != nil || len(other) != 0 {
		t.Fatal("event owner leak")
	}
	if _, e = repo.WriteFiles(ctx, a, p.ID, "delete", []domain.FileWrite{{Path: "new"}}, "", application.Mutation{Expected: 3}); e != nil {
		t.Fatal(e)
	}
	if _, e = repo.File(ctx, a, p.ID, "new/index.html"); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("prefix delete fake", e)
	}
	if _, e = db.Exec(ctx, "UPDATE public.projects SET deleted_at=now(),revision=revision+1 WHERE id=$1", canvas); e != nil {
		t.Fatal(e)
	}
	if _, e = repo.StudioGet(ctx, a, p.ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("deleted canvas grants HF access", e)
	}
	t.Log(fmt.Sprintf("durable studio %s tested in isolated DB", p.ID))
}
func TestHFAlreadyBoundSessionMapsAndCannotCrossStudio(t *testing.T) {
	ctx, db, repo, a, b, _ := fixture(t)
	i := domain.StudioInput{Title: "HF binding"}
	p, e := repo.StudioSave(ctx, a, "", i, command(t, 0, i))
	if e != nil {
		t.Fatal(e)
	}
	session := "hf-session-" + uuid.NewString()
	if _, e = db.Exec(ctx, "INSERT INTO assistant.conversations(id,owner_id,business,hf_project_id,title) VALUES($1,$2,'HF',$3,'actual HF')", session, a.OwnerID, p.ID); e != nil {
		t.Fatal("root HF migration required", e)
	}
	m := command(t, 0, map[string]any{"sessionId": session})
	if e = repo.BindSession(ctx, a, p.ID, session, m); e != nil {
		t.Fatal(e)
	}
	rows, e := repo.StudioSessions(ctx, a, p.ID)
	if e != nil || len(rows) != 1 || !strings.Contains(string(rows[0]), session) {
		t.Fatal("session mapping not persisted", e)
	}
	other, e := repo.StudioSave(ctx, a, "", domain.StudioInput{Title: "different"}, command(t, 0, map[string]any{"title": "different"}))
	if e != nil {
		t.Fatal(e)
	}
	if e = repo.BindSession(ctx, a, other.ID, session, command(t, 0, map[string]any{"sessionId": session})); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("session rebound", e)
	}
	if e = repo.BindSession(ctx, b, p.ID, session, m); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign HF binding", e)
	}
}

func TestCharacterMediaUpgradeReplayRejectsAlteredRowsAndRollsBack(t *testing.T) {
	ctx, db, repo, a, _, _ := fixture(t)
	if e := repo.ImportCatalog(ctx); e != nil {
		t.Fatal(e)
	}
	page, e := repo.List(ctx, a, domain.Character, domain.Query{Page: 1, Size: 1})
	if e != nil || len(page.Records) != 1 || page.Records[0].Revision != 2 {
		t.Fatal("media upgrade not imported", e)
	}
	var imageURL string
	if e := db.QueryRow(ctx, `SELECT content->'images'->0->>'url' FROM resources.items WHERE id=$1`, page.Records[0].ID).Scan(&imageURL); e != nil || !strings.HasPrefix(imageURL, "/studio-character-media/") {
		t.Fatal("real local character image missing", e)
	}
	if _, e := db.Exec(ctx, `UPDATE resources.items SET name='altered',revision=revision+1 WHERE id=$1`, page.Records[0].ID); e != nil {
		t.Fatal(e)
	}
	if e := repo.ImportCatalog(ctx); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("altered catalog accepted on replay", e)
	}
	var name string
	if e := db.QueryRow(ctx, `SELECT name FROM resources.items WHERE id=$1`, page.Records[0].ID).Scan(&name); e != nil || name != "altered" {
		t.Fatal("replay overwrote existing character", e)
	}
}
