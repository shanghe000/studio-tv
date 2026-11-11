package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/testdb"
	"studiotv.local/service/api/migrations"
)

func TestPostgresCharacterMediaPathMigrationPreservesLegacyAndRejectsUnsafePaths(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	const upgrade = "015_character_media_paths.sql"

	// Build the real pre-upgrade schema in a newly owned disposable database.
	// Production settings and the caller's database are never migrated here.
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() >= upgrade {
			continue
		}
		sql, err := migrations.Files.ReadFile(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("pre-upgrade migration %s: %v", entry.Name(), err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO schema_migrations(name) VALUES($1)`, entry.Name()); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	const version = "character-path-migration-test"
	const legacy = "/project/assets/legacy/cover.png"
	if _, err = db.Exec(ctx, `INSERT INTO resources.catalog_imports(version,source_hash,source_name,row_count) VALUES($1,$2,'Path migration test',1)`, version, strings.Repeat("f", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO resources.catalog_media(id,path,source_version) VALUES('legacy',$1,$2)`, legacy, version); err != nil {
		t.Fatal(err)
	}
	hashPath := "/studio-character-media/" + strings.Repeat("0a", 32) + ".webp"
	assertPathCheck := func(t *testing.T, err error) {
		t.Helper()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" || pgErr.ConstraintName != "catalog_media_path_check" {
			t.Fatalf("expected catalog path CHECK rejection, got %v", err)
		}
	}
	_, err = db.Exec(ctx, `INSERT INTO resources.catalog_media(id,path,source_version) VALUES('before-upgrade',$1,$2)`, hashPath, version)
	assertPathCheck(t, err)

	if err = database.Migrate(ctx, db); err != nil {
		t.Fatal("character path upgrade failed", err)
	}
	var retainedPath, retainedVersion string
	if err = db.QueryRow(ctx, `SELECT path,source_version FROM resources.catalog_media WHERE id='legacy'`).Scan(&retainedPath, &retainedVersion); err != nil || retainedPath != legacy || retainedVersion != version {
		t.Fatal("upgrade changed an existing catalog media row", err)
	}
	for index, path := range []string{hashPath, "/studio-character-media/" + strings.Repeat("f", 64) + ".webp", "/project/assets/new/cover.jpg"} {
		if _, err = db.Exec(ctx, `INSERT INTO resources.catalog_media(id,path,source_version) VALUES($1,$2,$3)`, fmt.Sprintf("valid-%d", index), path, version); err != nil {
			t.Fatalf("valid catalog path rejected: %v", err)
		}
	}
	invalid := []struct{ name, path string }{
		{"hash-short", "/studio-character-media/" + strings.Repeat("a", 63) + ".webp"},
		{"hash-long", "/studio-character-media/" + strings.Repeat("a", 65) + ".webp"},
		{"hash-uppercase", "/studio-character-media/" + strings.Repeat("A", 64) + ".webp"},
		{"hash-not-hex", "/studio-character-media/" + strings.Repeat("g", 64) + ".webp"},
		{"wrong-extension", strings.TrimSuffix(hashPath, ".webp") + ".png"},
		{"uppercase-extension", strings.TrimSuffix(hashPath, ".webp") + ".WEBP"},
		{"child-path", hashPath + "/child.webp"},
		{"traversal", "/studio-character-media/../" + strings.Repeat("a", 64) + ".webp"},
		{"legacy-traversal", "/project/assets/../secret.webp"},
		{"other-prefix", "/other/" + strings.Repeat("a", 64) + ".webp"},
		{"remote-url", "https://example.test" + hashPath},
		{"protocol-relative", "//example.test" + hashPath},
		{"query", hashPath + "?token=secret"},
		{"fragment", hashPath + "#image"},
		{"newline-tail", hashPath + "\n"},
		{"newline-head", "\n" + hashPath},
		{"carriage-return", hashPath + "\r"},
		{"leading-space", " " + hashPath},
		{"backslash", strings.Replace(hashPath, "/studio-character-media/", "/studio-character-media\\", 1)},
	}
	for _, fixture := range invalid {
		t.Run(fixture.name, func(t *testing.T) {
			_, err := db.Exec(ctx, `INSERT INTO resources.catalog_media(id,path,source_version) VALUES($1,$2,$3)`, "invalid-"+fixture.name, fixture.path, version)
			assertPathCheck(t, err)
		})
	}
	_, err = db.Exec(ctx, `UPDATE resources.catalog_media SET path=$1 WHERE id='legacy'`, hashPath+"\n")
	assertPathCheck(t, err)
	if err = database.Migrate(ctx, db); err != nil {
		t.Fatal("repeated migration failed", err)
	}
	var rows, applied int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM resources.catalog_media`).Scan(&rows); err != nil || rows != 4 {
		t.Fatal("repeated migration changed accepted catalog rows", rows, err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE name=$1`, upgrade).Scan(&applied); err != nil || applied != 1 {
		t.Fatal("upgrade was not recorded exactly once", applied, err)
	}
}
