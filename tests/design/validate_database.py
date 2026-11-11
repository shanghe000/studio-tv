#!/usr/bin/env python3
"""Validate the design in a new, networkless PostgreSQL 17 container on deployment-host.

Reads repository SQL only. It does not read production environment files, open
the production database, or operate on any existing container. All docker exec,
start and rm operations use the ID returned by this invocation's docker create.
The SQL fixtures roll back, then the tmpfs database/container is destroyed.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ("media", "canvas", "catalog", "library", "execution", "assistant", "studio", "platform")


def remote(host: str, args: list[str], *, data: bytes | None = None, timeout: int = 30) -> subprocess.CompletedProcess[bytes]:
    # SSH uses a remote shell; quote each argument rather than interpolate SQL,
    # paths, or user input into the command. The SQL itself goes through stdin.
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, shlex.join(args)],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
    )


def checked(result: subprocess.CompletedProcess[bytes], stage: str) -> str:
    if result.returncode:
        # These processes only see temporary fixtures and public DDL. No
        # production env, credentials, token or private database is passed in.
        detail = result.stderr.decode("utf-8", errors="replace").strip()[-2400:]
        raise RuntimeError(f"{stage} failed: {detail or 'remote command failed'}")
    return result.stdout.decode("utf-8", errors="replace").strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="deployment-host", help="SSH alias for the isolated test host (default: deployment-host)")
    options = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", options.host):
        parser.error("host must be an SSH hostname or alias without shell syntax")

    blueprint_path = ROOT / "docs/design/database.sql"
    blueprint = blueprint_path.read_bytes()
    declarations = re.findall(rb"^CREATE\s+TABLE\s+([a-z_]+)\.([a-z_]+)\s*\(", blueprint, re.I | re.M)
    expected = len(declarations)
    if expected == 0 or any(schema.decode() not in SCHEMAS for schema, _ in declarations):
        raise RuntimeError("the blueprint must define domain tables in the known design schemas")
    inputs = [ROOT / "apps/api-go/migrations" / name for name in ("001_core.sql", "002_ipac_auth.sql", "003_ipac_workspaces.sql")]
    sql = b"\\set ON_ERROR_STOP on\n" + b"\n".join(path.read_bytes() for path in inputs)
    sql += b"\n" + blueprint + b"\n" + (ROOT / "tests/design/schema_invariants.sql").read_bytes()
    schemas = ",".join(f"'{name}'" for name in SCHEMAS)
    sql += (
        "\nSELECT 'DESIGN_TABLES|'||count(*) FROM pg_catalog.pg_tables "
        f"WHERE schemaname IN ({schemas});\n"
    ).encode()

    name = "studio-tv-design-check-" + uuid.uuid4().hex
    container_id: str | None = None
    result_code = 1
    try:
        # Cached image only; no registry call and no listening/published ports.
        container_id = checked(remote(options.host, [
            "docker", "create", "--pull=never", "--name", name,
            "--label", "com.studio.purpose=isolated-schema-validation",
            "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
            "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine",
        ]), "temporary container creation")
        if not re.fullmatch(r"[a-f0-9]{64}", container_id):
            # Never accept a broad/name-based cleanup target from remote output.
            container_id = None
            raise RuntimeError("docker create did not return one exact container ID")
        checked(remote(options.host, ["docker", "start", container_id]), "temporary container start")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            ready = remote(options.host, ["docker", "exec", container_id, "pg_isready", "-U", "postgres", "-d", "postgres"], timeout=15)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("temporary PostgreSQL did not become ready in 60 seconds")

        output = checked(remote(options.host, [
            "docker", "exec", "-i", container_id, "psql", "-X", "-q", "-A", "-t",
            "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
        ], data=sql, timeout=120), "PostgreSQL schema/invariant validation")
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        table_lines = [line for line in lines if line.startswith("DESIGN_TABLES|")]
        if table_lines != [f"DESIGN_TABLES|{expected}"]:
            raise RuntimeError(f"created table count differs from the {expected} current SQL declarations")
        if "PASS fixtures_rolled_back=true" not in lines:
            raise RuntimeError("fixture rollback was not confirmed")
        invariant_lines = [line for line in lines if line.startswith("PASS schema_invariants ")]
        if len(invariant_lines) != 1:
            raise RuntimeError("the invariant suite did not report its successful count")
        print(f"PASS PostgreSQL 17 design DDL: {expected} tables (sha256 {hashlib.sha256(blueprint).hexdigest()[:16]})")
        print(invariant_lines[0])
        print("PASS fixtures rolled back")
        result_code = 0
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
    finally:
        if container_id is not None:
            try:
                cleanup = remote(options.host, ["docker", "rm", "-f", container_id], timeout=30)
                checked(cleanup, "temporary container destruction")
                print("PASS temporary database destroyed (container removed; tmpfs discarded)")
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
                print(f"FAIL temporary database cleanup: {error}", file=sys.stderr)
                result_code = 1
    return result_code


if __name__ == "__main__":
    raise SystemExit(main())
