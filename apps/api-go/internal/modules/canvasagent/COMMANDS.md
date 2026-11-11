# Implemented canvas command slice

`POST /api/v2/projects/{projectId}/canvas-commands` and
`GET /api/v2/projects/{projectId}/canvas-commands/{commandId}` implement the
first manual user-token command slice described by
`contracts/canvas-commands-implemented-extension.json`. The larger
`agent-canvas-extension.json` remains DESIGN / RESERVED.

The host supplies verified identity and live `tv.access` through `Protect`.
Composition uses `NewCommandService(NewCommandUnitOfWork(pool),
core.ValidateProductGraph)` and `RegisterCommandRoutes(router, service, protect)`.
Domain and application code do not depend on core or HTTP.

Supported operations are `node.create`, `node.updateInputs`, `node.move`,
`node.delete`, `edge.create` and `edge.delete`. Input schema version `1` allows
ordinary `rh-text` nodes to accept `title`, `text` and `prompt`; ordinary
`rh-image` and `rh-video` nodes accept `title` and `prompt`. Title/text map to
`data.title`/`data.text`; prompt maps to `data.params.prompt`. Existing
`generatedText`, execution status, task IDs, metadata and native extensions are
preserved. Special tool subtypes cannot use the ordinary input schema. Edges
currently support only null default handles between these node types. Other
operations, versions, node schemas and explicit ports return501.

Requests require a positive strong If-Match and a nonzero canonical UUID
Idempotency-Key. Idempotency scope is owner/project/operation/key; request hash
freezes the project path, body and original If-Match. Exact replay returns the
historical receipt before CAS, while rechecking that the current user still owns
an undeleted, visible project. Changed requests with the same key return409 and
new-key stale revisions return412. No-op batches return422.

A batch may create or delete a particular node ID only once. Deleting and
recreating the same ID, or creating and deleting it, in one batch returns422,
even when other operations would change the final graph. Submit each lifetime
change as a separate command after receiving the preceding command's receipt;
this keeps intermediate deletions visible to execution bindings and replay.
Moving or editing a node alongside its single create/delete remains supported.

The project row lock protects graph revision and per-project event sequence.
Final graph validation and owned READY asset checks precede one transaction that
updates the graph, adds the immutable normalized receipt and appends the actual
`canvas.changed` event. Any failure rolls back all three. A node deletion also
removes its related edges. The command surface does not accept arbitrary data
merges, outputs, model parameters, asset binding, owner/source claims or reserved
meta edits. All `agentContext` input returns501 until a trustworthy pending
run/tool-call registry exists.

Migration `014_canvas_commands.sql` adds `projects.event_sequence`,
`canvas.command_receipts` and `canvas.project_events`. Migration
`016_project_event_replay.sql` adds atomic invalidation for every existing
ordinary-project graph/revision/soft-delete writer, including legacy v1 saves
and organization moves/bulk deletion. Graph changes that omit a revision also
advance the revision. Revision-neutral name/cover/pin changes retain their v1
behavior and do not create graph events. Internal asset projects stay private.

`GET /api/v2/projects/{projectId}/live-snapshot` returns the persisted graph,
graphRevision, updatedAt, eventCursor and current server node bindings in a
repeatable-read transaction. `nodeExecutionAvailable=true` covers the opt-in
single basic text/image/video/audio node writeback path. `nodeStates` requires
matching owner/project task and plan evidence plus a present current node
incarnation; edited, deleted or recreated stale bindings are omitted.
Client-persisted graph status/task/output fields do not supply execution
authority. Older service responses with false and an empty list remain readable.
`GET /api/v2/projects/{projectId}/events` returns authenticated JSON replay,
with canonical decimal `after` (default 0), optional matching Last-Event-ID and
`limit` 1..100 (default 100). Each request repeats current login/tv.access and
owner checks. `Accept: text/event-stream` selects bounded SSE with live Bearer,
session and scope revalidation before every page. Streams are limited to 30s,
1024 events/8MiB, two connections per owner and 128 per process. The independent
canvas-sync contract defines replay, heartbeat, expiry and control errors.

Replay pages stop at 2MiB of event payloads and expose nextCursor, hasMore and
the read transaction's eventCursor. Current events are bounded at 1MiB; large
command deltas persist canvas.invalidated/DELTA_TOO_LARGE and retain their full
receipt. Oversized immutable historical canvas.changed evidence is projected
as the same-sequence invalidation. No retention policy or cursor expiry exists;
missing/unimplemented/corrupt evidence returns retryable503, ahead cursors409.
The deferred database constraint requires matching evidence for each cursor
advance, so a future writer cannot reserve a sequence and commit without an
event. Only canvas.changed/canvas.invalidated are public in this slice.
Managed binding/state changes advance the project revision and event cursor in
the same transaction, including REVISION_ONLY invalidations with unchanged graph
content. Consumers refresh the consistent snapshot for authoritative node state.
Trusted Agent execution remains reserved; the basic-node writeback capability
does not implement an Agent tool loop or arbitrary canvas/group result mutation.
Web now consumes bounded replay/SSE and incrementally applies coherent snapshots
through the original Yjs manager, protecting pending drafts and active edits.

Real PostgreSQL integration requires an explicitly supplied TEST_DATABASE_URL
naming a test database and a disposable role with CREATEDB. Tests create and drop
their own isolated databases and never default to DATABASE_URL or production.
