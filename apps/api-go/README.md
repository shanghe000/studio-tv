# Go API foundation

Go 1.25+, chi/net/http, pgx v5, PostgreSQL 17. This is the only active API backend.
The existing database tables and asset volume are reused. Embedded migration
`001_core.sql` is byte-for-byte identical to the original migration; `002_ipac_auth.sql`
adds the unified authentication boundary without resetting projects or assets.

Download pinned modules with `go mod download`. Build binaries with
`go build -trimpath -o bin/api ./cmd/api` and
`go build -trimpath -o bin/migrate ./cmd/migrate`.
Run the migration binary before starting API. `api --healthcheck` checks local
`/readyz` without initializing authentication or needing secret environment values.
Readiness verifies both core and auth migrations and writable persistent storage.

## Runtime configuration

Required: `DATABASE_URL`, `AUTH_SIGNING_SECRET` (at least 32 random bytes),
`PUBLIC_BASE_URL` (public HTTPS origin), `CONTRACT_PATH` (absolute frozen JSON file).
Optional: `HOST` (127.0.0.1), `PORT` (3000), `STORAGE_ROOT` (persistent asset volume),
`ALLOWED_ORIGINS` (comma-separated exact origins), `AUTH_ISSUER`, `AUTH_AUDIENCE`,
`MAX_UPLOAD_BYTES` (maximum 512 MiB), `FFPROBE_PATH` (ffprobe).

Install FFmpeg in the runtime image for ffprobe. Upload completion verifies the
actual bytes, SHA256, detected MIME, decoded dimensions and media duration. There
is no client-declared or fabricated READY state.

Explicit local development permits only a loopback origin such as
`PUBLIC_BASE_URL=http://localhost:18880`, with `ALLOW_LOCAL_HTTP=true`. Public HTTP
is rejected. The reverse proxy must route both `/api/v1/**` and `/storage/**` to API;
large storage PUT requests require a 512 MiB proxy limit and suitable timeout.

Unified authentication configuration lives in `internal/auth/config.go`. Password,
OTP and Google entry points are disabled/reserved; no fixed/demo accounts exist.
Only sessions created by the unified Feishu/IPAC identity flow are accepted by
production middleware. `httpapi.Authenticator` isolates authentication from project
and asset handlers; every private resource still checks its actual owner.

## Stable core behavior

- `/projects` list/create and `/projects/{projectId}` read/update/delete;
  pin PUT/DELETE. Pagination defaults to 20; search is `q`.
- `/projects/{projectId}/snapshot` reads/saves the frozen full graph. Strong ETag
  `"N"` and required `If-Match` prevent lost updates. Stale saves return 412.
- Graphs preserve native fields under `data.__rhtv.native`; optional metadata node
  uses `rhtv_meta_v1`/`__rhtv_meta`/version `"1"`. Duplicate nodes, dangling edges,
  reserved metadata collisions, group cycles, prototype keys, credentials and local
  blob/data URLs are rejected. Normal core graphs without metadata remain supported.
- `assetId` and `rhtv-asset:<id>` references must belong to the owner and be READY.
  `modelAssetId` is explicitly rejected while the 3D asset service is reserved.
- `/asset-uploads` init, `/{uploadId}/renew`, `/{uploadId}/complete`; signed raw storage
  PUT does not carry business Bearer. Completion has a 24-hour deadline and upload
  signatures last 15 minutes. Known invalid media persist as REJECTED.
- `/assets` list/read/delete. Fresh signed media URLs support GET/HEAD and one HTTP
  byte range, with 206/416 and correct headers. A referenced asset cannot be deleted.
- Project create, upload init/renew/complete require a UUID `Idempotency-Key`; the
  same request produces one persisted result and a changed payload returns 409.
- Personal ownership is enforced; `X-Team-Id` returns FORBIDDEN until teams are enabled.

The frozen OpenAPI JSON is used to validate request bodies. JSON requests are
limited to 1 MiB, snapshots to 10 MiB, with exact application/json media parsing.
Response envelopes and error/requestId fields follow the frozen protocol.
Request logs omit query signatures, authorization/cookies and request bodies.

`RHTV_EDITION=internal|external` defaults to internal. Optional boolean overrides:
`FEATURE_COMMUNITY`, `FEATURE_BILLING`, `FEATURE_PUBLIC_SHARING`, `FEATURE_MARKETING`,
`FEATURE_EXTERNAL_LINKS`. Internal disabled business endpoints return 403
FEATURE_DISABLED. Skill/template/workflow creative catalog endpoints remain reserved
and are not classified as community. Other known reserved endpoints return 501;
unknown endpoints remain 404. Providers reserve LLM/TEXT_TO_IMAGE/IMAGE_TO_VIDEO/
OMNI_REFERENCE interfaces without any model network or paid calls.

## Tests

`go test ./...` covers schema/router boundaries, media ranges, graph preservation and
security, config, JWT purpose/signature/expiry, and the authentication module.
Set `TEST_DATABASE_URL` to an explicitly named disposable test database to run real
PostgreSQL integration. Each suite creates a random isolated schema; it does not
reset public schema or touch the production database. Core integration also needs
ffprobe. It verifies idempotency, optimistic conflicts, persistence across runtime
restart, owner isolation, upload integrity, media inspection, byte ranges and permanent
rejection. Authentication integration separately verifies IPAC account/session behavior.
