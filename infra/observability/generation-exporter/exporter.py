#!/usr/bin/env python3
"""Low-cardinality Prometheus probes; HTTP + a restricted SSH collector.

Only fixed HTTP GETs/forced-command SSH reads occur. No provider calls or user
requests are submitted. All error text and upstream bodies remain unlogged.
"""
import concurrent.futures
import json
import math
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

NODES = ("MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "SaveVideo")
H3_STATES = ("QUEUED", "SUBMITTING", "RUNNING", "UNKNOWN", "SUCCEEDED", "FAILED")
HTTP_PROBES = ("studio_api_health", "studio_api_ready", "studio_web", "router_health", "router_ready", "h3_health", "h3_ready")
REMOTE_PROBES = ("h3_queue", "comfy_queue", "comfy_runtime", "autodl_art", "h3_process", "comfy_nodes")
MAX_BODY = 128 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def finite_number(value, nonnegative=True):
    return type(value) in (int, float) and math.isfinite(value) and (not nonnegative or value >= 0)


def http_probe(url, validator="status", token_file=None, timeout=2):
    headers = {"User-Agent": "studiotv-generation-monitor/1"}
    if token_file:
        token = Path(token_file).read_text().strip()
        if not token or "\n" in token or "\r" in token:
            raise ValueError("invalid token file")
        headers.update({"Authorization": "Bearer " + token, "X-Subject-Ref": "studiotv-generation-monitor"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
        if response.status != 200:
            raise ValueError("unexpected status")
        if validator == "status":
            return True
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ValueError("response exceeds limit")
        if validator in ("html", "studio_web"):
            if "text/html" not in response.headers.get("Content-Type", "") or b"<html" not in body.lower():
                raise ValueError("invalid web document")
            if validator == "studio_web" and not re.search(br"<title>\s*Studio TV(?:\s|[|<])", body):
                raise ValueError("invalid product document")
            return True
        value = json.loads(body)
        if not isinstance(value, dict) or value.get("status") != ("ready" if validator == "ready" else "ok"):
            raise ValueError("invalid health response")
        if validator == "ready" and (value.get("database") != "ready" or value.get("storage") != "ready"):
            raise ValueError("dependencies not ready")
        if validator == "h3":
            if type(value.get("worker_enabled")) is not bool or type(value.get("profile_count")) is not int or value["profile_count"] < 0:
                raise ValueError("invalid worker response")
            return {"worker_enabled": value["worker_enabled"], "profile_count": value["profile_count"]}
        return True


def validate_remote(value):
    if not isinstance(value, dict) or value.get("schema_version") != 1 or not finite_number(value.get("observed_at")):
        raise ValueError("invalid collector envelope")
    # Refuse replayed / significantly skewed readings; no old queue as current.
    if abs(time.time() - value["observed_at"]) > 60:
        raise ValueError("stale collector response")
    probes = value.get("probes")
    if not isinstance(probes, dict) or set(probes) != set(REMOTE_PROBES):
        raise ValueError("invalid collector probe set")
    for name, probe in probes.items():
        if not isinstance(probe, dict) or type(probe.get("success")) is not bool or not finite_number(probe.get("duration_seconds")):
            raise ValueError("invalid collector result")
        if not probe["success"]:
            continue
        data = probe.get("value")
        if name in ("comfy_runtime", "autodl_art", "h3_process"):
            if type(data) is not bool:
                raise ValueError("invalid boolean")
        elif name == "comfy_nodes":
            if not isinstance(data, dict) or set(data) != set(NODES) or any(type(item) is not bool for item in data.values()):
                raise ValueError("invalid node set")
        else:
            counts = data.get("counts") if name == "h3_queue" and isinstance(data, dict) else data
            expected = H3_STATES if name == "h3_queue" else ("RUNNING", "QUEUED")
            if not isinstance(counts, dict) or set(counts) != set(expected) or any(type(item) is not int or item < 0 for item in counts.values()):
                raise ValueError("invalid queue counts")
            if name == "h3_queue" and not finite_number(data.get("oldest_queued_age_seconds")):
                raise ValueError("invalid queue age")
    return probes


def ssh_probe(config):
    command = ["ssh", "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1",
               "-o", "ServerAliveInterval=2", "-o", "ServerAliveCountMax=1", "-o", "UserKnownHostsFile=" + config["known_hosts_file"],
               "-i", config["identity_file"], "-p", str(config["port"]), config["target"]]
    # SSH authorized_keys forces a fixed read-only script. No remote command or
    # stdin is supplied; do not mount an unrestricted administrator key.
    process = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=config.get("timeout_seconds", 8), check=False)
    if process.returncode != 0 or len(process.stdout) > MAX_BODY:
        raise ValueError("collector unavailable")
    return validate_remote(json.loads(process.stdout))


def safe_probe(function, *args, **kwargs):
    started = time.monotonic()
    try:
        value = function(*args, **kwargs)
        return {"success": True, "value": value, "duration_seconds": time.monotonic() - started}
    except Exception:
        return {"success": False, "duration_seconds": time.monotonic() - started}


class Exporter:
    def __init__(self, config):
        self.config = config
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.probes = {name: {"success": False, "duration_seconds": 0} for name in HTTP_PROBES + ("h3_runtime",) + REMOTE_PROBES}
        self.last_success = {name: 0 for name in self.probes}
        self.last_poll = 0
        self.poll_duration = 0

    def collect_once(self):
        started = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = {name: pool.submit(safe_probe, http_probe, **spec) for name, spec in self.config["http"].items()}
            remote = pool.submit(safe_probe, ssh_probe, self.config["ssh"])
            results = {name: future.result() for name, future in futures.items()}
            results["h3_runtime"] = remote.result()
        if results["h3_runtime"]["success"]:
            results.update(results["h3_runtime"]["value"])
        else:
            results.update({name: {"success": False, "duration_seconds": results["h3_runtime"]["duration_seconds"]} for name in REMOTE_PROBES})
        now = time.time()
        with self.lock:
            self.probes = results
            for name, result in results.items():
                if result["success"]:
                    self.last_success[name] = now
            self.last_poll = now
            self.poll_duration = time.monotonic() - started

    def run(self):
        while not self.stop.is_set():
            started = time.monotonic()
            self.collect_once()
            self.stop.wait(max(0, self.config.get("poll_interval_seconds", 15) - (time.monotonic() - started)))

    def health(self):
        with self.lock:
            return self.last_poll > 0 and time.time() - self.last_poll < 2 * self.config.get("poll_interval_seconds", 15) + 10

    def render(self):
        with self.lock:
            probes = dict(self.probes)
            last_success = dict(self.last_success)
            last_poll, duration = self.last_poll, self.poll_duration
        if time.time() - last_poll >= 2 * self.config.get("poll_interval_seconds", 15) + 10:
            # Even if the collection thread unexpectedly stalls, the HTTP server
            # must not continue publishing healthy heartbeats or old queues.
            probes = {name: {"success": False, "duration_seconds": item["duration_seconds"]} for name, item in probes.items()}
        lines = []
        def metric(name, help_text, samples):
            full = "studiotv_generation_" + name
            lines.extend(["# HELP " + full + " " + help_text, "# TYPE " + full + " gauge"])
            for labels, value in samples:
                suffix = "{" + ",".join(key + "=" + json.dumps(val) for key, val in sorted(labels.items())) + "}" if labels else ""
                lines.append(full + suffix + " " + str(int(value) if isinstance(value, bool) else value))
        def successful(name):
            return bool(probes[name]["success"])
        def true_value(name):
            return successful(name) and probes[name].get("value") is True
        worker = probes["h3_ready"].get("value", {}) if successful("h3_ready") else {}
        nodes = probes["comfy_nodes"].get("value", {}) if successful("comfy_nodes") else {}
        h3_ready = successful("h3_health") and successful("h3_ready") and worker.get("worker_enabled", False) and worker.get("profile_count", 0) > 0 and true_value("h3_process") and successful("h3_queue") and true_value("comfy_runtime") and successful("comfy_queue") and all(nodes.get(node, False) for node in NODES)
        up = {"studiotv_api": successful("studio_api_health"), "studiotv_web": successful("studio_web"), "models_router": successful("router_health"), "h3_api": successful("h3_health"), "comfyui": true_value("comfy_runtime"), "autodl_art": true_value("autodl_art")}
        metric("service_up", "Current service liveness; failed or missing probes produce zero.", [({"service": key}, value) for key, value in up.items()])
        metric("service_ready", "Current readiness. H3 verifies processes, configuration, H3/Comfy queues, Comfy runtime and required nodes; not a generation benchmark.", [({"service": "studiotv_api"}, successful("studio_api_ready")), ({"service": "models_router"}, successful("router_ready")), ({"service": "h3_inference"}, h3_ready)])
        metric("h3_process_up", "Exact H3 service.py process exists and is not a zombie; not a worker-thread heartbeat.", [({}, true_value("h3_process"))])
        metric("h3_worker_enabled", "Existing H3 API reports worker enabled; absent when its authenticated health probe fails.", [({}, worker["worker_enabled"])] if worker else [])
        metric("h3_profile_count", "Profile count from authenticated H3 health; absent when unavailable.", [({}, worker["profile_count"])] if worker else [])
        metric("comfy_node_registered", "Required local H3/archiving node registered in ComfyUI; failed/missing probe produces zero.", [({"node": node}, nodes.get(node, False)) for node in NODES])
        metric("probe_success", "Last completed probe succeeded. One series per fixed probe, no request/actor/job labels.", [({"probe": name}, item["success"]) for name, item in probes.items()])
        metric("probe_last_success_timestamp_seconds", "Last successful observation Unix time; remains old during failures, zero before first success.", [({"probe": name}, value) for name, value in last_success.items()])
        metric("probe_duration_seconds", "Duration of the last completed probe.", [({"probe": name}, item["duration_seconds"]) for name, item in probes.items()])
        queue_samples = []
        if successful("h3_queue"):
            queue_samples.extend(({"layer": "h3", "state": state}, count) for state, count in probes["h3_queue"]["value"]["counts"].items())
        if successful("comfy_queue"):
            queue_samples.extend(({"layer": "comfyui", "state": state}, count) for state, count in probes["comfy_queue"]["value"].items())
        metric("queue_jobs", "Current job count by layer/state. H3 and Comfy describe overlapping work: never sum layers. Absent for unavailable sources.", queue_samples)
        metric("queue_oldest_queued_age_seconds", "Age of oldest H3 QUEUED job; zero only for a verified empty queue, absent on failure.", [({"layer": "h3"}, probes["h3_queue"]["value"]["oldest_queued_age_seconds"])] if successful("h3_queue") else [])
        metric("collector_last_poll_timestamp_seconds", "Last completed collection Unix time.", [({}, last_poll)])
        metric("collector_poll_duration_seconds", "Elapsed seconds of last entire collection.", [({}, duration)])
        return "\n".join(lines) + "\n"


def load_config(path):
    config = json.loads(Path(path).read_text())
    if set(config.get("http", {})) != set(HTTP_PROBES):
        raise ValueError("all fixed HTTP probes are required")
    for spec in config["http"].values():
        parsed = urllib.parse.urlsplit(spec["url"])
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("invalid probe URL")
        if spec.get("validator", "status") not in ("status", "html", "studio_web", "json", "ready", "h3"):
            raise ValueError("invalid validator")
        timeout = spec.get("timeout", 2)
        if not finite_number(timeout) or not 0 < timeout <= 5:
            raise ValueError("invalid timeout")
    ssh = config["ssh"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+", ssh["target"]) or not 0 < int(ssh["port"]) < 65536:
        raise ValueError("invalid SSH target")
    if not 0 < ssh.get("timeout_seconds", 8) <= 10 or not 5 <= config.get("poll_interval_seconds", 15) <= 60:
        raise ValueError("invalid collection interval")
    return config


def main():
    # Startup failures are deliberately generic: URLs/secret paths are not logged.
    try:
        config = load_config(os.environ.get("GENERATION_EXPORTER_CONFIG", "/etc/generation-exporter/config.json"))
    except Exception:
        raise SystemExit("generation exporter configuration invalid") from None
    exporter = Exporter(config)
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/metrics":
                body = exporter.render().encode()
                status, content_type = 200, "text/plain; version=0.0.4; charset=utf-8"
            elif self.path == "/healthz":
                status = 200 if exporter.health() else 503
                body, content_type = b"ok\n" if status == 200 else b"not ready\n", "text/plain"
            else:
                status, body, content_type = 404, b"not found\n", "text/plain"
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            return
    thread = threading.Thread(target=exporter.run, daemon=True, name="generation-probes")
    thread.start()
    server = ThreadingHTTPServer((config.get("listen_host", "127.0.0.1"), int(config.get("listen_port", 18885))), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
