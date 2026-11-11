#!/bin/sh
set -eu
# Never start Codex before the launcher installs the fixed per-container egress
# rules. This readiness file is in fresh tmpfs, inaccessible to other runtimes.
studio_attempt=0
while [ ! -f /tmp/studio-network-ready ]; do
  studio_attempt=$((studio_attempt + 1))
  [ "$studio_attempt" -le 200 ] || exit 1
  sleep 0.1
done
# Also bound lifetime inside the runtime: launcher loss cannot orphan a model
# indefinitely. Docker stops all remaining processes when this entry exits.
exec /usr/bin/timeout --signal=KILL 1200 /opt/codex/codex app-server --listen stdio://
