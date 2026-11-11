# Generation service probes — IMPLEMENTED

This exporter complements STUDIO's native task metrics. It never creates, retries,
cancels or interrupts a task. It makes fixed HTTP GETs and invokes a dedicated
SSH key whose server-side `authorized_keys` entry **forces** `collect.py`.
No provider inference is part of the health check.

## Deployment boundaries

- Deploy `collect.py` to
  `/root/.config/studio-video-api/monitoring/collect.py` on AutoDL, root-owned and
  not writable by other users. Its absolute SQLite path is deliberately fixed.
- Use a separate monitoring key, never the existing unrestricted deployment or
  tunnel private key. The remote entry must set
  `restrict,command="/root/miniconda3/bin/python /root/.config/studio-video-api/monitoring/collect.py"`.
  This disables PTYs, forwarding and user startup files; the collector ignores
  original commands and accepts no arguments. Do not create a general SSH shell
  capability for the exporter.
- Mount only `h3_api_key`, `monitor_ed25519`, `known_hosts` read-only under
  `/run/generation-secrets/`. Server1's monitoring directory is private; files
  containing credentials are mode 0600 and owned by UID 1000. No Docker socket,
  personal Codex directory, Router credentials or STUDIO storage is mounted.
- Run the container with host networking as UID/GID 1000, read-only filesystem,
  dropped capabilities and no-new-privileges. `config.example.json` binds only
  the deployment-host Docker bridge `192.0.2.10:18885`, reachable by Prometheus through
  `host.docker.internal:host-gateway`. This is not a LAN/public listener.
- Copy a reviewed config JSON outside Git. The example contains exact current
  deployment-host endpoints and secret **paths**, no secret values. All HTTP requests
  disable proxy environment inheritance and redirects; normal HTTPS certificate
  validation remains enabled. SSH requires pinned known_hosts validation.
  STUDIO Web requires its real `Studio TV` HTML title; STUDIO API validates its JSON
  health and database/storage readiness rather than accepting any HTTP 200 page.
- Image base is digest pinned; build args `PYTHON_PACKAGE_VERSION` and
  `OPENSSH_PACKAGE_VERSION` default to the versions recorded in `packages.lock`
  and must match that lock if supplied explicitly. No pip dependency is used.
- HTTPS APT uses the Tsinghua Debian mirror and Debian's security repository,
  preserving the original Debian signing keyring and repository signature checks.
  A CA bundle copied from the same digest-pinned Go builder bootstraps HTTPS;
  `SSL_CERT_FILE` also makes Python use that bundle with normal certificate and
  hostname verification. IPv4, bounded retries and timeouts apply only to this
  image's APT configuration. The build verifies Python's default TLS context.
  Both original package pins were downloaded successfully from the signed
  Bookworm indexes on 2026-10-28; their versions remain unchanged.

The collector opens the existing SQLite DB with `mode=ro` and
`PRAGMA query_only=ON`, queries aggregate status counts/oldest waiting time,
and returns only fixed-key JSON. Reading a missing database fails without
creating it. It uses localhost ComfyUI `/queue`, `/system_stats`, and three
`/object_info/<node>` GETs plus ART's HTML entry point; it never reads historical
prompts or returns queue contents, IDs, file paths, signed URLs or credentials.

## Metrics and meaning

HTTP probes, remote reads and bounded timeouts run in parallel every 15 seconds.
Prometheus scrapes the cached `/metrics` response, so it never waits on AutoDL.
The exporter `/healthz` checks that the collection loop is updating.

| Metric prefix `studiotv_generation_` | Fixed dimensions | Meaning |
|---|---|---|
| `service_up` | `service=studiotv_api,studiotv_web,models_router,h3_api,comfyui,autodl_art` | Current process/HTTP liveness; failed or missing probe gives 0. |
| `service_ready` | `service=studiotv_api,models_router,h3_inference` | API/Router readiness endpoints; H3 combines authenticated worker configuration, positive profile count, exact live `service.py` process, readable H3 queue DB, available Comfy queue/runtime and the required registered nodes. |
| `h3_process_up` | none | Exact non-zombie H3 service.py process is present. |
| `h3_worker_enabled` | none | Existing H3 API's `worker_enabled` flag; **not** proof of worker-thread progress. Absent when authenticated health is unavailable. |
| `h3_profile_count` | none | Authenticated H3 profile count, absent when unavailable. |
| `comfy_node_registered` | `node=MiniMaxH3ImageToVideo,MiniMaxH3ReferenceToVideo,SaveVideo` | Required local nodes present. First/last frame shares ImageToVideo; all reference modes share ReferenceToVideo. |
| `queue_jobs` | `layer=h3,comfyui`; fixed `state` | Latest actual queue/state count, absent for an unavailable layer. H3 exposes QUEUED/SUBMITTING/RUNNING/UNKNOWN/SUCCEEDED/FAILED; Comfy exposes QUEUED/RUNNING. |
| `queue_oldest_queued_age_seconds` | `layer=h3` | Oldest queued H3 age; 0 only for a verified empty queue, absent on failure. |
| `probe_success` | fixed `probe` | Last poll probe success. |
| `probe_last_success_timestamp_seconds` | fixed `probe` | Last successful observation; stays old during failures, 0 before first success. |
| `probe_duration_seconds` | fixed `probe` | Last individual check duration. |
| `collector_last_poll_timestamp_seconds` | none | Last completed overall poll. |
| `collector_poll_duration_seconds` | none | Entire last poll duration. |

H3 readiness is an inexpensive operational check, not proof that GPU inference
or output quality will succeed. Existing real-generation acceptance is separate.
The frozen H3 API provides an enabled flag, not an actual worker-thread tick;
the dashboard must not call that flag a worker heartbeat.

STUDIO, Router, H3 and Comfy are different queue layers and can represent the same
work. **Never sum counts across layers.** STUDIO's queue is the user-visible pending
backlog. H3/Comfy reveal inference-side work and tasks submitted directly through
the original UI. An offline compute instance results in H3/Comfy/ART liveness
and readiness 0 and missing queue samples, not an empty queue. Historical
last-success timestamps distinguish unavailable metrics from verified zero.

Do not attach a static Prometheus `service` target label to this exporter job:
it would overwrite its per-service metric label unless `honor_labels` is true.
`environment=deployment-host` is safe. No user, subject, project, task or invocation IDs
are metric labels. Responses and exceptions are not logged.

## Verification

Run from the STUDIO repository:

```sh
python3 -m unittest discover -s infra/observability/generation-exporter -p 'test_*.py' -v
```

Tests use owned temporary SQLite fixtures and mocked network failures, including
recovery/staleness semantics,
schema validation, restricted SSH command construction and secret-safe errors.
No production DB write or inference call is used.

After deploy verify `/metrics` in Prometheus, actual H3/Comfy queue counts,
service heartbeats and Grafana targets. Test offline behavior with an isolated
fixture exporter and unreachable targets; do not interrupt a live generation
service just to exercise monitoring.
