package testdb

import (
	"net/url"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAdminConfigRequiresExplicitTestDatabase(t *testing.T) {
	// An ambient test database must not make an incomplete URL acceptable.
	t.Setenv("PGDATABASE", "ambient_test")
	for _, raw := range []string{
		"",
		"host=localhost dbname=rhtv_test",
		"https://localhost/rhtv_test",
		"postgres://localhost",
		"postgres://localhost/",
		"postgres://test-user@localhost/production",
		"postgres://localhost/production?application_name=test",
		"postgres://localhost/rhtv_test?dbname=production",
		"postgres://localhost/rhtv_test?database=production",
		"postgres://localhost/rhtv_test?dbname=rhtv_test",
		"postgres://localhost/rhtv_test/other",
		"postgres://localhost/rhtv_test#fragment",
		"postgres://localhost/rhtv_test?search_path=%",
		"postgres://user:test-secret@localhost/rhtv_test?pool_max_conns=invalid",
	} {
		if _, _, err := adminConfig(raw); err == nil {
			t.Error("accepted a URL without a safe explicit test database")
		} else if strings.Contains(err.Error(), "test-secret") {
			t.Fatal("configuration error leaked database credentials")
		}
	}
	for _, raw := range []string{
		"postgres://localhost/rhtv_test",
		"postgresql://localhost/RHTV_TEST",
		"postgres://localhost/rhtv_%74est",
	} {
		if _, _, err := adminConfig(raw); err != nil {
			t.Fatalf("rejected explicit test database: %v", err)
		}
	}
}

func TestIsolatedURLUsesOwnedDatabaseAndPublicSearchPath(t *testing.T) {
	u, admin, err := adminConfig("postgres://test-user:test-password@localhost:5433/rhtv_test?sslmode=disable&search_path=old_schema&search_path=other_schema")
	if err != nil {
		t.Fatal(err)
	}
	if admin.ConnConfig.Database != "rhtv_test" || admin.ConnConfig.RuntimeParams["search_path"] != "public" {
		t.Fatal("admin configuration did not preserve the test database and use public")
	}
	const owned = "rhtv_test_owned_random_database"
	raw := isolatedURL(u, owned)
	isolated, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal("isolated URL is invalid")
	}
	if isolated.ConnConfig.Database != owned || isolated.ConnConfig.RuntimeParams["search_path"] != "public" {
		t.Fatal("isolated connection did not target the owned database and public")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host != u.Host || parsed.User.String() != u.User.String() || parsed.Query().Get("sslmode") != "disable" {
		t.Fatal("isolated URL lost the explicit connection settings")
	}
	if u.Path != "/rhtv_test" {
		t.Fatal("isolated URL changed the supplied admin database")
	}
}
