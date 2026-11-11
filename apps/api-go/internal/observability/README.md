# Studio TV request logs and Feishu alerts

`New(Config) (*Observer, error)` creates a standard-library `slog` JSON logger
and, when `WebhookURL` is configured, one bounded asynchronous delivery worker.
It does not send a startup notification. The composition root owns configuration
and calls `Close(ctx)` during shutdown.

```go
observer, err := observability.New(observability.Config{
    ServiceName: "studiotv-api",
    Environment: "deployment-host",
    ServerName: "deployment-host",
    WebhookURL: webhookFromPrivateEnvironment,
    ErrorCode: httpapi.ErrorCode,
    RecordError: httpapi.RecordError,
})
```

The trusted request context must precede the request observers. Register inside
`chi.Router.Use` in this order so chi's final nested route template is visible:

1. Trusted `httpapi.RequestContext` (UUID and shared diagnostic state).
2. Metrics middleware.
3. `observer.Middleware` (including panic recovery).
4. CORS/security middleware, then application routes.

`Config.ErrorCode` and `Config.RecordError` are composition-root callbacks; this
package does not change the HTTP error writer or application ownership rules.
Task logs use a stable UUID derived from the persisted task ID, including after a worker restart. The ACCEPTED record links this task log_id to the initiating HTTP request_id. Workers propagate that task log_id to the Router.

Only canonical UUIDs from the trusted context are reused. Incoming `log_id`,
`X-Log-ID`, and `X-Request-ID` headers never become log IDs. All three response
headers carry the server-generated ID; JSON records contain the same `log_id`
and `request_id`. `LogID(ctx)` exposes that ID for an application key event.

Every completed request records service/source/server, HTTP method, route
template, response status, elapsed milliseconds, response byte count, symbolic
error code, and cancellation/panic flags. Unknown routes use `unmatched`, never
the raw path. Request/response bodies, queries, headers, cookies, identities,
tokens, webhook URLs, panic values/stacks and model prompts are not captured.
`Logger()` exposes `*slog.Logger` for **static messages and safe metadata only**;
common sensitive attributes and error objects are redacted as a second guard.
Arbitrary free-form business messages still require review by their author.

Ordinary non-generation 4xx, request context cancellation/deadline expiry and `http.ErrAbortHandler`
do not notify the group. HTTP 501 is an expected unsupported operation: it logs
at warning level without notifying. Generation submission 4xx and 501, other 5xx and recovered application panics
notify with the IPAC-visible fields: title, source, log ID, API, information and
server. An uncommitted panic returns a generic correlated HTTP 500. A panic
after headers/body have been committed records the actual status and then
raises `http.ErrAbortHandler` to terminate the truncated stream, without adding
JSON or revealing the original panic. A hijacked connection is closed on panic.
Flush, Hijacker and Pusher capabilities are preserved where supported;
`ResponseController` can unwrap for deadlines/full-duplex control.

Defaults are a 128-message queue, one worker, five-second delivery timeout,
one-minute suppression window, and at most 1024 deduplication keys. Suppression
uses method + route template + status + symbolic error code (and event kind);
changing the request ID cannot defeat it. Saturation drops the notification,
increments `Stats()`, and logs a fixed safe warning without blocking a request.
There are no automatic delivery retries. Normal request alerts use a worker-owned
context; explicit checks follow their caller's cancellation. Shutdown rejects
new work and drains pending work until its supplied context expires.

`KeyEvent(ctx, "SYMBOLIC_EVENT_CODE") error` queues a bounded symbolic key event.
Its success means **queued**, not delivered. `Check(ctx) error` (also exposed as
`TestNotification`) sends one fixed acceptance message and waits for an actual
HTTP 200 and a successful Feishu `code: 0` (or legacy `StatusCode: 0`) response.
Disabled notifications, queue saturation, suppression, canceled checks, and
delivery failure return distinct safe errors; endpoint URLs and remote response
bodies are never returned. The operator should invoke the check once explicitly.

The webhook is supplied from a private environment/secret file; it must never be
committed or printed. HTTPS is required except loopback HTTP used by unit tests;
credentials in URL userinfo, query strings and fragments are rejected. Redirects
are not followed, and acknowledgement bodies are capped at 4 KiB.

File output reuses **g004_biz's Logrus v1.9.3 + file-rotatelogs v2.4.0** engines
and daily symlink/90-day retention convention, through a redacting slog boundary.
The game framework's private config/uctx/Graylog dependencies are not imported.
`STUDIOTV_LOG_DIR=/var/log/studio-tv` enables JSON file output plus stdout:

- `api.log` -> `api.log.YYYYMMDD`: requests and lifecycle records.
- `generation.log` -> `generation.log.YYYYMMDD`: generation lifecycle records.

Production binds this directory to `/home/user/apps/studio-tv/var/log/studio-tv`
on deployment-host. The directory is owned by UID 1000, mode 0750. Startup rejects an
unwritable directory. The deployment script creates it before recreating API.

Execution Store records only committed acceptance, plan transitions/invocation
receipts, task states, and cancellations; lost leases and rolled-back saves do
not emit false successes/failures. This covers Canvas, Assistant (including
homepage image/video), App, Media/Sketch and Studio tasks. Agent runs and tool
results have their own committed lifecycle records. Retryable upstream errors
and persistence failures also record safe symbolic errors. Background FAILED
and TIMED_OUT outcomes notify even though their initial HTTP request was 202.
Repeated terminal saves cannot produce a second committed transition; the alert
queue additionally suppresses the same task/scene/error within one minute.

Generation notifications use distinct lifecycle titles. `UPSTREAM_RETRY` /
`RETRY_PENDING` are **Studio TV 任务自动重试** and explain that the task continues;
`CLIENT_PREFLIGHT` + `LOCAL_DRAFT_CONFLICT` is **Studio TV 画布同步待完成** and explains
that no generation was submitted and local changes remain preserved. Its
optional bounded `preflight.sync` context identifies a merge conflict, unknown
base or unconfirmed save, with symbolic affected components rather than graph
paths or values. Other preflight rejections are **Studio TV 提交未通过**.
Only terminal FAILED/TIMED_OUT outcomes use **Studio TV 生成失败**. SUCCEEDED cannot
emit a failure alert even if an earlier observation carried Notify. Retry and
preflight records use warning severity; their actual task states are unchanged.
Draft-conflict alerts deduplicate by initiating actor and project within the
existing minute window, including repeated attempts on different nodes. Every
structured lifecycle record remains; a later real terminal failure has a
separate notification key and is never hidden by the earlier reminder.

`POST /api/v2/generation-diagnostics` records **client-reported** canvas preflight
rejections before an execution request exists. It requires a verified user with
project EDITOR access, accepts only bounded symbolic metadata (16 KiB maximum),
returns the server-generated logId, and never accepts stacks/prompts/bodies/URLs.
It marks browser evidence as client-reported. Explicit failed attempts may include a bounded
`client_snapshot` of the selected node and its immediate topology. Errors carrying a
server request ID attach a separate log-only client snapshot with `related_request_id`
set to that ID. Match that field or `log_id`, project and actor. Network loss
can prevent client diagnostics from reaching the server; the original error is
preserved and the report attempt is bounded to two seconds.

Optional `preflight` schema version 1 records the selected capability/version,
requested kind, actual input kinds and up to 16 specific input issues. Each
issue uses allowlisted field/reason codes, optional source-node/asset/index,
and finite nonnegative actual/expected/minimum/maximum facts. Units are encoded
in field names (bytes, milliseconds, pixels, or counts); filenames, prompts,
URLs, stacks and raw parameter values remain excluded. Unknown nested fields
are rejected. Old clients without this object remain accepted, without
inventing missing history. See `contracts/generation-observability-extension.md`
for the complete wire schema and example.

Canvas consistency diagnostics additionally distinguish native command projection
(`inputs.command` / `COMMAND_MISMATCH`) from a later input change
(`inputs.snapshot` / `INPUT_CHANGED`). The optional allowlisted `component`
identifies model, prompt, reference, parameter, topology, identity, history,
output or metadata differences without accepting user-defined paths or text.

Structured records mark `preflight_source=client`; main capability fields retain
the reported model/version, not a verified provider invocation. Notifications
explain the concrete issue and measured limits. Different nodes, model versions
and issue facts do not suppress one another; unchanged duplicate clicks still
use the existing rate window. Every accepted record reaches the existing
`generation.log` when `STUDIOTV_LOG_DIR` is configured. The production host mount
preserves those daily files across container updates under the existing 90-day
rotation policy; Docker stdout is a separate bounded log, not an archive.

Generation records include `actor_id`, taken from the persisted task initiator
(`InitiatedBy`, falling back to the owner for legacy tasks), the Agent run owner,
or the verified preflight caller. Shared-project storage ownership is not used
in place of the actual initiating member, and browser graph fields cannot
supply this identity. All ordinary lifecycle records carry this ID without a
directory lookup. At alert stages, `actor_name` is resolved from Studio TV's local
`public.users.display_name` with a 250 ms deadline, including for canceled
request contexts. No extra IPAC/Feishu identity request is made. Feishu generation
alerts display separate **操作人** and **用户ID** lines. A missing/deleted profile
or unavailable database preserves the ID and original error, displaying
**姓名暂不可用**; an absent actor is explicitly **未知操作人**. Names are plain text,
bounded to 80 Unicode characters with controls/formatting removed. They reflect
the directory at alert time, not a historical name snapshot. Actor IDs and names
are never added as Prometheus labels. Preflight deduplication includes actor ID
so different employees' same-code failures are not conflated.

Generation records also include task/project/node/execution/capability/version/scene/
invocation IDs, stage/state/error_code, elapsed_ms, output_count, log_id and
request_id. Feishu acknowledgements/failures are logged with log_id. Delivery is
bounded and best-effort, **not a durable notification outbox**: an outage, full
queue or process termination can lose an alert, while file/task records remain.
