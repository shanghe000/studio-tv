# Assistant conversations and user-text persistence

This module implements private GLOBAL homepage and CANVAS conversation
list/create/detail/soft-delete, USER TEXT append and message queries. GLOBAL roots have no project
binding; CANVAS roots retain strict owned, undeleted project checks. It makes
no Router request and never starts inference on append. HF conversations and the five explicitly registered run operations
return 501; arbitrary other paths are left to the host router's 404 handler.

## Composition

The host supplies a pool, verified authentication, live `tv.access`, shared
`httpapi.Base`, and the host 404/error handling. No module reads environment,
constructs auth clients, opens a pool, or loads the proposed contract at runtime.

```go
uow, err := postgres.New(pool) // adapters/postgres
if err != nil { return err }
service, err := application.New(uow)
if err != nil { return err }
return assistantHTTP.RegisterRoutes(router, service, protect)
```

The exact registration signature is:

```go
func RegisterRoutes(router chi.Router, service *application.Service, protect Protect) error
type Protect func(capability string, next httpapi.Handler) http.HandlerFunc
```

`protect` must verify the real local session, check the supplied capability
(`tv.access` on every route), set `httpapi.WithIdentity`, and wrap HTTP errors.
For example, the host can inject `httpapi.RequireAuth(identity, handler)` where
`handler` calls `access.Check` before invoking `next`. If the host already puts
all module routes inside verified identity/live `tv.access` middleware, it may
explicitly inject a decorator using `httpapi.Wrap(next)` **inside that protected
group only**. Neither a default decorator nor environment authentication exists
in this module. A nil decorator is rejected before registration. Missing verified
identity still returns 401 inside each registered handler.

The six implemented operations use the independent `assistant-extension.json` v1.1.0
contract. The old `domain-extension.json` remains a design proposal:

- `GET /api/v2/conversations`: optional `kind=GLOBAL|CANVAS|HF`, `projectId`,
  `hfProjectId`, `page`, `size`, `keyword`. No kind lists own GLOBAL and visible
  CANVAS records sorted by `updated_at DESC,id`. GLOBAL with a project filter
  is invalid; HF kind/filter returns501. Explicit inaccessible projectId returns404.
- `POST /api/v2/conversations`: canonical UUID `Idempotency-Key`, kind/title and
  required owned undeleted project for CANVAS. GLOBAL accepts only omitted/null
  projectId and hfProjectId. Returns201, actual DTO and ETag, including on replay.
- `DELETE /api/v2/conversations/{id}`: required positive strong `If-Match`;
  missing header 428, malformed header 400, stale revision 412. Returns the
  contracted `{accepted:true}` data and the incremented ETag.
- `GET /api/v2/conversations/{id}/messages`: page/size/keyword; message sequence
  ascending, current `MessagePart` array, keyword searches TEXT parts only.
- `GET /api/v2/conversations/{id}`: own visible detail and current strong ETag.
- `POST /api/v2/conversations/{id}/messages`: UUID Idempotency-Key plus strong
  If-Match; strict `{content:[{type:"TEXT",text:"..."}]}` with 1..100 parts,
  each nonempty (<=200000 Unicode characters), with non-whitespace text overall.
  Shared 1 MiB JSON limit applies. Unknown/server fields and NUL fail400;
  valid ASSET/STRUCTURED input returns501 without claiming asset authorization.
  Returns201 Message plus conversationRevision and receipt ETag, even on replay.

Defaults are page=1, size=20; bounds are page<=100000, size<=100. Keyword trims
outer spaces, is at most 300 Unicode characters, and SQL wildcards are literal.
Unknown/repeated query parameters fail. Owner is never taken from body/headers.

Creation reuses `public.idempotency_keys`, operation `domainCreateConversation`,
owner+operation+canonical key advisory lock, and the existing canonical
`{body,params:{},team:null}` SHA256 convention. Field order is irrelevant;
omitted fields and explicit null remain distinct. Receipt and root commit in one
transaction. Replays return the initial public projection, but first recheck
root visibility and, for CANVAS, project visibility; deleted roots/projects
return404 instead of resurrecting or exposing the original receipt. GLOBAL does
not query or lock a project. Changed content returns409. Verified owner is stable
across local login session changes; rebuilding UoW/application restores history.

## Migration

`004_assistant_core.sql` requires 001..003 in **public**. It adds only two tables
under assistant, the referenced `public.projects(id,owner_id)` unique key, necessary
indexes/checks and assistant validation/identity guard functions. No full blueprint
dependencies are installed. `business` maps the domain Kind and is restricted
to GLOBAL/CANVAS. GLOBAL requires both binding fields NULL, CANVAS requires
canvas_project_id and a composite owner/project FK; hf_project_id remains NULL
until the HF schema and ownership FK are implemented. Kind/owner/bindings are
immutable. Project soft deletion hides CANVAS, but does not affect GLOBAL. Router
references default to paired NULL and their nonnull pair is globally unique,
including deleted roots. No Router binding is established by this module.

Historical roles/parts retain the original contract (USER/ASSISTANT/TOOL;
TEXT/ASSET/STRUCTURED arrays, <=100 parts). Writes are only server-generated USER
TEXT. Append locks the root, allocates next_message_sequence and inserts the
message, advanced revision/sequence and receipt in one UoW. No DDL is added.
Future multimodal writes still need fixed STRUCTURED schemas/owned READY media;
no unimplemented run/task/catalog FK or permissive orphan reference is added.

Append uses existing public.idempotency_keys (there is no idempotency_records
table in this repository), operation assistantAppendUserMessage. Hash identity
includes canonical content, conversationId and frozen expectedRevision. Same
owner/key with different input/path/precondition409; a new key with stale ETag412.
Replays first recheck the visible owned root/project and query the actual stored
message by owner+root+message ID; a receipt cannot grant ownership. Replay ETag
and conversationRevision remain the original receipt revision after later appends;
GET detail returns the current revision. No model invocation, fake assistant
reply, usage or run is produced by a message write. The existing create operation
and receipts stay unchanged.

Placeholder conversation titles (blank or `新对话`) are named from the first
effective USER TEXT during the append transaction. Whitespace/control separators
collapse to spaces and titles use at most 32 Unicode characters, with an ellipsis
when truncated. Attachments and skill instructions do not supply titles. A saved
internal generation marker prevents later turns from renaming the conversation;
meaningful caller-supplied titles are preserved. This uses no model request.
`013_assistant_titles.sql` adds that marker and backfills existing active
placeholder titles from their first undeleted effective USER text, incrementing
the root revision while preserving `updated_at` and immutable creation receipts.
Empty, deleted and custom-titled conversations retain their titles.

Application ports added: FindMessageReceipt, SaveMessageReceipt, Message and
AppendMessage. Detail/AppendMessage are application use cases; all fixture
repositories used by tests implement these ports. Domain/application have no
HTTP/pgx/provider dependency. Composition and trusted auth decorator stay unchanged.

Host integration requires explicit registrar wiring and the trusted auth/access
decorator. The actual standalone assistant contract has6 IMPLEMENTED and5
RESERVED operations. No frozen contract, full blueprint SQL, UI, bootstrap, core
or configuration file was edited by this module.
Existing integration tests that migrate all files into a scratch **search_path
schema** must be adapted by the host: migration 004 intentionally references
public and assistant, and is not compatible with applying the full list solely
to a non-public scratch schema.

## Verification

```sh
GOCACHE=/private/tmp/studio-assistant-go-cache go test -mod=vendor ./internal/modules/assistant/...
GOCACHE=/private/tmp/studio-assistant-go-cache go test -mod=vendor -race ./internal/modules/assistant/...
```

HTTP/use-case tests use an explicitly named fixture, validate responses against
the actual assistant JSON contract, and cover GLOBAL/no-project creation,
dual-owner isolation, kind filters, project/root soft deletion, paging/parameters,
idempotency and authorization failures. They do not
claim to validate PostgreSQL.

Real PG coverage is `TestPostgresAssistantPersistenceIsolationAndConstraints`
and `TestPostgresGlobalHistoryRestoreWithoutProjectDependency`, plus
`TestPostgresUserTextAppendConcurrencyRollbackReceiptAndRestore`.
It **skips** unless `TEST_DATABASE_URL` explicitly names a test database. The test
role needs CREATEDB; it creates/drops a unique disposable database and applies
001..004 there, never reads `DATABASE_URL` and never uses production defaults.
Run against the host-provided isolated PostgreSQL with:

```sh
GOCACHE=/private/tmp/studio-assistant-go-cache go test -mod=vendor -v ./internal/modules/assistant/adapters/postgres -run TestPostgres
```

The PG tests cover concurrent same-key creation (including uppercase UUID),
GLOBAL creation with zero projects, reconstructed repository/local-session
history recovery, kind filtering, Canvas deletion independent of GLOBAL,
restart persistence, stable/empty pages, literal keyword matching, owner FKs,
Router uniqueness, JSON parts/sequence constraints, deletion revisions and
preserved historical rows. Database errors are sanitized before reaching the
shared HTTP logger; no SQL values, credentials or user profiles are logged.
The supplied scratch environment must be run before claiming PG checks passed;
without TEST_DATABASE_URL the integration tests explicitly SKIP.

The append PG test adds same-key concurrent replay, different-key same-ETag
competition (one201), serial sequence allocation, actual transaction rollback
after message/root SQL or receipt SQL, runtime reconstruction/history recovery,
immutable receipt revisions, tampered receipt owner isolation, and hidden writes
after project/root soft deletion. Test cleanup drops only the exact randomly
named database created for that test; it does not sweep existing records.
