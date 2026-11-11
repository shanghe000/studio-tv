#!/usr/bin/env python3
"""Host-owned, fixed-spec Codex stdio launcher. No arbitrary Docker API.

The STUDIO API mounts only the protected Unix socket directory. This daemon must
run outside the API container and under operator control; Docker access is
never delegated to the caller. It never logs raw frames, stderr or auth files.
"""
import asyncio
import contextlib
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import tempfile

PROFILE = "studio-agent-tools-v1"
VERSION = "0.160.0"
CODE_MODE_HOST_SHA256 = "37cab1584302611e9936902219640ab5e7a79fcfccd2504c6e85ea8cb97d0e10"
KEY = re.compile(r"[0-9a-f]{64}\Z")
RUNTIME_UID = 11001
RUNTIME_GID = 11001
MAX_FRAME = 4 * 1024 * 1024
MAX_STATE = 256 * 1024 * 1024
MAX_RUN_SECONDS = 20 * 60
MAX_ACTIVE = 4
MODEL_HOSTS = ("chatgpt.com", "api.openai.com", "auth.openai.com")
CONFIG = '''approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
project_doc_max_bytes = 0
cli_auth_credentials_store = "file"
[analytics]
enabled = false
[agents]
enabled = false
[tools]
view_image = false
[tool_result_log]
max_bytes = 0
[features]
shell_tool = false
unified_exec = false
apps = false
plugins = false
hooks = false
browser_use = false
browser_use_external = false
computer_use = false
in_app_browser = false
image_generation = false
view_image = false
multi_agent = false
multi_agent_v2 = false
goals = false
sleep_tool = false
code_mode = false
# Native dynamic-tool dispatch requires this host; native shell remains off.
code_mode_host = true
skill_search = false
skill_mcp_dependency_install = false
skip_host_skill_discovery = true
workspace_dependencies = false
memories = false
shell_snapshot = false
request_permissions_tool = false
tool_suggest = false
in_app_local_automation = false
in_app_chat = false
realtime_conversation = false
system_proxy_fallback = false
daemon_auto_start = false
'''


def env_path(name):
    value = os.environ[name]
    path = Path(value)
    if not path.is_absolute() or str(path) != value or path.is_symlink():
        raise RuntimeError("invalid launcher configuration")
    return path


def model_addresses():
    """Resolve only operator-owned endpoints, once for each isolated runtime."""
    addresses = {}
    for host in MODEL_HOSTS:
        answers = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
        addresses[host] = sorted({answer[4][0] for answer in answers})
    validate_model_addresses(addresses)
    return addresses


def validate_model_addresses(addresses):
    if set(addresses) != set(MODEL_HOSTS):
        raise RuntimeError("model endpoint resolution failed")
    for values in addresses.values():
        if not values or len(values) > 32:
            raise RuntimeError("model endpoint resolution failed")
        for value in values:
            address = ipaddress.ip_address(value)
            if address.version != 4 or not address.is_global or address.is_multicast or address.is_reserved:
                raise RuntimeError("model endpoint resolution failed")


def direct_egress_rules(addresses):
    validate_model_addresses(addresses)
    # Deny before changing rules; model startup remains gated until completion.
    rules = ["ip6tables -P OUTPUT DROP", "iptables -P OUTPUT DROP", "iptables -F OUTPUT",
             "iptables -A OUTPUT -o lo -j ACCEPT"]
    for address in sorted({value for values in addresses.values() for value in values}):
        rules.append(f"iptables -A OUTPUT -d {address}/32 -p tcp --dport 443 -j ACCEPT")
    return "; ".join(rules)


def read_auth_source(path):
    # A private Unix socket reads the current CLI file by name on every launch,
    # including after logout/re-login or atomic replacement. No model sees it.
    info = path.lstat()
    if info.st_mode & 0o077:
        raise RuntimeError("private CLI authentication unavailable")
    if stat.S_ISSOCK(info.st_mode):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect(str(path))
            chunks = []
            total = 0
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > 2 * 1024 * 1024:
                    raise RuntimeError("private CLI authentication unavailable")
                chunks.append(chunk)
        raw = b"".join(chunks)
        try:
            valid = isinstance(json.loads(raw), dict)
        except (ValueError, UnicodeError):
            valid = False
        if not valid:
            raise RuntimeError("private CLI authentication unavailable")
        return raw
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError("private CLI authentication unavailable")
    return path.read_bytes()


def validate_code_mode_host(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o001 or info.st_mode & 0o022:
        raise RuntimeError("code-mode host must be a protected executable file")
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    if checksum.hexdigest() != CODE_MODE_HOST_SHA256:
        raise RuntimeError("unexpected pinned code-mode host")


def atomic_file(path, data, uid, gid, mode):
    # Parent is controlled and not model-supplied. Replace rather than follow a
    # potentially modified runtime config/auth symlink on subsequent launches.
    fd, name = tempfile.mkstemp(prefix=".launcher-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chown(name, uid, gid)
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


def private_dir(path, uid=0, gid=0):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise RuntimeError("runtime state path invalid")
    os.chown(path, uid, gid)
    os.chmod(path, 0o700)


def state_size(root):
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            entry = Path(directory) / name
            info = entry.lstat()
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
            elif stat.S_ISLNK(info.st_mode):
                # Runtime helpers may be symlinks but are never followed by
                # provisioning, metering or access outside this mount.
                total += info.st_size
        if total > MAX_STATE:
            return total
    return total


class Launcher:
    def __init__(self):
        self.state = env_path("STUDIO_AGENT_STATE_ROOT")
        self.auth = env_path("STUDIO_AGENT_COMPANY_AUTH_FILE")
        self.binary = env_path("STUDIO_AGENT_CODEX_BINARY")
        self.code_mode_host = env_path("STUDIO_AGENT_CODE_MODE_HOST_BINARY")
        self.socket = env_path("STUDIO_AGENT_SOCKET")
        self.image = os.environ["STUDIO_AGENT_RUNTIME_IMAGE"]
        self.caller_uid = int(os.environ.get("STUDIO_AGENT_CALLER_UID", "1000"))
        self.network = "studio-agent-direct"
        self.active = set()
        self.scope_locks = set()
        self.connections = 0
        if not re.fullmatch(r"[a-zA-Z0-9._/:@-]+", self.image):
            raise RuntimeError("invalid runtime image")
        # The operator must inspect native model-visible tool exclusion before
        # enabling this profile. This flag is deliberately false by default.
        if os.environ.get("STUDIO_AGENT_PROFILE_VALIDATED") != "true" and os.environ.get("STUDIO_AGENT_ACCEPTANCE_ONLY") != "true":
            raise RuntimeError("pinned tools-only profile has not been accepted")
        read_auth_source(self.auth)
        version = subprocess.run([str(self.binary), "--version"], env={"PATH": "/usr/bin:/bin"},
                                 capture_output=True, check=True, timeout=5).stdout.decode().strip()
        if version != "codex-cli " + VERSION:
            raise RuntimeError("unexpected Codex version")
        validate_code_mode_host(self.code_mode_host)
        private_dir(self.state)

    def provision(self, owner, scope):
        owner_root = self.state / owner
        private_dir(owner_root)
        root = owner_root / scope
        private_dir(root)
        home = root / "codex"
        os_home = root / "home"
        workspace = root / "workspace"
        for path in (home, os_home, workspace):
            private_dir(path, RUNTIME_UID, RUNTIME_GID)
        if state_size(root) > MAX_STATE:
            raise RuntimeError("runtime state budget reached")
        atomic_file(home / "config.toml", CONFIG.encode(), 0, 0, 0o444)
        # Read the current operator CLI login without sharing its HOME/history.
        atomic_file(home / "auth.json", read_auth_source(self.auth), RUNTIME_UID, RUNTIME_GID, 0o600)
        return root, home, os_home, workspace

    def arguments(self, name, home, os_home, workspace, addresses):
        validate_model_addresses(addresses)
        hosts = []
        for host in MODEL_HOSTS:
            for address in addresses[host]:
                hosts.extend(["--add-host", f"{host}:{address}"])
        return ["/usr/bin/docker", "run", "--rm", "--interactive", "--name", name,
                "--label", "studio.managed=studio-agent", "--network", self.network,
                # All supported endpoints are pinned above. No runtime DNS
                # fallback can replace their public-IP firewall allowlist.
                "--dns", "127.0.0.1", *hosts,
                "--user", f"{RUNTIME_UID}:{RUNTIME_GID}", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges", "--pids-limit=128", "--cpus=1", "--memory=768m",
                "--memory-swap=768m", "--ulimit", "nofile=256:256", "--log-driver=none",
                "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m", "--workdir", "/workspace",
                "--mount", f"type=bind,src={self.binary},dst=/opt/codex/codex,readonly",
                "--mount", f"type=bind,src={self.code_mode_host},dst=/opt/codex/codex-code-mode-host,readonly",
                "--mount", f"type=bind,src={home},dst=/runtime/codex",
                "--mount", f"type=bind,src={os_home},dst=/runtime/home",
                "--mount", f"type=bind,src={workspace},dst=/workspace,readonly",
                "--env", "HOME=/runtime/home", "--env", "CODEX_HOME=/runtime/codex",
                "--env", "PATH=/usr/bin:/bin", "--env", "LANG=C.UTF-8", self.image]

    async def docker(self, *arguments):
        proc = await asyncio.create_subprocess_exec("/usr/bin/docker", *arguments,
                                                    stdout=asyncio.subprocess.DEVNULL,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            if await asyncio.wait_for(proc.wait(), 10) != 0:
                raise RuntimeError("fixed runtime operation failed")
        except BaseException:
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
            raise

    async def network_gate(self, name, addresses):
        # NET_ADMIN exists only in this ephemeral trusted helper sharing this
        # one runtime network namespace. The model container never gets it.
        rules = direct_egress_rules(addresses)
        for _ in range(40):
            try:
                await self.docker("run", "--rm", "--network", "container:" + name,
                                  "--user", "0:0", "--read-only", "--cap-drop=ALL", "--cap-add=NET_ADMIN",
                                  "--security-opt=no-new-privileges", "--pids-limit=16", "--memory=64m",
                                  "--label", "studio.managed=studio-agent-netguard",
                                  "--log-driver=none", "--entrypoint", "/usr/bin/timeout", self.image,
                                  "--signal=KILL", "5", "/bin/sh", "-e", "-c", rules)
                await self.docker("exec", "--user", "11001:11001", name, "/usr/bin/touch", "/tmp/studio-network-ready")
                return
            except Exception:
                await asyncio.sleep(0.1)
        raise RuntimeError("network gate failed")

    async def handle(self, reader, writer):
        proc = None
        run = None
        scope_identity = None
        name = None
        acquired = False
        counted = False
        try:
            peer = writer.get_extra_info("socket").getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _, uid, _ = struct.unpack("3i", peer)
            if uid != self.caller_uid:
                raise RuntimeError("caller rejected")
            if self.connections >= MAX_ACTIVE * 2:
                raise RuntimeError("connection budget reached")
            self.connections += 1
            counted = True
            raw = await asyncio.wait_for(reader.readline(), 5)
            if not raw.endswith(b"\n") or len(raw) > 4096:
                raise RuntimeError("invalid launch request")
            request = json.loads(raw)
            if set(request) != {"version", "profile", "ownerKey", "scopeKey", "runKey"}:
                raise RuntimeError("invalid launch fields")
            if request["version"] != 1 or request["profile"] != PROFILE:
                raise RuntimeError("unsupported launch profile")
            if any(not isinstance(request[key], str) or not KEY.fullmatch(request[key])
                   for key in ("ownerKey", "scopeKey", "runKey")):
                raise RuntimeError("invalid launch identity")
            run = request["runKey"]
            scope_identity = (request["ownerKey"], request["scopeKey"])
            if len(self.active) >= MAX_ACTIVE or run in self.active or scope_identity in self.scope_locks:
                raise RuntimeError("runtime busy")
            self.active.add(run)
            self.scope_locks.add(scope_identity)
            acquired = True
            addresses = await asyncio.wait_for(asyncio.to_thread(model_addresses), 5)
            root, home, os_home, workspace = self.provision(*scope_identity)
            name = "studio-agent-" + run[:32]
            proc = await asyncio.create_subprocess_exec(*self.arguments(name, home, os_home, workspace, addresses),
                                                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL, limit=MAX_FRAME + 1,
                                                        env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"})
            await self.network_gate(name, addresses)
            ready = {"ready": True, "runtimeVersion": VERSION, **request}
            ready.pop("version")
            writer.write(json.dumps(ready, separators=(",", ":")).encode() + b"\n")
            await writer.drain()

            async def inbound():
                while packet := await reader.readline():
                    if not packet.endswith(b"\n") or len(packet) > MAX_FRAME:
                        raise RuntimeError("frame limit")
                    json.loads(packet)
                    proc.stdin.write(packet)
                    await proc.stdin.drain()

            async def outbound():
                while packet := await proc.stdout.readline():
                    if not packet.endswith(b"\n") or len(packet) > MAX_FRAME:
                        raise RuntimeError("frame limit")
                    json.loads(packet)
                    writer.write(packet)
                    await writer.drain()

            async def budget():
                while True:
                    await asyncio.sleep(2)
                    if state_size(root) > MAX_STATE:
                        raise RuntimeError("state budget")

            tasks = [asyncio.create_task(inbound()), asyncio.create_task(outbound()),
                     asyncio.create_task(proc.wait()), asyncio.create_task(budget())]
            try:
                await asyncio.wait_for(asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED), MAX_RUN_SECONDS)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except (Exception, asyncio.CancelledError):
            # Do not print native errors, frame content, account data or paths.
            with contextlib.suppress(Exception):
                writer.write(b'{"ready":false,"code":"STUDIO_RUNTIME_UNAVAILABLE"}\n')
                await writer.drain()
        finally:
            if proc and proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), 2)
            if name:
                with contextlib.suppress(Exception):
                    cleanup = await asyncio.create_subprocess_exec("/usr/bin/docker", "rm", "--force", name,
                                                                 stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                    await asyncio.wait_for(cleanup.wait(), 3)
            if acquired:
                self.active.discard(run)
                self.scope_locks.discard(scope_identity)
            if counted:
                self.connections -= 1
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def serve(self):
        # Reconcile only launcher-owned orphan processes after a daemon crash;
        # their STUDIO runs stay UNKNOWN and are never silently resubmitted.
        for label in ("studio-agent", "studio-agent-netguard"):
            stale = await asyncio.create_subprocess_exec("/usr/bin/docker", "ps", "--quiet", "--all",
                                                        "--filter", "label=studio.managed=" + label,
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            output, _ = await asyncio.wait_for(stale.communicate(), 10)
            if stale.returncode != 0:
                raise RuntimeError("runtime reconciliation failed")
            for identity in output.decode().split():
                if not re.fullmatch(r"[0-9a-f]{12,64}", identity):
                    raise RuntimeError("runtime reconciliation failed")
                await self.docker("rm", "--force", identity)
        parent = self.socket.parent
        parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if parent.is_symlink():
            raise RuntimeError("invalid socket directory")
        os.chown(parent, 0, self.caller_uid)
        os.chmod(parent, 0o750)
        if self.socket.exists():
            if not stat.S_ISSOCK(self.socket.lstat().st_mode):
                raise RuntimeError("invalid socket path")
            self.socket.unlink()
        server = await asyncio.start_unix_server(self.handle, path=str(self.socket), limit=MAX_FRAME + 1)
        os.chown(self.socket, 0, self.caller_uid)
        os.chmod(self.socket, 0o660)
        async with server:
            await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(Launcher().serve())
    except Exception:
        raise SystemExit("STUDIO Agent launcher configuration rejected")
