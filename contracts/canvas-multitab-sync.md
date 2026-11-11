# Canvas replication for pages of one account — IMPLEMENTED

A project has one canonical graph in PostgreSQL. The exclusive writer is an
**account**, not a browser tab. Each connected document joins under its own
authenticated login, unguessable page proof and short-lived lease and confirms
an authoritative revision before writing. A second device does not need the
first device's local storage, and duplicating a tab does not duplicate its write
authority. A different account follows the explicit handoff protocol. See
[writer admission and operations](canvas-operations-extension.md).

## Persisted edits

1. The web page computes an ordered batch of node, edge and field operations.
   The browser keeps unacknowledged intent until it gets a receipt. A lost
   HTTP reply is not evidence of failed commit.
2. The API verifies the page, serializes the batch against the current project
   graph, and commits the graph, event and receipt in one transaction. Other
   pages' unrelated edits are therefore not replaced by an old page snapshot.
3. A project event insert emits a transaction-bound PostgreSQL notification.
   One LISTEN connection per API process wakes subscribed pages for that project;
   a missed notification is harmless because authorized event replay, not the
   notification, is the source of truth.
4. After its first authorized snapshot, a page can negotiate
   `X-STUDIO-Canvas-Update: delta-v1`. The open SSE room can then deliver a committed
   `canvas.delta` event: positions, changed or deleted rows, optional ordering
   and the current node task states. A routine move needs no extra snapshot GET.
   A page applies it only to the exact prior server document. If it missed a
   change or cannot validate the patch, it requests
   `/live-update?fromRevision=N`, or a full authenticated snapshot. Task updates
   or process restarts with no known operation chain safely use the full graph.
   It advances its cursor only when it can apply the result. A snapshot can
   cover several operations at once.
   Its current selection, pan and zoom are not instructions for other browsers.
   The event connection remains open across applied updates. If the stream
   is unavailable the page can catch up through finite JSON reads. A resumed
   background tab and a new computer converge from server state. A browser
   resume, return to visibility or restored network can wake a stale reader
   without remounting the canvas or abandoning unacknowledged work.

## Bounds

The migration publishes only a project ID for durable wakes. Missed wakes have
a one-second polling fallback; no cross-device latency is guaranteed outside
the measured environment. Each API process currently admits up to 8 streams
per account and 128 total. Excess pages use bounded replay and retry streaming.
The OS can suspend background pages altogether. A disconnected device cannot
show unsubmitted input from another disconnected device. Only the committed operation on pointer release changes the position on other pages.
