# Canonical canvas operations and editing on multiple pages of one account — IMPLEMENTED

### Project rooms (IMPLEMENTED)

A successful authorized live snapshot or live update advertises `X-STUDIO-Canvas-Room: ws-v1`. A browser can upgrade the same-origin route `GET /api/v2/projects/{projectId}/canvas-room` with subprotocol `studiotv.canvas.v1`. The first private frame is `{type:"join",token,after}`, where `after` is the decimal sequence of the last applied event. The service checks origin, live login, application capability and project read access before sending `ready`. Neither URL nor subprotocol contains credentials. The service and browser may negotiate standard per-message compression without a shared compression context.

Room writes use `{type:"write",requestId,body,proof,lease,baseRevision?}`. The body is the same immutable v2 operations batch used on HTTP. The optional outer revision requests a compact reply against a known graph. It grants no write authority. Each write uses the current login and project role, writer grant and page credentials, operation schema, graph/asset validation, database transaction and durable idempotency key of the HTTP route. A `receipt` returns the request ID, status, ETag when present and the canonical API response envelope.

Outbound `event` frames carry the existing event type, sequence and payload. A page advances its cursor only after applying the result. A disconnected room catches up from that cursor. A missing baseline or expired cursor causes a fresh authorized read. A client awaiting an uncertain receipt can send the original batch over HTTP. The holder's page, other browser sessions, worker updates, and older clients all use the same committed graph and event order. SSE and finite reads remain available while the room reconnects.

Peers may advertise `formats:["move-v1"]` in `join` and `ready`. A position-only update can then use one binary WebSocket frame, an ASCII tag followed by a UTF-8 JSON array. The `M` payload is `[requestId,batchId,clientId,proof,lease,observedRevision,compareRevision,receiptBaseRevision,receiptOnly,rows]`. Its positions are ordered `[nodeId,x,y]` triples that expand to the original x-then-y field patches. Missing revisions are JSON null. The first successful full position write may pin its credential tuple for this connection. Only a successful matching response with `bound:true` permits sending all three credential fields as null for that same tuple. All writes still validate the live page grant. New grants use full credentials. The pin never changes during a connection and never survives a disconnect.

A pure position event can use tag `E` with `[eventCursor,fromRevision,graphRevision,updatedAt,nodeExecutionAvailable,nodeStates,rows]`. It carries the same execution metadata and is checked against the same base as a normal canvas delta. Other writes and events keep their original payload, including one-axis edits which must not overwrite the other coordinate. Both frame shapes share the existing graph size limits, ordering and durable receipts.


Frozen OpenAPI v1.0.0 is unchanged. New service canvas clients use one server
document (`public.projects.graph`) and explicit ordered operations. They do not
send independent full-graph versions for three-way merging. Local pending
operations are durability protection until a server receipt confirms them;
they are not another authoritative document or a user-managed draft version.

All routes require a verified session and live `tv.access`. Reading session status requires project VIEWER. Requesting or transferring a lease requires OWNER or EDITOR.

## Account editing, page grants and handoff

One authenticated account holds the project's editing seat. Every tab and browser logged into that account may edit concurrently. Each document receives a separate 30-second page lease. A document sends its own `X-STUDIO-Canvas-Session` and `X-STUDIO-Canvas-Proof`; business writes additionally freeze the confirmed page lease in `X-STUDIO-Canvas-Lease`. Knowing another tab's client ID or lease does not authorize a write. Page proofs are bound to both the actor and the verified login. Lease expirations are independent; closing or refreshing one tab does not affect its siblings' ability to edit.

- Control requests send `X-STUDIO-Canvas-Protocol: account-pages-v1`. The server acknowledges with `protocol: "account-pages-v1"`. GET on `/api/v2/projects/{projectId}/edit-session` is read-only. A same-account page which can join an active account receives `FREE, canJoin:true`. A different account sees `OCCUPIED` with the holder's display name and may explicitly request access if it has the project EDITOR role. VIEWER never acquires a page lease.
- POST on that path with `{clientId, pageProof, requireSync:true}` issues an independent `SYNC_REQUIRED` reservation. The client applies the latest canonical graph and sends its revision and page lease to `/ready`. Only the resulting `HELD` page can write. Its heartbeat POST must supply that page's lease. A genuine reload obtains a new page grant; the former page cannot write using the replacement's lease. Lost responses and superseded tenants cannot revive a stale business request.
- POST `/requests` with a stable request ID creates an application from a different account. Any current confirmed page of the holder may decline or approve. APPROVE is sent only after sealing native input and confirming queued operations. A transaction immediately removes that page's grant, freezes new grants to the outgoing account and signals other confirmed pages (`accountHandoff:true`, `incoming[].drainRequired:true`) to automatically flush and acknowledge the same request. The waiting recipient continues polling by posting the original ID; a status GET never mutates ownership.
- The last acknowledgment, or a follow-up control request after the remaining pages expire, installs a new account tenure and one read-only reservation for the applicant inside a single project transaction. Renewals cannot extend the drain beyond 30 seconds. The recipient must still confirm its graph revision before editing. Canceling a pending application unfreezes the original account. Revoked, expired or stale requests cannot grant foreign access. A disconnected page's unacknowledged work remains subject to the existing device outbox rules.
- DELETE retires only the specified page's matching grant. Old-page DELETE, renew, acknowledgment, or generation responses cannot invalidate another page or overwrite future tenants.
- Rollout is per project under the canonical project row lock. An already-held, proof-backed older page is adopted with its existing page proof/lease and can finish editing. A stale or new old client cannot opt out of a project that has adopted per-account grants. While a pre-proof legacy holder is live, the pre-upgrade protocol remains in effect until its release or expiry. The old single-document resume/defer endpoints remain compatible for projects still using that protocol.

## Recovery of an interrupted page

Account-page receipts include optional `expiresInMs`, measured against the database clock. The browser calculates its local deadline from request dispatch. A transient status/renewal error does not invalidate a confirmed page before that deadline. A definite rejection or elapsed deadline stops writes and preserves pending operations. An eligible visible page automatically rejoins a free canvas and confirms the current revision. An occupied foreign canvas still requires explicit application and approval.

The v1 snapshot endpoint matches exactly one strong `If-Match` under the project lock. On an account-page project, a valid active page may change a full graph only against its own server-recorded base. If a sibling has changed that revision, a newly fetched ETag alone cannot authorize the old content. An active page can register its current base by submitting an exactly matching canonical graph without changing its revision. When a page term has expired, a body identical to the current full canonical graph can receive its read acknowledgement without any database change. A changed body can be committed only once within 60 seconds of expiry, using the original confirmed session, page ID, page secret and lease. It requires the same account tenure, an exact base revision recorded by the server at that page's successful `/ready` or earlier active v1 save, a valid login and project role, zero active pages, zero pending applications, and no handoff. Saving does not extend an expired term. A new write, replacement page, cancellation of that page, permission loss or another account's takeover cannot be bypassed by guessing a new ETag. Existing rows without a proved base are never backfilled. A pre-account-protocol page retaining its identity may request fresh admission and must confirm the latest graph before editing again. Other unverified legacy snapshots receive `CANVAS_PAGE_UPDATE_REQUIRED`.

After verifying edit admission, the web adapter may recover a legacy journal in the same browser and account/project. It applies explicit before/after edits as idempotent v2 operations against the currently confirmed revision, never an old whole document. Unnumbered successors need an unambiguous predecessor; an independent unnumbered record with an explicit continuous history can restore existing-node fields only, subject to the earliest deletion fence. Overlapping remote edits, ambiguous history and unresolved local media stay on the device without suspending the current canvas. A committed write with a lost response is identified by its stable batch ID.

Rejected v1 snapshot, v2 operation, and node-lease writes record only the credential shape (`canvas_write_context`) and, for UUID-based projects, `canvas_ref` (first 12 SHA-256 bytes of the exact project ID, lowercase hex). Never log the page secret, lease, request body or project URL.

## Ordered operations

POST `/api/v2/projects/{projectId}/canvas-operations`:

```json
{
  "schemaVersion": "1",
  "batchId": "op_unique_batch",
  "clientId": "page_id",
  "operations": [
    {"type":"node.create","node":{"id":"image","type":"rh-image","position":{"x":300,"y":0},"data":{}}},
    {"type":"edge.create","edge":{"id":"edge","source":"source","target":"image","sourceHandle":"output","targetHandle":"input"}},
    {"type":"node.patch","nodeId":"image","set":[{"path":["data","params","prompt"],"value":"A fox beside a cup"}],"unset":[]}
  ]
}
```

`node` and `edge` are stored ProjectGraph rows produced by `encodeGraph`,
including the reserved `rhtv_meta_v1` extension node where needed. All operations
in a batch apply atomically under the canonical project database row lock.
There is no `expectedRevision` or client full-graph overwrite. The server applies
only explicit intent to its latest document, then returns its actual stored
snapshot after existing task-binding triggers have normalized it.

Supported operation shapes:

- `node.create {node}` and `edge.create {edge}`: create a stable ID; identical
  existing rows are no-ops, differing existing rows return 409
  `CANVAS_OBJECT_EXISTS`.
- `node.patch {nodeId,set:[{path,value}],unset:[path]}`: modify only named leaf
  fields; permitted first segments are `data`, `position`, `type`. Node identity
  cannot be changed. Unverified missing nodes return 409 `CANVAS_NODE_MISSING`; they are
  never recreated by a patch. Array values are atomic, not positional splices.
- `node.delete {nodeId}`: delete the node and its incident edges. Missing IDs
  are no-ops. Other grouped-node references must be repaired in the same batch.
- `edge.delete {edgeId}`: delete only that edge; missing IDs are no-ops.
- `nodes.order {nodeIds}` / `edges.order {edgeIds}`: order listed current rows,
  then retain unlisted server rows in their original relative order. Missing
  listed IDs are skipped; duplicate listed IDs are rejected.
- `graph.patch {set,unset}`: patch only `viewport` paths.

A body is at most 2 MiB with 1–2048 operations. A patch contains 1–2048 changes,
each with 1–32 string path segments. Prototype keys, invalid path components,
unknown fields and irrelevant nonempty operation fields are rejected. Field
type changes in an intermediate path return 409 `CANVAS_FIELD_TYPE_CHANGED`.
The final graph uses the existing frozen graph schema and shared secret/media,
group-reference and asset-authorization validators. It is bounded to 500 business
nodes (excluding the single validated `rhtv_meta_v1` / `__rhtv_meta` metadata row),
2000 edges and 2 MiB, and may not contain self-edges, duplicate source/target
pairs or directed cycles. Rejected batches create no node, edge, receipt, event
or task. Model generation remains a separate explicitly authorized operation.

New batches require the caller's unexpired, confirmed page grant for the current writer account, otherwise 409
`EDIT_SESSION_EXPIRED` or `PROJECT_EDIT_OCCUPIED`. Receipt replay occurs after
authorization and current client-header validation, but before checking writer
expiry. This permits confirming a previously committed request after reload.

Idempotency is persisted by `(projectId, verified actorId, batchId)`. Its hash
covers `schemaVersion` and `operations`, excluding the current `clientId`.
The persisted receipt contains only bounded acceptance metadata
`{schemaVersion,batchId,originClientId,acceptedRevision,acceptedAt}` and the
request hash. It never contains graph copies, operation values or historical
canvas versions. Replaying the exact batch confirms its original accepted
effect against the **current canonical snapshot**, without applying it again.
Reusing the ID for other operations returns 409
`CANVAS_OPERATION_ID_REUSED`. A replay never resurrects a node deleted later.

The 200 STUDIO envelope's `data` is
`{projectId,revision,graph,updatedAt,eventCursor,batchId,clientId,acceptedRevision,acceptedAt}` with a strong
revision ETag. `clientId` identifies the original accepted page on replay. The
original `acceptedRevision` remains stable, while `revision` and the graph are
read from the latest locked server document even on replay. HTTP requests may
still arrive out of order, so clients must not regress a newer canonical view.
`eventCursor` is a decimal string. Existing durable canvas events notify other
readers and task writebacks, with the same canonical graph and revision stream.
Operation receipts persist across API restarts; no automatic retention policy
is introduced in this extension.

When recovering an outbox, optional `baseRevision` is checked on an unseen batch before applying operations. A `receiptOnly:true` request asks for an existing receipt and cannot mutate the project. Both controls are excluded from the immutable operation digest. Conflicting offline intent is retained separately on the originating device, and unrelated changes can still be recovered against a matching input proof.


### Deletion wins over a stale drag or connection

A negotiated client captures optional `observedRevision` at the native observation that produced a batch. It persists and retries the original value with the same batch ID. This field is part of the immutable digest when supplied. It is separate from `baseRevision`, the strict compare-and-swap precondition for recovery. A newer server revision alone does not make a deletion conflict.

PostgreSQL records the last revision that actually deleted each node or edge. Under the canonical project lock an older node move/patch, create, delete, or edge creation involving a since-deleted endpoint is superseded. A since-deleted and deliberately re-created ID represents a new incarnation; late edits cannot overwrite it. Native metadata belonging to an omitted edge is also removed. Other operations in the same batch are validated and applied. Invented missing targets, malformed commands, invalid topologies and unauthorized asset references are still rejected. A fresh undo or reconnect based on the deletion revision may deliberately recreate an object. The persisted receipt returns optional `supersededOperations` (whole operations omitted), retains `acceptedRevision` even for a no-op, and replays without duplicating the other edits. A client without the new observation field retains strict legacy semantics.
