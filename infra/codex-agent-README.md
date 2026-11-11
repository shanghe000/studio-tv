# Direct Agent isolated runtime

This optional deployment is separate from the existing Router. Its default is
disabled. All deployment files remain under the STUDIO repository or its private
`/home/user/.config/studio-tv` directory; no host systemd/firewall changes are
required.

## Boundaries

The API mounts a protected Unix socket directory **only**. A dedicated launcher
container alone has Docker access and accepts exactly version/profile plus
SHA256 owner/scope/run keys. It chooses the image, UID, mounts, command,
resources, network, endpoint allowlist and deadlines itself. It never accepts arbitrary
container parameters and never forwards API environment, STUDIO Bearer tokens,
database credentials, source code, Router state or operator HOME.

Each owner/conversation/profile/hash has separate persistent Codex HOME and
empty workspace. Workspace mounts are read-only. Config is overwritten from a
fixed versioned template before launch; app-server receives matching fixed
overrides. Runtime UID is 11001, cap-drop ALL, no-new-privileges, read-only root,
128 process limit, 768 MiB memory, 1 CPU, 64 MiB temporary storage, 20 minute
deadline, and 32 tool calls in the adapter. Native stderr and Docker logs are
discarded. Persistent state is limited to 256 MiB by a preflight check and a
two-second monitor; this is an observed budget rather than a kernel filesystem
quota, so deployments needing strict disk allocation must additionally use a
quota-enabled dedicated state filesystem.

A startup gate keeps Codex stopped until an ephemeral fixed NET_ADMIN helper
installs OUTPUT rules in **that runtime's network namespace**. Before launch,
the trusted launcher resolves `chatgpt.com`, `api.openai.com`, and
`auth.openai.com` through normal LAN DNS and rejects non-public IPv4 answers.
It pins the accepted answers into that runtime's `/etc/hosts` and permits only
loopback plus direct TCP443 to those addresses; IPv6 OUTPUT is dropped. The
runtime has no upstream DNS fallback. Endpoint IPs are refreshed on every launch
and remain fixed for its maximum 20-minute lifetime. Cloud/CDN IPs can be shared
with other domains, so this is an IP boundary rather than a TLS hostname filter.
The helper has no auth, source, state or Docker socket mount and exits immediately.
The model runtime has no NET_ADMIN. Both launcher and runtimes use the normal
outbound Docker bridge `studio-agent-direct`, separate from API/database/Router
networks. There is no forward-proxy service or proxy environment configuration.
The per-runtime firewall continues to reject host/private destinations.

## Provision and acceptance

Create separate private binary, Code Mode host and auth copies under the STUDIO config directory. Never
mount `/home/user/.codex`, an operator HOME or any Router CODEX_HOME. Binary must
report `codex-cli 0.160.0`; auth must be a regular private file. These values are
trusted deployment configuration, not web or model input:

```dotenv
STUDIO_AGENT_CODEX_BINARY=/home/user/.config/studio-tv/codex-agent/codex
STUDIO_AGENT_CODE_MODE_HOST_BINARY=/home/user/.config/studio-tv/codex-agent/codex-code-mode-host
STUDIO_AGENT_COMPANY_AUTH_FILE=/home/user/.config/studio-tv/codex-agent/auth.json
STUDIO_AGENT_STATE_ROOT=/home/user/.config/studio-tv/agent-runtime
STUDIO_AGENT_SOCKET_DIR=/home/user/.config/studio-tv/agent-launcher
STUDIO_AGENT_RUNTIME_IMAGE=studio-agent-runtime:0.160.0-v1
STUDIO_CODEX_AGENT_ENABLED=false
STUDIO_CODEX_AGENT_PROFILE_VALIDATED=false
STUDIO_AGENT_ACCEPTANCE_ONLY=true
```

Directories must exist before Compose mounts them. Launcher validates exact
paths and private permissions, and provisions owned per-scope subdirectories.
The API user is UID/GID1000; launcher writes socket root:1000 mode0660 and its
directory root:1000 mode0750. Native credentials do not enter STUDIO tables/prompts.

The pinned runtime requires `features.code_mode_host=true` for dynamic tool
dispatch, while `features.code_mode=false`, native shell/unified execution,
browser and other native business tools remain disabled. Do not equate the
internal JavaScript dispatch wrapper with shell execution. Full paginated native
history and the durable STUDIO receipts are verified before reporting completion.
The static `codex-code-mode-host` companion must come from the same pinned
0.160.0 Linux musl release and be executable, with no group or other write
permission. Launcher requires its SHA256
`37cab1584302611e9936902219640ab5e7a79fcfccd2504c6e85ea8cb97d0e10` and mounts
only this file read-only beside Codex. The actual native host could not start
without this companion; no dynamic-tool callback was successful in that fixture.

The company auth snapshot must be maintained when native credentials rotate.
A nominal future access-token expiry does not prove that a revoked refresh chain
is usable. Provision from the trusted current company login, never by sharing a
Router or operator HOME.

Build the runtime with `docker compose -f compose.yaml -f
infra/codex-agent.compose.yaml --profile build-agent-runtime build
agent-runtime-image agent-launcher`, then start only agent-launcher
with `up -d --no-deps --wait` while API Agent enable remains false. An accepted test runner
with UID/GID1000 and the socket directory mounted can run the two isolated
fixture tests with `STUDIO_AGENT_ACCEPTANCE_SOCKET=/run/studio-agent/launcher.sock`:

```sh
go test -tags=agent_acceptance -mod=vendor -count=1 -v ./internal/modules/agentrun/adapters/codexappserver -run '^TestLiveIsolated(ToolsAcceptance|NativeToolDenial)$'
```

These tests make actual authorized model calls. Each uses a fake canvas fixture
and no STUDIO login token or user records. They require a real dynamic-tool callback,
persisted pre-submit intent, real tool receipt and validated full native terminal
snapshot. The negative test requests harmless shell/file/browser operations;
any dangerous native item or server approval aborts the profile. Combine this
with the pinned binary's feature/config evidence and independent container and
network checks; a model's text claiming tools are unavailable is insufficient.

After actual acceptance, set `STUDIO_AGENT_ACCEPTANCE_ONLY=false`,
`STUDIO_CODEX_AGENT_PROFILE_VALIDATED=true`, `STUDIO_CODEX_AGENT_ENABLED=true`, with the
existing `MODEL_REAL_EXECUTION_ENABLED=true` policy. A failed native probe leaves
Agent disabled and reports the specific failing behavior. Runtime/container
startup cannot prove a model feature is available.

For an existing proxy deployment, ensure no managed Agent runtime is active,
rebuild and recreate `agent-launcher` with the full deployed Compose overlay
set, verify its health and direct network acceptance, then remove the obsolete
`studio-tv-agent-egress-1` container and the unused `studio-agent-runtime` and
`studio-agent-egress` networks. Do not use a project-wide `down`. The API's proxy
dependency is removed from Compose and requires no business-data migration.
Non-billing acceptance can run a disposable, credential-free probe with the
same pinned hosts and runtime firewall: HTTPS to the resolved model/auth
endpoints must complete TLS, while private/LAN addresses, other public
destinations and non-HTTPS ports must fail. Run `python3
scripts/test-codex-agent-launcher.py` for fixed-spec and fail-closed DNS checks.

## Recovery and limits

The adapter saves a private checkpoint with submission intent before turn/start,
then binds native thread/turn and persists accepted evidence. Reconcile-only
requests never start another turn. A lost native turn id, incomplete/summary
snapshot, unmatched tool receipt, output mismatch or surviving active turn is
UNKNOWN and must be reconciled; it is never automatic permission to resubmit.
Cancellation interrupts the exact turn and closes its isolated container; already
committed STUDIO operations retain their actual receipts. Durable run/tool/event
state and user credential refresh remain STUDIO application responsibilities.

Only the server-owned native method allowlist is callable. Callback thread,
turn, call, registered tool and empty namespace must match; altered replays are
rejected. Unknown native server requests and approvals are denied. Native shell,
file-change, browser, external MCP and child-agent items cannot establish a
successful STUDIO transcript. Public replies contain only checked final text; private
native errors, IDs, account state and checkpoints are never public events.

## Shared operator CLI login (deployment-host, 2026-10-07)

With the user's explicit opt-in, append `infra/cli-auth.compose.yaml`, set
`STUDIO_CLI_AUTH_ENABLED=true` and `STUDIO_CLI_AUTH_SOCKET_DIR` to the protected socket
folder provided by Models Router's `compose.cli-auth.yaml`. The launcher reads
current CLI credentials through that socket before each launch; the old private
company copy is no longer the active source. The socket and operator directory
are never mounted in model containers. Logout, re-login and auth-file replacement
require no container restart. Operators ensure no task is running while switching.
See Models Router `docs/shared-cli-auth.md` for the source service and login steps.
