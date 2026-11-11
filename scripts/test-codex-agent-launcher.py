#!/usr/bin/env python3
"""Focused fixed-spec/provisioning checks; never starts Docker or a model."""
import asyncio
import importlib.util
import hashlib
import json
from pathlib import Path
import struct
import socket
import threading
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("studio_launcher", Path(__file__).with_name("codex-agent-launcher.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
PUBLIC_ADDRESSES = {host: ["104.18.32.7", "172.64.155.249"] for host in launcher.MODEL_HOSTS}


class FixedSpecTests(unittest.TestCase):
    def test_companion_rejects_changed_or_unprotected_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "codex-code-mode-host"
            path.write_bytes(b"fixture companion")
            path.chmod(0o755)
            with patch.object(launcher, "CODE_MODE_HOST_SHA256", hashlib.sha256(path.read_bytes()).hexdigest()):
                launcher.validate_code_mode_host(path)
                path.chmod(0o777)
                with self.assertRaises(RuntimeError):
                    launcher.validate_code_mode_host(path)
                path.chmod(0o755)
                path.write_bytes(b"changed companion")
                with self.assertRaises(RuntimeError):
                    launcher.validate_code_mode_host(path)

    def test_dynamic_dispatch_host_does_not_enable_native_tools(self):
        section = launcher.CONFIG.split("[features]\n", 1)[1]
        features = dict(line.strip().split(" = ", 1) for line in section.splitlines() if " = " in line)
        self.assertEqual(features["code_mode_host"], "true")
        for name in ("code_mode", "shell_tool", "unified_exec", "browser_use", "computer_use", "multi_agent", "workspace_dependencies"):
            self.assertEqual(features[name], "false")

    def test_runtime_has_fixed_isolation_and_no_api_docker_secrets(self):
        item = launcher.Launcher.__new__(launcher.Launcher)
        item.binary = Path("/private/studio/codex")
        item.code_mode_host = Path("/private/studio/codex-code-mode-host")
        item.image = "studio-agent-runtime:0.160.0-v1"
        item.network = "studio-agent-direct"
        args = item.arguments("studio-agent-fixed", Path("/own/codex"), Path("/own/home"), Path("/own/workspace"), PUBLIC_ADDRESSES)
        joined = " ".join(args)
        for expected in ("--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128",
                         "--memory=768m", "--cpus=1", "--log-driver=none", "dst=/workspace,readonly",
                         "dst=/opt/codex/codex-code-mode-host,readonly", "--network studio-agent-direct",
                         "--add-host chatgpt.com:104.18.32.7", "--dns 127.0.0.1"):
            self.assertIn(expected, joined)
        for forbidden in ("docker.sock", "DATABASE_URL", "Bearer", "AUTH_SIGNING_SECRET", "--privileged",
                          "--network=host", "/home/user/.codex", "MODELS_ROUTER", "NET_ADMIN", "_PROXY=", ":3128"):
            self.assertNotIn(forbidden, joined)

    def test_resolution_is_fixed_deduplicated_and_ipv4_only(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("104.18.32.7", 443))] * 2
        with patch.object(launcher.socket, "getaddrinfo", return_value=answers) as lookup:
            actual = launcher.model_addresses()
        self.assertEqual(actual, {host: ["104.18.32.7"] for host in launcher.MODEL_HOSTS})
        self.assertEqual([call.args for call in lookup.call_args_list],
                         [(host, 443, socket.AF_INET, socket.SOCK_STREAM) for host in launcher.MODEL_HOSTS])

    def test_private_missing_or_non_unicast_model_addresses_fail_closed(self):
        for denied in ("127.0.0.1", "192.0.2.10", "192.0.2.10", "192.0.2.10", "169.254.169.254",
                       "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "::1", "2606:4700::1111"):
            with self.subTest(address=denied), self.assertRaises(RuntimeError):
                launcher.direct_egress_rules({host: [denied] for host in launcher.MODEL_HOSTS})
        with self.assertRaises(RuntimeError):
            launcher.direct_egress_rules({host: [] for host in launcher.MODEL_HOSTS})
        with self.assertRaises(RuntimeError):
            launcher.direct_egress_rules({"unexpected.example": ["104.18.32.7"]})
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.10", 443))]
        with patch.object(launcher.socket, "getaddrinfo", return_value=answers), self.assertRaises(RuntimeError):
            launcher.model_addresses()

    def test_direct_firewall_has_only_resolved_public_https_destinations(self):
        rules = launcher.direct_egress_rules(PUBLIC_ADDRESSES).split("; ")
        self.assertEqual(rules[:4], ["ip6tables -P OUTPUT DROP", "iptables -P OUTPUT DROP",
                                    "iptables -F OUTPUT", "iptables -A OUTPUT -o lo -j ACCEPT"])
        self.assertEqual(rules[4:], ["iptables -A OUTPUT -d 104.18.32.7/32 -p tcp --dport 443 -j ACCEPT",
                                     "iptables -A OUTPUT -d 172.64.155.249/32 -p tcp --dport 443 -j ACCEPT"])

    def test_live_cli_source_switches_account_without_reusing_stale_auth(self):
        with tempfile.TemporaryDirectory() as temp:
            item = launcher.Launcher.__new__(launcher.Launcher)
            item.state = Path(temp) / "state"
            item.auth = Path(temp) / "auth.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(item.auth))
            item.auth.chmod(0o600)
            server.listen()
            values = [b'{"account":"a"}', b'{"account":"b"}', b'']
            def serve():
                for raw in values:
                    client, _ = server.accept()
                    with client:
                        client.sendall(raw)
                server.close()
            thread = threading.Thread(target=serve)
            thread.start()
            with patch.object(launcher.os, "chown"):
                for raw in values[:2]:
                    _, home, _, _ = item.provision("a" * 64, "b" * 64)
                    self.assertEqual((home / "auth.json").read_bytes(), raw)
                with self.assertRaises(RuntimeError):
                    item.provision("a" * 64, "b" * 64)
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())

    def test_per_scope_provisioning_does_not_follow_runtime_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            item = launcher.Launcher.__new__(launcher.Launcher)
            item.state = Path(temp) / "state"
            item.auth = Path(temp) / "company-auth"
            item.auth.write_bytes(b"fixture-not-real-credentials")
            item.auth.chmod(0o600)
            with patch.object(launcher.os, "chown"):
                root, home, _, _ = item.provision("a" * 64, "b" * 64)
                target = Path(temp) / "outside-config"
                target.write_text("outside")
                (home / "config.toml").unlink()
                (home / "config.toml").symlink_to(target)
                item.provision("a" * 64, "b" * 64)
                self.assertEqual(target.read_text(), "outside")
                self.assertFalse((home / "config.toml").is_symlink())
                self.assertIn('shell_tool = false', (home / "config.toml").read_text())
                (root / "workspace").rmdir()
                (root / "workspace").symlink_to(temp)
                with self.assertRaises(RuntimeError):
                    item.provision("a" * 64, "b" * 64)


class FakeSocket:
    def getsockopt(self, *args):
        return struct.pack("3i", 1, 1000, 1000)


class FakeWriter:
    def __init__(self):
        self.output = []
    def get_extra_info(self, _):
        return FakeSocket()
    def write(self, data):
        self.output.append(data)
    async def drain(self):
        pass
    def close(self):
        pass
    async def wait_closed(self):
        pass


class ControlProtocolTests(unittest.IsolatedAsyncioTestCase):
    def instance(self):
        item = launcher.Launcher.__new__(launcher.Launcher)
        item.caller_uid = 1000
        item.connections = 0
        item.active = set()
        item.scope_locks = set()
        return item

    async def dispatch(self, item, request):
        reader = asyncio.StreamReader()
        reader.feed_data(json.dumps(request).encode() + b"\n")
        reader.feed_eof()
        writer = FakeWriter()
        await item.handle(reader, writer)
        self.assertEqual(writer.output, [b'{"ready":false,"code":"STUDIO_RUNTIME_UNAVAILABLE"}\n'])
        self.assertEqual(item.connections, 0)

    async def test_arbitrary_container_spec_is_rejected(self):
        item = self.instance()
        await self.dispatch(item, {"version": 1, "profile": launcher.PROFILE, "ownerKey": "a" * 64,
                                   "scopeKey": "b" * 64, "runKey": "c" * 64,
                                   "command": ["sh", "-c", "unexpected"]})
        self.assertFalse(item.active)

    async def test_duplicate_request_does_not_remove_original_lock(self):
        item = self.instance()
        item.active.add("c" * 64)
        original = ("a" * 64, "b" * 64)
        item.scope_locks.add(original)
        await self.dispatch(item, {"version": 1, "profile": launcher.PROFILE, "ownerKey": original[0],
                                   "scopeKey": original[1], "runKey": "c" * 64})
        self.assertIn("c" * 64, item.active)
        self.assertIn(original, item.scope_locks)


if __name__ == "__main__":
    unittest.main()
