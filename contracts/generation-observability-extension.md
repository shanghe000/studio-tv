# Generation diagnostics extension — IMPLEMENTED

POST `/api/v2/generation-diagnostics`, verified session + live `tv.access`,
project EDITOR authorization. Frozen v1.0.0 contracts are unchanged.

Body (16 KiB maximum, unknown fields rejected at every object level): `projectId`, `nodeId`,
`errorCode`, optional `sceneCode`, `preflight`, `clientSnapshot` and `relatedRequestId`. IDs use ASCII letters/digits/`_.:-`, maximum
160 characters. Error code is uppercase symbolic, maximum 64 characters.
Scene, if present, starts with `canvas-`. No free text, prompts, stacks, tokens
or URLs are accepted. This is client diagnostic evidence, not task mutation.

`preflight` is an optional versioned object. Older clients that omit it remain
valid; absence means the original model/input context was not supplied and must
not be inferred from a later graph. Example:

```json
{
  "projectId": "prj_example",
  "nodeId": "node_target",
  "errorCode": "MEDIA_INPUT_INVALID",
  "preflight": {
    "schemaVersion": "1",
    "capabilityRef": "h3-motion-transfer-v1",
    "capabilityVersion": "2",
    "requestedKind": "IMAGE_TO_VIDEO",
    "inputKinds": ["IMAGE", "VIDEO"],
    "issues": [{
      "field": "media.durationMs",
      "reason": "MAXIMUM_EXCEEDED",
      "inputKind": "VIDEO",
      "inputIndex": 1,
      "assetId": "ast_example",
      "sourceNodeId": "node_source",
      "actual": 55519,
      "maximum": 30000
    }]
  }
}
```

The selected `capabilityRef` is a symbolic ID (160 characters maximum),
`capabilityVersion` a symbolic version (100 maximum). `requestedKind` is an
uppercase symbolic capability kind (64 maximum). `inputKinds` and each issue's
`expectedKinds` contain at most six distinct values from `TEXT`, `STRUCTURED`,
`IMAGE`, `VIDEO`, `AUDIO`, `UNKNOWN`. They describe types, never contents.

`issues` has at most 16 objects. `field` is one of `model.kind`, `output.kind`,
`inputs.kind`, `inputs.command`, `inputs.snapshot`, `references.kind`, `references.count`, `references.total`,
`references.visual`, `references.any`, `references.upload`, `media.byteSize`,
`media.durationMs`, `media.totalDurationMs`, `media.width`, `media.height`,
`media.pixels`, `parameters`. `reason` is one of `KIND_UNSUPPORTED`,
`KIND_MISMATCH`, `OUTPUT_UNSUPPORTED`, `REFERENCE_FORBIDDEN`, `COUNT_EXCEEDED`,
`COUNT_REQUIRED`, `REFERENCE_REQUIRED`, `UPLOAD_PENDING`, `UPLOAD_FAILED`,
`MAXIMUM_EXCEEDED`, `MINIMUM_NOT_MET`, `METADATA_MISSING`, `PARAMETER_INVALID`,
`MODEL_UNAVAILABLE`, `MODEL_VERSION_CHANGED`, `COMMAND_MISMATCH`, `INPUT_CHANGED`.

Consistency rejections distinguish `inputs.command` (native command projection)
from `inputs.snapshot` (a later current-input change). Optional `component` is
one of `MODEL`, `PROMPT`, `REFERENCES`, `PARAMETERS`, `PRESETS`, `HISTORY`,
`OUTPUT`, `TOPOLOGY`, `IDENTITY`, `PERMISSIONS`, `METADATA`. It identifies the
affected input section without recording arbitrary field paths or values.

Canvas synchronization rejections may include `sync` with a required
`blockedReason` (`MERGE_CONFLICT`, `BASE_UNKNOWN`, `CAS_UNCERTAIN`), an optional
integer `generation` (0 to 2^53−1) and at most 16 `conflicts`. Generation is a
client synchronization-check sequence, not a server graph revision. Each
conflict has a required symbolic `reason` (`FIELD_CHANGED`, `DELETE_EDIT`,
`MODEL_PARAMETERS`, `GROUP_POSITION`, `DANGLING_REFERENCE`, `BASE_UNKNOWN`), a
required `component` from the existing set above, and an optional safe
`sourceNodeId`. Raw graph paths, local/remote values and prompts are never sent.
Unknown fields are rejected within both nested objects. Logs retain these
bounded claims; notifications show the synchronization reason and affected
section. An absent model/version remains absent rather than being inferred
from a later server graph. `LOCAL_DRAFT_CONFLICT` notifications are titled
“Studio TV 画布同步待完成” and state that generation was not submitted and local
changes were retained, without directing users into routine draft/version
handling. Automatic retries retain their separate classification.

Parameter failures (`field: "parameters"`, `reason: "PARAMETER_INVALID"`)
may additionally include `parameterPath` and `parameterRule`. The path has at
most 12 segments: reviewed public parameter-name tokens or zero-based array
indices from 0 to 9999. For example, `["subjectMapping", 1,
"referenceSubjectIndex"]` identifies the second character pairing's reference
index. The browser derives segments only from schema-declared properties,
required names and array items, including local references and composition
branches. Unknown `additionalProperties` keys are omitted; only their declared
parent path may be recorded. Parameter values are never included.

Both browser and server enforce the fixed token and rule sets in
[`generation-diagnostics-extension.schema.json`](generation-diagnostics-extension.schema.json).
Rules distinguish `required`, `type`, `enum`, `minimum`, `maximum`, nested
collection constraints, schema composition and an unsupported schema. A future
schema property not in the reviewed token list records the rule without that
name. No catalog network request is needed to record the rejection. These are
bounded client claims, not server verification that the reported field exists
in a particular model version. Notifications render public names in Chinese
and array positions as “第 N 项”; logs retain the symbolic path and rule for
searching. Existing clients that omit both fields remain valid.

Each issue may include an `inputKind` from the same type set, zero-based
`inputIndex` (0–9999), symbolic `assetId` and `sourceNodeId`, and numeric
`actual`, `expected`, `minimum`, `maximum`. Numbers must be finite, nonnegative,
at most 2^53−1; minimum cannot exceed maximum. Units follow the field: bytes,
milliseconds, pixels, or item counts. File names, raw model parameters and
arbitrary error messages are deliberately excluded.

The lifecycle record stores `preflight_source: "client"` and the complete
validated `preflight` object. Main `capability_ref`/`capability_version` fields
reflect the reported selection, including an unavailable/historical selection;
they are not proof that the provider accepted a request. The notification
renders a safe explanation from the symbolic reason and numeric facts. Its
deduplication key distinguishes node, model/version and issue facts; repeated
unchanged rejection is bounded by the existing minute window. All accepted
diagnostics are logged even when a duplicate notification is suppressed.

When the existing production log mount is enabled, `generation.log` retains
these records across API/container replacement using daily files and the
existing 90-day rotation policy. Docker stdout rotation is independent. Neither
log is a permanent archive, and a disconnected browser cannot deliver a report.

202 standard STUDIO envelope: `data: {"logId":"<trusted server UUID>"}`.
400/422 malformed body; 401 unauthenticated; project authorization errors follow
existing non-disclosure rules. Feishu notification is asynchronous and bounded;
202 means diagnostic recorded/notification attempted, not delivery guaranteed.


A version 1 `clientSnapshot` describes the active submission. It records the
control, stage, target type, selected and adjacent nodes, coordinates and drag
flags, counts of outputs and presets, and sync status. `target`, `parent` and
link endpoints are zero-based indexes into that observation’s graph. The
target, parent, directly connected nodes, group children and remaining selected
nodes are sampled in that order, up to eight nodes and twelve links. Totals
describe the full graph. The web client projects fixed symbols, numbers and
booleans at the time of the attempt. A queued target present only in the
command uses that command as the source. Optional `projection` compares the command and mounted target, the `maxConnect` shape, input order and counts of changed upstream endpoints. At failure time, `dom` observes only the target node or its associated control. It records drag, selection, busy overlay, cancel, generate, ARIA-disabled and read-only booleans. This can distinguish a finished canvas node from a still-running browser overlay. The optional `click` records button visibility and disabled state at explicit activation. Only the ensuing native request for the same authenticated page, target and operation consumes this intent; a new gesture, a detached page or expiry discards it. Direct API commands keep the COMMAND control. Capture is triggered by an actual
failed submit or an explicit blocked generation click.

The server logs the verified projection under `client_snapshot`. For a backend
rejection, `relatedRequestId` links supplementary evidence to the original
HTTP request. Search `log_id` and `related_request_id` together and match the
project and actor. The latter field is a client-reported UUID. These linked
events and transport failures after dispatch use `CLIENT_SUBMISSION_SNAPSHOT`
without triggering another generation alert. The browser preserves the original
HTTP ID. Preflight reports continue returning their own server-generated ID.
