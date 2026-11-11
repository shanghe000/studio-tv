package database

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/migrations"
	"sort"
)

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	return pgxpool.NewWithConfig(ctx, cfg)
}
func Transaction[T any](ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) (T, error)) (T, error) {
	var empty T
	tx, err := pool.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(ctx)
	value, err := fn(tx)
	if err != nil {
		return empty, err
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, err
	}
	return value, nil
}
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := Transaction(ctx, pool, func(tx pgx.Tx) (bool, error) {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(862531702)"); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
			return false, err
		}
		entries, err := migrations.Files.ReadDir(".")
		if err != nil {
			return false, err
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			var exists bool
			err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1)", entry.Name()).Scan(&exists)
			if err != nil {
				return false, err
			}
			if exists {
				continue
			}
			sql, e := migrations.Files.ReadFile(entry.Name())
			if e != nil {
				return false, e
			}
			if _, e = tx.Exec(ctx, string(sql)); e != nil {
				return false, e
			}
			if _, e = tx.Exec(ctx, "INSERT INTO schema_migrations(name)VALUES($1)", entry.Name()); e != nil {
				return false, e
			}
		}
		return true, nil
	})
	return err
}
