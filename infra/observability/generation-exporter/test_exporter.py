import copy
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).parent
def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

exporter = module("exporter")
collector = module("collect")


def remote_payload():
    value = {"h3_queue": {"counts": {state: 0 for state in exporter.H3_STATES}, "oldest_queued_age_seconds": 0},
             "comfy_queue": {"QUEUED": 0, "RUNNING": 0}, "comfy_runtime": True,
             "autodl_art": True, "h3_process": True, "comfy_nodes": {node: True for node in exporter.NODES}}
    value["h3_queue"]["counts"]["QUEUED"] = 3
    value["h3_queue"]["oldest_queued_age_seconds"] = 62
    return {"schema_version": 1, "observed_at": time.time(),
            "probes": {name: {"success": True, "value": item, "duration_seconds": 0.1} for name, item in value.items()}}


class ExporterTest(unittest.TestCase):
    def setUp(self):
        self.config = exporter.load_config(HERE / "config.example.json")
        self.app = exporter.Exporter(self.config)

    def healthy(self):
        def http(url, validator="status", **kwargs):
            if validator == "h3":
                return {"worker_enabled": True, "profile_count": 9}
            return True
        with patch.object(exporter, "http_probe", side_effect=http), patch.object(exporter, "ssh_probe", return_value=exporter.validate_remote(remote_payload())):
            self.app.collect_once()

    def test_healthy_real_counts_and_readiness(self):
        self.healthy()
        metrics = self.app.render()
        self.assertIn('studiotv_generation_service_ready{service="h3_inference"} 1', metrics)
        self.assertIn('studiotv_generation_queue_jobs{layer="h3",state="QUEUED"} 3', metrics)
        self.assertIn('studiotv_generation_queue_jobs{layer="comfyui",state="QUEUED"} 0', metrics)
        self.assertTrue(self.app.health())

    def test_disconnect_clears_live_state_omits_queue_retains_last_success(self):
        self.healthy()
        success = self.app.last_success["h3_queue"]
        with patch.object(exporter, "http_probe", side_effect=TimeoutError), patch.object(exporter, "ssh_probe", side_effect=TimeoutError):
            self.app.collect_once()
        metrics = self.app.render()
        self.assertIn('studiotv_generation_service_up{service="h3_api"} 0', metrics)
        self.assertIn('studiotv_generation_service_up{service="comfyui"} 0', metrics)
        self.assertIn('studiotv_generation_service_up{service="autodl_art"} 0', metrics)
        self.assertIn('studiotv_generation_service_ready{service="h3_inference"} 0', metrics)
        self.assertNotIn('studiotv_generation_queue_jobs{', metrics)
        self.assertFalse(any(line.startswith('studiotv_generation_h3_worker_enabled ') for line in metrics.splitlines()))
        self.assertEqual(success, self.app.last_success["h3_queue"])

    def test_authenticated_worker_health_alone_does_not_imply_inference_ready(self):
        self.healthy()
        self.app.probes["comfy_nodes"]["value"]["MiniMaxH3ReferenceToVideo"] = False
        self.assertIn('studiotv_generation_service_ready{service="h3_inference"} 0', self.app.render())
        self.app.probes["comfy_nodes"]["value"]["MiniMaxH3ReferenceToVideo"] = True
        self.app.probes["h3_process"]["value"] = False
        self.assertIn('studiotv_generation_service_ready{service="h3_inference"} 0', self.app.render())

    def test_recovery_repopulates_current_queue_and_heartbeats(self):
        with patch.object(exporter, "http_probe", side_effect=TimeoutError), patch.object(exporter, "ssh_probe", side_effect=TimeoutError):
            self.app.collect_once()
        self.assertEqual(self.app.last_success["h3_queue"], 0)
        self.healthy()
        metrics = self.app.render()
        self.assertIn('studiotv_generation_service_ready{service="h3_inference"} 1', metrics)
        self.assertIn('studiotv_generation_queue_jobs{layer="h3",state="QUEUED"} 3', metrics)
        self.assertGreater(self.app.last_success["h3_queue"], 0)

    def test_individual_db_failure_does_not_zero_or_hide_other_layer(self):
        self.healthy()
        self.app.probes["h3_queue"] = {"success": False, "duration_seconds": 0.1}
        metrics = self.app.render()
        self.assertNotIn('studiotv_generation_queue_jobs{layer="h3"', metrics)
        self.assertIn('studiotv_generation_queue_jobs{layer="comfyui",state="QUEUED"} 0', metrics)
        self.assertTrue(self.app.probes["h3_runtime"]["success"])
        self.assertIn('studiotv_generation_service_ready{service="h3_inference"} 0', metrics)

    def test_unknown_labels_and_malformed_counts_are_rejected(self):
        for mutate in (lambda p: p["probes"]["h3_queue"]["value"]["counts"].update({"PROMPT_SECRET": 1}),
                       lambda p: p["probes"]["comfy_queue"]["value"].update({"RUNNING": True}),
                       lambda p: p.update({"observed_at": time.time() - 120}),
                       lambda p: p["probes"]["h3_queue"]["value"].update({"oldest_queued_age_seconds": float("nan")})):
            payload = remote_payload()
            mutate(payload)
            with self.assertRaises(ValueError):
                exporter.validate_remote(payload)

    def test_probe_failures_do_not_leak_exception_or_credentials(self):
        secret = "do-not-expose-this-token"
        def failing():
            raise RuntimeError(secret)
        result = exporter.safe_probe(failing)
        self.assertNotIn(secret, json.dumps(result))
        self.assertFalse(result["success"])

    def test_http200_generic_gateway_error_is_not_a_product_heartbeat(self):
        class Response:
            status = 200
            headers = {"Content-Type": "text/html"}
            def __init__(self, body):
                self.body = body
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, limit):
                return self.body[:limit]
        for body, valid in ((b"<html><title>Gateway error</title></html>", False),
                            (b"<html><title>Studio TV | Canvas</title></html>", True)):
            with patch.object(exporter.urllib.request, "build_opener") as opener:
                opener.return_value.open.return_value = Response(body)
                if valid:
                    self.assertTrue(exporter.http_probe("http://localhost/projects", validator="studio_web"))
                else:
                    with self.assertRaises(ValueError):
                        exporter.http_probe("http://localhost/projects", validator="studio_web")

    def test_http200_not_ready_database_is_not_a_ready_heartbeat(self):
        class Response:
            status = 200
            headers = {"Content-Type": "application/json"}
            def __init__(self, value):
                self.body = json.dumps(value).encode()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, limit):
                return self.body[:limit]
        for value, valid in (({"status": "ready", "database": "failed", "storage": "ready"}, False),
                             ({"status": "ok"}, False),
                             ({"status": "ready", "database": "ready", "storage": "ready"}, True)):
            with patch.object(exporter.urllib.request, "build_opener") as opener:
                opener.return_value.open.return_value = Response(value)
                if valid:
                    self.assertTrue(exporter.http_probe("http://localhost/readyz", validator="ready"))
                else:
                    with self.assertRaises(ValueError):
                        exporter.http_probe("http://localhost/readyz", validator="ready")

    def test_config_forbids_credentials_in_urls_and_ssh_option_injection(self):
        for change in (lambda c: c["http"]["h3_health"].update({"url": "http://token@localhost/health"}),
                       lambda c: c["ssh"].update({"target": "-oProxyCommand=sh"}),
                       lambda c: c["http"]["h3_health"].update({"timeout": 30})):
            config = copy.deepcopy(self.config)
            change(config)
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / "config.json"
                path.write_text(json.dumps(config))
                with self.assertRaises(ValueError):
                    exporter.load_config(path)

    def test_ssh_command_has_no_remote_shell_command_and_uses_host_validation(self):
        class Completed:
            returncode = 0
            stdout = json.dumps(remote_payload()).encode()
        with patch.object(exporter.subprocess, "run", return_value=Completed()) as execute:
            exporter.ssh_probe(self.config["ssh"])
        args, kwargs = execute.call_args
        self.assertEqual(args[0][-1], "root@gpu.example.invalid")
        self.assertIn("StrictHostKeyChecking=yes", args[0])
        self.assertIn("BatchMode=yes", args[0])
        self.assertIs(kwargs["stderr"], exporter.subprocess.DEVNULL)

    def test_loop_freshness_expires_without_new_poll(self):
        self.healthy()
        self.app.last_poll = time.time() - 100
        self.assertFalse(self.app.health())
        self.assertIn('studiotv_generation_service_up{service="h3_api"} 0', self.app.render())
        self.assertNotIn('studiotv_generation_queue_jobs{', self.app.render())


class ReadOnlyCollectorTest(unittest.TestCase):
    def test_sqlite_readonly_does_not_create_missing_database(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = pathlib.Path(directory) / "missing.db"
            with patch.object(collector, "DB", missing), self.assertRaises(sqlite3.OperationalError):
                collector.h3_queue()
            self.assertFalse(missing.exists())

    def test_reads_counts_and_oldest_age_without_changing_owned_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "jobs.sqlite3"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE jobs(status TEXT,created REAL)")
                db.executemany("INSERT INTO jobs VALUES (?,?)", [("QUEUED", time.time() - 50), ("RUNNING", time.time()), ("SUCCEEDED", time.time())])
            before = path.read_bytes()
            with patch.object(collector, "DB", path):
                data = collector.h3_queue()
            self.assertEqual(data["counts"]["QUEUED"], 1)
            self.assertEqual(data["counts"]["SUBMITTING"], 0)
            self.assertGreaterEqual(data["oldest_queued_age_seconds"], 49)
            self.assertEqual(path.read_bytes(), before)

    def test_unknown_sqlite_state_is_unavailable_not_fake_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "jobs.sqlite3"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE jobs(status TEXT,created REAL)")
                db.execute("INSERT INTO jobs VALUES ('FUTURE_STATE',?)", (time.time(),))
            with patch.object(collector, "DB", path):
                data = collector.safe_probe(collector.h3_queue)
            self.assertFalse(data["success"])
            self.assertNotIn("value", data)


if __name__ == "__main__":
    unittest.main()
