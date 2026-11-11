// Package testdb creates disposable PostgreSQL databases for integration tests.
// Only an explicit TEST_DATABASE_URL is used; its role must have CREATEDB.
package testdb

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const operationTimeout = 15 * time.Second

type Database struct {
	url string
}

// New creates an empty, randomly named database and registers its cleanup.
// Call Open, or register the application's pool cleanup after New, so testing's
// LIFO cleanup closes that pool, drops this exact owned database, then closes
// the admin pool. It never migrates or writes to the supplied database.
func New(t *testing.T) *Database {
	t.Helper()
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("TEST_DATABASE_URL not supplied; real PostgreSQL integration NOT RUN")
	}
	u, cfg, err := adminConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("cannot initialize TEST_DATABASE_URL admin pool")
	}
	t.Cleanup(admin.Close)
	if err := admin.Ping(ctx); err != nil {
		t.Fatal("cannot connect via explicitly supplied TEST_DATABASE_URL")
	}
	name := "rhtv_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+identifier+" TEMPLATE template0"); err != nil {
		t.Fatal("cannot create isolated test database; TEST_DATABASE_URL role needs CREATEDB")
	}
	// Register the drop only after CREATE succeeds: no caller-supplied database
	// or pre-existing name is ever eligible for deletion.
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), operationTimeout)
		defer cancel()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+identifier+" WITH (FORCE)"); err != nil {
			t.Errorf("cannot drop owned isolated test database %q", name)
		}
	})
	return &Database{url: isolatedURL(u, name)}
}

// URL lets startup tests exercise the real application constructor against the
// isolated database, with public as the connection's explicit search_path.
func (d *Database) URL() string { return d.url }

// Open returns a test pool and registers its cleanup after the database drop.
func (d *Database) Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	db, err := pgxpool.New(ctx, d.url)
	if err != nil {
		t.Fatal("cannot initialize isolated test database pool")
	}
	t.Cleanup(db.Close)
	if err := db.Ping(ctx); err != nil {
		t.Fatal("cannot connect to newly created isolated test database")
	}
	return db
}

func adminConfig(raw string) (*url.URL, *pgxpool.Config, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Fragment != "" {
		return nil, nil, errors.New("TEST_DATABASE_URL must be an explicit PostgreSQL URL naming a test database")
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" || strings.Contains(name, "/") || !strings.Contains(strings.ToLower(name), "test") {
		return nil, nil, errors.New("TEST_DATABASE_URL must explicitly name a database containing test")
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || query.Has("database") || query.Has("dbname") {
		return nil, nil, errors.New("TEST_DATABASE_URL must name its test database in the URL path without database overrides")
	}
	query.Set("search_path", "public")
	u.RawQuery = query.Encode()
	cfg, err := pgxpool.ParseConfig(u.String())
	if err != nil {
		// pgx parse errors can include the URL and its password.
		return nil, nil, errors.New("invalid TEST_DATABASE_URL configuration")
	}
	if cfg.ConnConfig.Database != name {
		return nil, nil, errors.New("TEST_DATABASE_URL did not resolve to its explicit test database")
	}
	return u, cfg, nil
}

func isolatedURL(adminURL *url.URL, name string) string {
	u := *adminURL
	u.Path = "/" + name
	u.RawPath = ""
	return u.String()
}
