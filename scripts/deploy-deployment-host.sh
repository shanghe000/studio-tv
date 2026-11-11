#!/usr/bin/env bash
set -euo pipefail
revision=${1:-main}
[[ "$revision" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo "Invalid Git revision" >&2; exit 1; }
ssh -o BatchMode=yes deployment-host bash -s -- "$revision" <<'REMOTE'
set -euo pipefail
revision=$1
repo=/home/user/apps/studio-tv
secret_config=/home/user/.config/studio-tv/server.env
test -f "$secret_config" || { echo "Private server configuration is missing" >&2; exit 1; }
# Migration is a coordinated operation, not a normal deployment. A second
# PostgreSQL must never mount the legacy volume while the old project is live.
# Legacy ownership labels may be retained, but every visible container must
# already have completed the coordinated rename before normal deployment.
if docker ps --filter label=com.docker.compose.project=rhtv-service --format '{{.Names}}' | grep -q '^rhtv-service-'; then
  echo "Legacy rhtv-service containers are still running; finish the coordinated naming migration first" >&2
  exit 1
fi
if docker volume inspect rhtv-service_postgres_data >/dev/null 2>&1 && ! grep -Eq '^STUDIOTV_REUSE_EXISTING_DATA=true$' "$secret_config"; then
  echo "Legacy PostgreSQL data exists; explicitly configure external volume reuse before deployment" >&2
  exit 1
fi
cd "$repo"
test -z "$(git status --porcelain)" || { echo "Server checkout has local changes; preserved for review" >&2; exit 1; }
git fetch origin main --tags
if [ "$revision" = main ]; then git switch main; git merge --ff-only origin/main; else git switch --detach "$revision"; fi
# Populate the independent content-addressed catalog before any new release starts.
# Cached bytes are checked against the committed version and never fetched by API reads.
if [ -f scripts/import-character-media.py ]; then
  python3 scripts/import-character-media.py --download
  python3 scripts/import-character-media.py --verify
fi
compose_args=(-f compose.yaml)
compose_env_args=(--env-file "$secret_config")
private_env_files=("$secret_config")
agent_config=/home/user/.config/studio-tv/agent.env
if [ -f "$agent_config" ]; then
  compose_env_args+=(--env-file "$agent_config")
  private_env_files+=("$agent_config")
fi
observability_config=/home/user/.config/studio-tv/observability.env
if [ -f "$observability_config" ]; then
  compose_env_args+=(--env-file "$observability_config")
  private_env_files+=("$observability_config")
  compose_args+=(-f infra/observability.compose.yaml)
fi
# Existing deployment-host data is externally managed and must never be replaced.
if grep -Eq '^STUDIOTV_REUSE_EXISTING_DATA=true$' "$secret_config"; then
  compose_args+=(-f infra/studiotv-existing-data.compose.yaml)
fi
if [ -f /home/user/.config/studio-tv/router-secrets/router_service_token ]; then
  compose_args+=(-f infra/router.compose.yaml)
fi
# Use the same file order as Compose.
agent_enabled=$(awk -F= '$1 == "STUDIO_CODEX_AGENT_ENABLED" { value=$2 } END { gsub(/\r/, "", value); print value }' "${private_env_files[@]}")
if [ "$agent_enabled" = true ]; then
  compose_args+=(-f infra/codex-agent.compose.yaml)
fi
if grep -Eq '^STUDIO_CLI_AUTH_ENABLED=true$' "${private_env_files[@]}"; then
  compose_args+=(-f infra/cli-auth.compose.yaml)
fi
mkdir -p var/log/studio-tv
chmod 750 var/log/studio-tv
# Non-root monitoring containers read committed public configuration. Git can
# recreate subdirectories under a restrictive shell umask; secrets are elsewhere.
python3 - <<'PY'
from pathlib import Path
import subprocess
root = Path('infra/observability')
names = subprocess.check_output(['git', 'ls-files', '-z', str(root)]).decode().split('\0')
for name in filter(None, names):
    path = Path(name)
    if path.is_symlink():
        raise RuntimeError('Unexpected monitoring configuration symlink')
    path.chmod(0o644)
    for directory in path.parents:
        if directory == root or root in directory.parents:
            directory.chmod(0o755)
PY
docker compose "${compose_args[@]}" "${compose_env_args[@]}" up -d --build --wait
git rev-parse HEAD
docker compose "${compose_args[@]}" "${compose_env_args[@]}" ps
REMOTE
