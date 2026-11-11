package postgres_test

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/library/adapters/postgres"
	"studiotv.local/service/api/internal/modules/library/application"
	"studiotv.local/service/api/internal/modules/library/domain"
	"studiotv.local/service/api/internal/testdb"
	"studiotv.local/service/api/migrations"
	"strings"
	"sync"
	"testing"
	"time"
)

// Only explicit TEST_DATABASE_URL is accepted by testdb. Every test creates an
// exact randomly named database, closes its own pool and deletes only that DB.
// The caller's database is never migrated, truncated, or used for fixture rows.
func migrated(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatal("core/library migration failed in isolated database")
	}
	return db, ctx
}
func service(t *testing.T, db *pgxpool.Pool) *application.Service {
	t.Helper()
	u, e := postgres.New(db)
	if e != nil {
		t.Fatal(e)
	}
	s, e := application.New(u)
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func createCommand(title, key string, ids ...string) application.CreateCommand {
	if ids == nil {
		ids = []string{}
	}
	input := domain.Input{Title: title, Description: "persistent % literal", Kind: domain.Role, AssetIDs: ids}
	hash, _ := application.CreationHash(map[string]any{"title": title, "description": input.Description, "kind": "ROLE", "assetIds": ids})
	return application.CreateCommand{Input: input, IdempotencyKey: key, RequestHash: hash}
}
func seed(t *testing.T, db *pgxpool.Pool, ctx context.Context) (string, string, string, string) {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	a, b := "library_a_"+suffix, "library_b_"+suffix
	image, foreign := "image_a_"+suffix, "image_b_"+suffix
	if _, e := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES($1,$1||'@example.test','A'),($2,$2||'@example.test','B');`, a, b); e != nil {
		t.Fatal("random users seed failed")
	}
	for _, owner := range []string{a, b} {
		if _, e := db.Exec(ctx, "INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,'library test')", "project_"+owner, owner); e != nil {
			t.Fatal("random project seed failed")
		}
	}
	for i, owner := range []string{a, b} {
		id := image
		if i == 1 {
			id = foreign
		}
		if _, e := db.Exec(ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES($1,$2,$3,'test.png','IMAGE','image/png',1,$4,'READY')`, id, owner, "project_"+owner, strings.Repeat("0", 64)); e != nil {
			t.Fatal("random asset seed failed")
		}
	}
	return a, b, image, foreign
}
func TestPostgresLibraryConcurrentReceiptsVersionsPersistenceAndOwnership(t *testing.T) {
	db, ctx := migrated(t)
	a, b, image, foreign := seed(t, db, ctx)
	s := service(t, db)
	actor := domain.VerifiedActor{OwnerID: a}
	key := uuid.NewString()
	command := createCommand("狐 persistent", key, image)
	var roots [8]domain.Gallery
	var errs [8]error
	var wg sync.WaitGroup
	for i := range roots {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := command
			if i%2 == 1 {
				c.IdempotencyKey = strings.ToUpper(key)
			}
			roots[i], errs[i] = s.Create(ctx, actor, c)
		}(i)
	}
	wg.Wait()
	for i, g := range roots {
		if errs[i] != nil || g.ID != roots[0].ID {
			t.Fatal("concurrent UUID did not create singular receipt")
		}
	}
	id := roots[0].ID
	var rootCount, keyCount int
	if e := db.QueryRow(ctx, "SELECT count(*) FROM library.items WHERE owner_id=$1", a).Scan(&rootCount); e != nil || rootCount != 1 {
		t.Fatal("unexpected concurrent roots")
	}
	if e := db.QueryRow(ctx, "SELECT count(*) FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2", a, application.CreateOperation).Scan(&keyCount); e != nil || keyCount != 1 {
		t.Fatal("unexpected concurrent receipts")
	}
	restarted := service(t, db)
	if g, e := restarted.Create(ctx, actor, command); e != nil || g.ID != id {
		t.Fatal("restarted receipt did not restore identity")
	}
	if _, e := s.Create(ctx, actor, createCommand("changed", key, image)); !errors.Is(e, domain.ErrIdempotencyConflict) {
		t.Fatal("changed hash accepted")
	}
	if _, e := s.Create(ctx, actor, createCommand("cross", uuid.NewString(), foreign)); !errors.Is(e, domain.ErrAssetNotFound) {
		t.Fatal("cross-owner image accepted")
	}
	if _, e := s.Get(ctx, domain.VerifiedActor{OwnerID: b}, id); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign root visible")
	}
	if _, e := s.Delete(ctx, domain.VerifiedActor{OwnerID: b}, id, 1); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign root deleted")
	}
	input := roots[0].Input
	input.Title = "updated"
	input.MainAssetID = &image
	var updates [2]domain.Gallery
	var updateErrors [2]error
	for i := range updates {
		wg.Add(1)
		go func(i int) { defer wg.Done(); updates[i], updateErrors[i] = s.Update(ctx, actor, id, input, 1) }(i)
	}
	wg.Wait()
	success, conflicts := 0, 0
	for _, e := range updateErrors {
		var version *domain.VersionConflict
		if e == nil {
			success++
		} else if errors.As(e, &version) && version.Current == 2 {
			conflicts++
		} else {
			t.Fatal("unexpected concurrent version result")
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("two writers passed the same revision")
	}
	kind := domain.Role
	p, e := restarted.List(ctx, actor, domain.Query{Page: 1, Size: 1, Keyword: "%", Kind: &kind})
	if e != nil || p.Total != 1 || p.Pages != 1 || len(p.Records) != 1 || p.Records[0].Revision != 2 {
		t.Fatal("stored page/search incorrect")
	}
	p, e = restarted.List(ctx, actor, domain.Query{Page: 100000, Size: 100})
	if e != nil || p.Total != 1 || len(p.Records) != 0 {
		t.Fatal("empty page lost total")
	}
	var collectionRevision int64
	if e = db.QueryRow(ctx, "SELECT revision FROM library.collections WHERE owner_id=$1", a).Scan(&collectionRevision); e != nil || collectionRevision != 3 {
		t.Fatal("failed/conflicting operations advanced collection")
	}
	if rev, e := s.Delete(ctx, actor, id, 2); e != nil || rev != 3 {
		t.Fatal("soft deletion failed")
	}
	if _, e = restarted.Create(ctx, actor, command); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("deleted receipt resurrected gallery")
	}
	var refs int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM library.item_media_refs WHERE item_id=$1", id).Scan(&refs); e != nil || refs != 1 {
		t.Fatal("deletion erased reference history")
	}
}
func TestPostgresLibraryConstraintsAndReadReferenceAuthorization(t *testing.T) {
	db, ctx := migrated(t)
	a, b, image, foreign := seed(t, db, ctx)
	s := service(t, db)
	actor := domain.VerifiedActor{OwnerID: a}
	c := createCommand("own", uuid.NewString(), image)
	c.Input.MainAssetID = &image
	g, e := s.Create(ctx, actor, c)
	if e != nil {
		t.Fatal("gallery create failed")
	}
	other, e := s.Create(ctx, domain.VerifiedActor{OwnerID: b}, createCommand("other", uuid.NewString(), foreign))
	if e != nil {
		t.Fatal("other gallery create failed")
	}
	expect := func(sql, state string, args ...any) {
		t.Helper()
		_, e := db.Exec(ctx, sql, args...)
		var pgerr *pgconn.PgError
		if !errors.As(e, &pgerr) || pgerr.Code != state {
			t.Fatalf("expected library SQLSTATE %s", state)
		}
	}
	expect("INSERT INTO library.item_media_refs(item_id,owner_id,asset_id,sort_order) VALUES($1,$2,$3,1)", "23503", other.ID, b, image)
	expect("INSERT INTO library.item_media_refs(item_id,owner_id,asset_id,sort_order) VALUES($1,$2,$3,1)", "23503", g.ID, b, foreign)
	expect("UPDATE library.items SET owner_id=$2,revision=revision+1 WHERE id=$1", "23514", g.ID, b)
	expect("UPDATE library.items SET kind='SCENE',revision=revision+1 WHERE id=$1", "23514", g.ID)
	expect("UPDATE library.items SET title='without revision' WHERE id=$1", "23514", g.ID)
	secondImage := image + "_second"
	if _, e = db.Exec(ctx, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES($1,$2,$3,'second.png','IMAGE','image/png',1,$4,'READY')`, secondImage, a, "project_"+a, strings.Repeat("0", 64)); e != nil {
		t.Fatal("second image seed failed")
	}
	expect("INSERT INTO library.item_media_refs(item_id,owner_id,asset_id,sort_order) VALUES($1,$2,$3,0)", "23505", g.ID, a, secondImage)
	expect("INSERT INTO library.item_media_refs(item_id,owner_id,asset_id,sort_order,is_main) VALUES($1,$2,$3,1,true)", "23505", g.ID, a, secondImage)
	expect("INSERT INTO library.item_media_refs(item_id,owner_id,asset_id,sort_order) VALUES($1,$2,$3,100)", "23514", g.ID, a, secondImage)
	if _, e = db.Exec(ctx, "UPDATE public.assets SET state='DELETED',deleted_at=now() WHERE id=$1", image); e != nil {
		t.Fatal("asset read visibility seed failed")
	}
	view, e := s.Get(ctx, actor, g.ID)
	if e != nil || len(view.AssetIDs) != 0 || view.MainAssetID != nil {
		t.Fatal("inactive image leaked in detail")
	}
	p, e := s.List(ctx, actor, domain.Query{Page: 1, Size: 20})
	if e != nil || len(p.Records) != 1 || len(p.Records[0].AssetIDs) != 0 {
		t.Fatal("inactive image leaked in page")
	}
	if _, e = s.Update(ctx, actor, g.ID, c.Input, 1); !errors.Is(e, domain.ErrAssetNotFound) {
		t.Fatal("inactive image retained by write")
	}
	view, e = s.Get(ctx, actor, g.ID)
	if e != nil || view.Revision != 1 {
		t.Fatal("failed reference validation left revision")
	}
	if _, e = s.Delete(ctx, actor, g.ID, 1); e != nil {
		t.Fatal("gallery deletion failed")
	}
	expect("UPDATE library.items SET deleted_at=NULL,revision=revision+1 WHERE id=$1", "23514", g.ID)
}
func TestLibraryMigrationExistingCoreAndRerun(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if _, e := db.Exec(ctx, "CREATE TABLE public.schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())"); e != nil {
		t.Fatal("migration metadata seed failed")
	}
	for _, name := range []string{"001_core.sql", "002_ipac_auth.sql", "003_ipac_workspaces.sql", "004_assistant_core.sql"} {
		sql, e := migrations.Files.ReadFile(name)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, string(sql)); e != nil {
			t.Fatal("pre-library migration failed")
		}
		if _, e = db.Exec(ctx, "INSERT INTO public.schema_migrations(name) VALUES($1)", name); e != nil {
			t.Fatal("pre-library migration metadata failed")
		}
	}
	a, _, image, _ := seed(t, db, ctx)
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatal("library migration rejected existing core data")
	}
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatal("migration runner rerun failed")
	}
	var owner string
	if e := db.QueryRow(ctx, "SELECT owner_id FROM public.assets WHERE id=$1", image).Scan(&owner); e != nil || owner != a {
		t.Fatal("library migration changed existing asset")
	}
	var applied int
	if e := db.QueryRow(ctx, "SELECT count(*) FROM public.schema_migrations WHERE name='006_library_core.sql'").Scan(&applied); e != nil || applied != 1 {
		t.Fatal("006 not applied exactly once")
	}
}
