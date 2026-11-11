# Canvas presence and short node ownership — IMPLEMENTED

This independent extension leaves the frozen v1.0.0 contract unchanged. It uses
verified `tv.access` requests and live local project roles. Cursor state is
transient, separate from the graph, generation inputs and undo history. The
current single API instance fans presence snapshots to authenticated SSE
subscribers; short node ownership is stored in PostgreSQL and checked under the
same project-row transaction lock as graph/command writes.

## HTTP operations

All paths begin `/api/v2/projects/{projectId}`. JSON operations use the existing
STUDIO envelope. Actor IDs, names, roles and session identities are server-owned;
requests containing those extra properties are rejected.

- `POST /presence`: `{clientId, cursor:null|{x,y}, selectedNodeIds:[]}` joins or
  renews one authenticated browser page and returns a snapshot. Both cursor
  coordinates are required, finite canvas-space numbers in ±10,000,000. At most
  32 distinct selected node IDs; 8 KiB body; the browser coalesces updates to 10/second, and the server enforces a
  minimum admission spacing of 75 ms per client. Heartbeats should run every
  5 seconds and renew only that page's existing unexpired node leases.
- `GET /presence?clientId=...`: complete JSON snapshot. Stream Accept requests
  on this route return 406; it remains an ordinary, bounded JSON API.
- `GET /presence/events?clientId=...`: authenticated fetch SSE with
  `Accept: text/event-stream`. Its `/events` suffix follows the existing
  long-stream latency-monitoring exclusions. `clientId` is optional, at most one;
  no other query or token-bearing query authority is accepted. This is ephemeral
  state, not graph event replay. Connect only after the page has joined.
- `DELETE /presence/{clientId}`: leaves the page, releases only that verified
  user/session/page's leases, returns snapshot. Other pages/accounts cannot
  release a holder by copying its publicly visible client ID.
- `POST /node-leases`: `{clientId,nodeIds:[...]}` acquires or renews an atomic
  batch of 1–32 existing persisted nodes. Requires a joined page and OWNER or
  EDITOR. All nodes are acquired or none; no partial batch success.
- `DELETE /node-leases`: same body, releases only matching owned nodes, returns
  snapshot. An empty node list is a no-op. OWNER/EDITOR/VIEWER may release their
  own remaining leases; dropping edit permission never enables new acquisition.

Project IDs and page client IDs use the existing 64-byte symbolic identifier
rules. Node IDs allow 1–200 ASCII letters/digits and, after the first character,
`_`, `-`, `.`, `:`. Node IDs are not names, prompts or media URLs. At most 64
active participant pages, 128 owned nodes/page and 2048 active leases/project.
Presence expires after 20 seconds without heartbeat; node ownership expires
15 seconds after its last renewal. Browser leave attempts release immediately;
crashes and broken networks rely on expiry. The backend never extends expired
ownership merely because a late cursor update arrives.

## Snapshot and events

```json
{
  "schemaVersion":"1",
  "projectId":"prj_example",
  "epoch":"server-instance-uuid",
  "sequence":"21",
  "serverTime":"2026-11-02T10:00:00Z",
  "presenceTtlMs":20000,
  "leaseTtlMs":15000,
  "members":[{
    "clientId":"page-example","userId":"usr_example",
    "displayName":"协作者","role":"EDITOR",
    "cursor":{"x":120,"y":80},"selectedNodeIds":["node_a"],
    "lastSeenAt":"2026-11-02T10:00:00Z"
  }],
  "leases":[{
    "nodeId":"node_a","clientId":"page-example","userId":"usr_example",
    "displayName":"协作者","expiresAt":"2026-11-02T10:00:15Z"
  }]
}
```

`sequence` is a decimal string version within `epoch`, including snapshot reads
that observe expiry or renewal. Restart replaces epoch. Clients fence old
requests/connections by authenticated identity, project, page and epoch; a late
response must not overwrite a newer snapshot. Expiry must also be enforced
locally using server time, even if no new frame arrives.

SSE uses `event: presence.snapshot` with the raw snapshot as `data`, without a
STUDIO envelope. It is coalesced to at most 10 frames/second, lifetime at most
30 seconds, 128 concurrent streams globally and 2 per authenticated account,
2 MiB maximum frame and 16 MiB maximum connection. The browser reconnects using
its normal authenticated fetch mechanism; cookies/bearers are never put in the
URL. Every snapshot rechecks local account/project role, and the composition
root's trusted session/tool reauthorization runs at least once/second and is
bounded by access/session expiry. Missing reauthorization/deadline support
returns 501. Revocation or identity changes close the stream with optional
`event: stream.error` data `{status,code,message,retryable}`. No private frame
follows a known failed check. Stream errors never include raw adapter failures.

## Authoritative mutation coordination

Interactive graph saves and generation/command acceptance send
`X-STUDIO-Canvas-Session: <clientId>`. The caller must acquire affected node leases
before editing. While holding the project's transaction row lock, the server
checks changed/removed nodes and both ends of changed connections, including
edge metadata carried by the native metadata node. Layout edits are protected.
Background generation result writeback is not an interactive peer edit.

An active holder is identified by verified user **and verified session and
page ID**. Another page of the same account is a different owner. With no
active lease, older clients remain compatible with existing graph CAS. With an
active lease, missing/mismatched client IDs cannot bypass ownership.

`409 NODE_EDIT_OCCUPIED` is a definite pre-write/pre-task refusal, with a safe
holder name and `details:[{field:"nodeId",code:"NODE_EDIT_OCCUPIED",message:
"node_a"}]`. Preserve the local draft and retry only after coordination;
do not convert this into `LOCAL_DRAFT_CONFLICT` or discard the edit. Version
checks, authorization, real semantic conflicts and task idempotency remain in
force. New nodes are saved before acquisition; claiming nonexistent IDs fails
with `404 CANVAS_NODE_NOT_FOUND`. Other bounds use 422, rate/capacity 429.

Ownership rows are ephemeral and cleaned on acquisition; expiry is authoritative
without cleanup. Presence does not store prompts, filenames, asset URLs or graph
contents. Session IDs used for ownership are never returned to subscribers.
