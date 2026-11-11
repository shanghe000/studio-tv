# Studio TV metrics integration

`New()` owns a private Prometheus registry. Install `Server.Middleware` with
`chi.Use` before the application's recovery middleware. The existing router
must expose the chi route context; wrapping a router outside chi cannot recover
its pooled context after return and yields `route="unmatched"`.

Register the application pool once with `RegisterPool(pool)` and expose
`Server.Handler()` through the separate internal listener. No routes, listeners,
authentication configuration or business responses are created by this package.
Scrapes are limited to two concurrent handlers with a five-second timeout.

HTTP counters, body-byte counters and duration histogram use only `method`,
`route` and `status_class`. Methods are a fixed HTTP-method allowlist plus OTHER;
routes are registered templates found in chi's routing tree, or unmatched;
status classes are 1xx–5xx or other. Duration includes SSE lifetime, so use a
route filter for ordinary-request latency panels. Direct writes to a hijacked
connection and response header bytes cannot be measured as response body bytes.

Pool collection reads one in-memory statistics snapshot per scrape. It exports
connection gauges for acquired/idle/total/constructing/max and cumulative acquire,
canceled-acquire, empty-acquire, acquire-duration, new-connection and destruction
counters. It performs no SQL, ping or connection acquisition and has no database,
user, query, or connection-string labels. Go and process collectors use their
standard names. `up` is produced by Prometheus, not this package.

Optional `WrapTransport` instruments only explicitly wrapped HTTP transports.
Its dependency allowlist is ipac/models_router/unknown; outcome is
response/error/canceled. It measures time until response headers, not body
consumption. It does not record URLs, bodies, credential headers or error text,
and makes no upstream requests by itself.

Generation queue telemetry is attached by `Runtime.WithMetrics` and sampled
immediately, then every five seconds with a three-second query deadline. The
runtime waits for this background goroutine before closing the database pool.
Scrapes only read its coherent in-memory snapshot; they never perform SQL.

- `studiotv_generation_tasks{kind,capability_family,state}` counts each persisted STUDIO
  task once. State is queued/running, kind is canvas/assistant/media/sketch/studio/
  other, and capability_family is h3/other. A task belongs to h3 if any of its
  saved plans uses an `h3-` capability. This includes work queued inside STUDIO before
  Router submission; several H3 plans in one task do not multiply the task count.
  Running includes upstream execution, polling, and result import, so it is not
  the number of busy GPUs. Delayed retries and worker leases are not excluded.
- `studiotv_generation_oldest_queued_age_seconds{kind,capability_family}` starts from
  the database clock and advances between samples. Empty queues export zero.
- `studiotv_generation_queue_sampler_up` is one only after the latest read succeeded.
  `studiotv_generation_queue_last_success_timestamp_seconds` allows freshness checks.
  Both start at zero. Failed samples retain previous counts and their timestamp,
  rather than misleadingly reporting an empty queue; panels must gate queue
  values on sampler_up and freshness (for example less than 30 seconds old).
- `studiotv_generation_queue_sample_duration_seconds` includes successful and failed
  reads. `studiotv_generation_queue_sample_errors_total` counts read failures without
  recording their error text. Normal context cancellation during shutdown does
  not count as a failure.

All group combinations have explicit zero series, and every label has a fixed
allowlist. No task, project, owner, prompt, or invocation identifiers are exposed.
These metrics measure STUDIO's queue independently of Router and H3/Comfy queues;
the three layers must not be added together because they overlap.

Dependencies are pinned and vendored. Prometheus client_golang v1.23.2 was
verified against its [official release](https://github.com/prometheus/client_golang/releases/tag/v1.23.2).
The isolated-registry pattern follows the [official Go guide](https://prometheus.io/docs/guides/go-application/).
httpsnoop v1.0.4 preserves exactly the supported Flusher, ReaderFrom, Hijacker,
Pusher and CloseNotifier interfaces and provides Unwrap for ResponseController;
see its [maintainer documentation](https://raw.githubusercontent.com/felixge/httpsnoop/v1.0.4/README.md).
