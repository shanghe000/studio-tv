# Canvas execution input revision boundary

Status: **IMPLEMENTED**. This additive extension documents acceptance of the
existing `expectedRevision` for opt-in single-node managed CANVAS and MEDIA
tasks. It adds no client-supplied authority or node version field and does not
modify the frozen OpenAPI contract.

An unrelated node edit, measured task progress or another node's completed
result can advance the global project revision between saving inputs and
submitting generation. Such an advance can now be accepted only when:

- `1 <= expectedRevision <= current project revision`;
- the complete requested and current target/input-closure `CanvasGuard` match;
- every closure node remains present and its private
  `last_changed_project_revision` is at most `expectedRevision`;
- the private project `last_node_order_changed_revision` is at most that receipt.

Node evidence uses the existing semantic version tracker: unknown data, model
inputs, selected histories/outputs and ordered incoming connections matter;
known progress, execution display state and layout do not. A change followed
by an undo, deletion/recreation under the same ID, or changed input connection
cannot regain the old receipt. Successful task acceptance also consumes that
target's receipt by stamping the claim revision, without changing the private
input versions needed by its worker.

Existing node order is a conservative project-wide boundary because
`CanvasGuard` includes ordered input nodes. Reordering common existing nodes
and restoring their order still requires a new receipt. Pure additions or
deletions elsewhere preserve surviving-node order and do not stamp that
boundary. The actual latest graph remains authoritative: task acceptance
patches that graph and preserves concurrent nodes, edges and worker results.

Snapshot PUT retains strong `If-Match` CAS. Task acceptance still holds the
project row lock shared with lease acquisition, checks current account/project
authority and leases, and freezes current private lifecycle versions. History
and asset checks and late-result writeback guards are unchanged. An existing
idempotent task receipt still follows its existing replay authorization path.

Migration `026_canvas_acceptance_revisions.sql` backfills existing nodes and
order evidence to the current project revision. This deliberately requires
receipts from before the migration to refresh once; it does not infer missing
historical evidence. Subsequent migrations do not restamp existing evidence.

Disposable PostgreSQL regression covers real other-node task progress and
completion, independent node/edge edits, additions/deletions, layout,
revision-only and legacy writes; refusal of future/zero revisions, changed
inputs/history/output, input/edge/order undo, same-ID recreation and reuse of
an accepted receipt; no task or plan persists on refusal. Upgrade and
idempotent migration behavior are checked against an existing project.
