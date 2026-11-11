package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"studiotv.local/service/api/internal/database"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "studiotv-migrate"))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		slog.Error("DATABASE_URL is required")
		os.Exit(1)
	}
	db, err := database.Open(ctx, url)
	if err == nil {
		defer db.Close()
		err = database.Migrate(ctx, db)
	}
	if err != nil {
		// Driver errors may contain connection strings and database content.
		slog.Error("migration failed", "error_code", "DATABASE_MIGRATION_FAILED")
		os.Exit(1)
	}
	slog.Info("database migrations completed")
}
