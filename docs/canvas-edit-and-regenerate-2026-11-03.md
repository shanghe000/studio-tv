# Canvas editing, synchronization and regeneration

## Behavior

Ordinary native video nodes rebuild references from current direct edges and
explicit mentions. Disconnecting an image removes it from the next generation;
reconnecting another image uses that image. The previous video, remote history
pointer and output selections remain intact. Text connections are composed once
with the authored prompt, including repeated generation on the same node.
Missing required references are reported before task submission.

The projection is limited to native single-node video forms. Direct API requests,
group plans, uploaded videos, storyboard and local tool results keep their
existing paths. Non-video nodes keep their original input discovery. Selected
source outputs determine model input limits; full-graph asset ownership and
availability checks still apply to cached assets.

Generation waits for buffered lease-protected edits before capturing an implicit
command. Explicit captured commands and later local input changes remain guarded.
Paste-and-connect operations acquire all existing affected endpoints before any
mutation, including endpoints removed by implicit edge replacement. A definite
NODE_EDIT_OCCUPIED response enables automatic replay after a connected presence
snapshot reports all required endpoints available. Real merge conflicts,
unknown failures, stale sessions and revoked access do not auto-replay.

On a definite save CAS refusal, the client can fetch and merge a newer snapshot
before retrying its original differences. Only its temporary CAS_UNCERTAIN marker
is ignored during that catch-up check; account, attachment, node identity and
semantic input checks remain active. Live synchronization automatically schedules
retained edits for saving once the blocked state is resolved.

Task acceptance no longer treats unrelated project revision advances as input
changes. Migration 026 records private semantic/lifecycle revision evidence;
the server requires identical input closure and valid evidence before accepting
an earlier saved receipt. See
[the revision extension](../contracts/canvas-execution-revision-extension.md).

## Verification

- Frontend: 171 test files, 3,292 tests passed, with type checking and builds.
- PostgreSQL: 63 targeted real-database cases passed, zero skips; disposable
  runner report `.local/iteration-01/20261103T143600-46b3cd59b27a/summary.json`.
- Frozen baseline: 1,198 assets unchanged. Contract suite: 66 tests passed.
- User guide: 5 sections and 130 images; automatic-resume example added.
- Browser: isolated Alice/Bob pages exercised real presence, mutation guards,
  storage, save scheduler, SSE and native sync bridge. An occupied source kept a
  paste-and-connect transaction pending; release automatically applied one local
  transaction and one PUT. Disconnect and reconnect to a different source kept
  the result node and converged on both pages and server. The fixture uses a
  minimal YMap/YArray manager, not production React/Yjs; no real model was called.
- Native video tests use the frozen composer and actual execution/storage adapters
  for connect, disconnect, reconnect, repeated generation, history selection and
  forged/late command refusal. They do not claim model-quality verification.

## Remaining consistency boundaries

Network transit is asynchronous; this is automatic convergence with concurrency
protection, not instantaneous identity between devices. Genuine same-field
conflicts remain recoverable instead of silently overwriting an editor. A lease
response does not yet carry a graph revision/event-cursor barrier; buffered replay
still relies on the mounted view, three-way merge and server CAS protection.
Reordering existing nodes conservatively invalidates older execution receipts
project-wide, including reorder followed by undo. Migration backfill requires
pre-migration receipts to refresh once. These conditions must not be described as
unconditionally conflict-free editing.
