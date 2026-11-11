# Product resources

Pure domain rules, explicit application ports, real PostgreSQL adapters and bounded HTTP routes. No environment reads in domain/services; no browser/native proxy, default DSN, paid model, wallet or fake public user.

Root composes postgres.New(pool), explicitly ImportCatalog(ctx), application.New(repo), HTTP RegisterRoutes(router,service,trustedProtect). See [resources API](../../../../../docs/resources-api.md) and current iteration resources-seam.md for dependency ports. Immutable captured catalogs are committed normalized seed with source/version/hash audit; owner rows are never seeded.

From apps/api-go run `go test ./internal/modules/resources/... ./internal/modules/library/...`, `go vet` and `go build` on the same packages. Integration tests only accept explicit TEST_DATABASE_URL and create disposable randomly named databases; missing DSN explicitly SKIP.
