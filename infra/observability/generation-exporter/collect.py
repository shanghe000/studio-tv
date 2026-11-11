#!/usr/bin/env python3
"""Fixed, read-only AutoDL collector. Install behind a forced-command SSH key.

No request arguments, prompts, job identifiers, credentials or raw upstream
responses leave this process. It never submits or interrupts inference.
"""
import concurrent.futures
import json
import math
import sqlite3
import time
import urllib.request
from pathlib import Path

DB = Path("/root/h3-api-data/jobs.sqlite3")
H3_SCRIPT = b"/root/studio-video-api/service.py"
NODES = ("MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "SaveVideo")
STATES = ("QUEUED", "SUBMITTING", "RUNNING", "UNKNOWN", "SUCCEEDED", "FAILED")
MAX_BODY = 4 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_json(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open("http://127.0.0.1:6006" + path, timeout=2) as response:
        if response.status != 200:
            raise ValueError("unexpected status")
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ValueError("response exceeds limit")
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError("object required")
        return value


def queue():
    value = http_json("/queue")
    if not all(isinstance(value.get(key), list) for key in ("queue_running", "queue_pending")):
        raise ValueError("invalid queue")
    return {"RUNNING": len(value["queue_running"]), "QUEUED": len(value["queue_pending"])}


def runtime():
    value = http_json("/system_stats")
    if not isinstance(value.get("system"), dict) or not isinstance(value.get("devices"), list):
        raise ValueError("invalid runtime")
    return True


def node_registered(node):
    return node in http_json("/object_info/" + node)


def art():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open("http://127.0.0.1:6008/", timeout=2) as response:
        return response.status == 200 and "text/html" in response.headers.get("Content-Type", "")


def h3_process():
    for directory in Path("/proc").glob("[0-9]*"):
        try:
            args = (directory / "cmdline").read_bytes().split(b"\0")
            if H3_SCRIPT in args and (directory / "stat").read_text().split()[2] != "Z":
                return True
        except (OSError, IndexError):
            continue
    return False


def h3_queue():
    # mode=ro refuses to create a missing DB; query_only enforces read-only SQL.
    with sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True, timeout=1) as db:
        db.execute("PRAGMA query_only=ON")
        counts = dict(db.execute("SELECT status,COUNT(*) FROM jobs GROUP BY status"))
        if set(counts) - set(STATES):
            raise ValueError("unknown state; monitoring schema needs review")
        oldest = db.execute("SELECT MIN(created) FROM jobs WHERE status='QUEUED'").fetchone()[0]
    result = {"counts": {state: counts.get(state, 0) for state in STATES}, "oldest_queued_age_seconds": 0}
    if oldest is not None:
        if not isinstance(oldest, (int, float)) or not math.isfinite(oldest):
            raise ValueError("invalid created time")
        result["oldest_queued_age_seconds"] = max(0, time.time() - oldest)
    return result


def safe_probe(function, *args):
    started = time.monotonic()
    try:
        value = function(*args)
        return {"success": True, "value": value, "duration_seconds": time.monotonic() - started}
    except Exception:
        return {"success": False, "duration_seconds": time.monotonic() - started}


def collect():
    functions = {"h3_queue": h3_queue, "comfy_queue": queue, "comfy_runtime": runtime,
                 "autodl_art": art, "h3_process": h3_process}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {name: pool.submit(safe_probe, function) for name, function in functions.items()}
        nodes = {node: pool.submit(safe_probe, node_registered, node) for node in NODES}
        probes = {name: future.result() for name, future in futures.items()}
        probes["comfy_nodes"] = {"success": all(future.result()["success"] for future in nodes.values()),
                                 "value": {node: bool(future.result().get("value", False)) for node, future in nodes.items()},
                                 "duration_seconds": max(future.result()["duration_seconds"] for future in nodes.values())}
    return {"schema_version": 1, "observed_at": time.time(), "probes": probes}


if __name__ == "__main__":
    print(json.dumps(collect(), allow_nan=False, separators=(",", ":")))
