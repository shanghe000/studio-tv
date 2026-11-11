#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_directory=$(mktemp -d)
test_suffix=$(python3 -c 'import secrets; print(secrets.token_hex(6))')
test_network="studiotv-api-test-${test_suffix}"
test_database="${test_network}-db"
cleanup() {
  docker stop "$test_database" >/dev/null 2>&1 || true
  docker network rm "$test_network" >/dev/null 2>&1 || true
  rm -f "$test_directory/test.env"
  rmdir "$test_directory"
}
trap cleanup EXIT
python3 - "$test_directory/test.env" <<'PY'
import os, secrets, sys
from pathlib import Path
password = secrets.token_hex(32)
p = Path(sys.argv[1])
p.write_text('POSTGRES_USER=studiotv_test\nPOSTGRES_DB=studiotv_test\nPOSTGRES_PASSWORD=' + password + '\nTEST_DATABASE_URL=postgres://studiotv_test:' + password + '@test-db:5432/studiotv_test\nTEST_CHROMIUM_SANDBOX_MODE=container\n')
os.chmod(p, 0o600)
PY
docker build --target test -t studio-tv-api-test -f infra/api.Dockerfile .
docker network create "$test_network" >/dev/null
docker run --rm -d --name "$test_database" --network "$test_network" --network-alias test-db \
  --env-file "$test_directory/test.env" --health-cmd 'pg_isready -U studiotv_test -d studiotv_test' \
  --health-interval 1s --health-timeout 2s --health-retries 30 postgres:17-alpine >/dev/null
test_ready=false
for ((attempt=0; attempt<30; attempt++)); do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' "$test_database") == healthy ]]; then test_ready=true; break; fi
  sleep 1
done
[[ "$test_ready" == true ]] || { echo 'Disposable test database did not become ready' >&2; exit 1; }
docker run --rm --network "$test_network" --env-file "$test_directory/test.env" studio-tv-api-test
