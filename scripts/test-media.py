#!/usr/bin/env python3
"""Scoped disposable STUDIO media/asset/Studio + Models Router verification; Python standard library only.

Prepare/archive audit (no SSH mutation):
    python3 scripts/test-media.py --prepare
Necessary local client unit tests (joint test deliberately excluded):
    python3 scripts/test-media.py --local-client
After source owners confirm stability, run scoped media tests on deployment-host:
    python3 scripts/test-media.py --run --source-stable

Uncommitted team changes are included. Never reset, commit, deploy, load .env,
publish ports, invoke models, or access an existing container/volume/database.
Only explicit source whitelist entries are uploaded. Test credentials are
generated remotely in 0600 files, mounted read-only; Docker Env/argv contains
file paths only. TEST_DATABASE_URL is loaded inside the disposable Go process.
The HTTP joint test accepts TEST_MODELS_ROUTER_{TOKEN,SIGNING_KEY_B64}_FILE,
avoiding credentials in Docker inspect. Only the explicit MOCK adapter is exercised; no provider/model or paid service is called.
The unconfigured invocation boundary remains 501.
Results: .local/iteration-01/<random-run>/{summary.json,*.jsonl,*.log,...}.
Any test SKIP, package FAIL, missing mandatory PASS, or cleanup failure is fatal.
"""

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import time


STUDIO_MODULE = "studiotv.local/service/api"
ROUTER_MODULE = "studio.example.invalid/models-router"
JOINT_TEST = "TestModelsRouterHTTPIntegration"
UNIT_TESTS = (
    "TestActorProofProtocolVector", "TestSessionBindsActorAndRotatesNonce",
    "TestCapabilitiesAreTypedAndUnavailableIsNotSuccess",
    "TestRejectsMismatchedSessionAndProtocol", "TestRedirectCannotForwardCredentials",
    "TestConfigAndActorFailuresDoNotCallUpstream", "TestUnconfiguredGatewayNeverInventsData",
    "TestSessionKeepsMeasurementProvenanceAndUnknownCosts",
)
STUDIO_REQUIRED = (
    ("internal/core", "TestPostgresCoreIntegration"),
    ("internal/core", "TestM4AAndM4VInspectionWithFFmpeg"),
    ("internal/auth", "TestPostgresIdentityRefreshLogoutAndMigration"),
    ("internal/auth", "TestPostgresLoginTransactionSingleUseAndExpiry"),
    ("internal/auth", "TestPostgresUpstreamSessionRevocationAndRefreshFailClosed"),
    ("internal/auth", "TestPostgresLogoutRevokesBothTabAndCookieSessions"),
    ("internal/bootstrap", "TestPostgresBootstrapLifecycle"),
    ("internal/bootstrap", "TestPostgresProductRegistrarRequiresVerifiedToolAccess"),
    ("internal/bootstrap", "TestPostgresProductCatalogAndLibraryAreToolProtected"),
    ("internal/modules/assistant/adapters/postgres", "TestPostgresGlobalHistoryRestoreWithoutProjectDependency"),
    ("internal/modules/assistant/adapters/postgres", "TestPostgresAssistantPersistenceIsolationAndConstraints"),
    ("internal/modules/assistant/adapters/postgres", "TestPostgresUserTextAppendConcurrencyRollbackReceiptAndRestore"),
    ("internal/modules/library/adapters/postgres", "TestPostgresLibraryConcurrentReceiptsVersionsPersistenceAndOwnership"),
    ("internal/modules/library/adapters/postgres", "TestPostgresLibraryConstraintsAndReadReferenceAuthorization"),
    ("internal/modules/library/adapters/postgres", "TestLibraryMigrationExistingCoreAndRerun"),
    ("internal/modules/modelgateway/adapters/router", JOINT_TEST),
    ("internal/modules/execution/adapters/postgres", "TestPostgresProductExecutionRouterMockAndPrivateHistory"),
    ("internal/core", "TestProductAssetImporterPostgresIntegrityAndOwnership"),
    ("internal/core", "TestProductFileUploadIdempotencyPostgres"),
    ("internal/core", "TestCatalogMaterializationBoundLocalBytesPostgres"),
    ("internal/core", "TestMediaTaskPersistentExecutionAndCancellationPostgres"),
    ("internal/core", "TestStudioPersistentRenderSnapshotAndSignedPreviewPostgres"),
    ("internal/modules/media/adapters/ffmpeg", "TestFFmpegTransformsCompletePlayableOutput"),
    ("internal/modules/media/adapters/chromium", "TestChromiumRendersAuthoredHTMLToPlayableMovie"),
)
ROUTER_REQUIRED = (("internal/adapters/postgres", "TestPostgresSessionIsolationAndConcurrentIdempotency"),)
JOINT_SUBTESTS = (
    "ready_with_real_storage", "same_conversation_isolated_by_actor",
    "recreation_preserves_session_and_timestamps", "both_cross_actor_reads_return_404",
    "new_client_restores_persisted_sessions", "unconfigured_capabilities_are_an_empty_list",
    "router_rejects_altered_actor_headers", "router_rejects_persistent_nonce_replay",
    "invocations_remain_reserved_without_model_execution",
)
# Explicit relative roots + allowed types, never tar a repository directory.
SOURCE_DIRS = {
    "studio": ("apps/api-go/cmd", "apps/api-go/internal", "apps/api-go/migrations", "apps/api-go/vendor"),
    "router": ("cmd", "internal", "pkg", "migrations", "vendor"),
}
CONTRACT_NAMES = (
    "openapi", "auth-extension", "authz-extension", "canvas-extension",
    "domain-extension", "assistant-extension", "model-capabilities", "models-router",
    "library-extension", "model-product-extension", "resources-extension", "organization-extension", "execution-extension", "media-extension",
    "agent-context-extension", "canvas-commands-implemented-extension", "canvas-sync-implemented-extension",
)
SOURCE_FILES = {
    "studio": ("apps/api-go/go.mod", "apps/api-go/go.sum", "infra/api.Dockerfile", "apps/api-go/internal/modules/resources/adapters/postgres/seed/catalog.json",
           "apps/api-go/internal/modules/resources/adapters/postgres/seed/character-media.json",
           "apps/api-go/internal/modules/execution/adapters/stylecatalog/seed/styles.json",
           "apps/api-go/internal/modules/execution/application/seed/portrait-recipes.json",
           "apps/api-go/internal/core/seed/style-media/manifest.json",
           "apps/api-go/internal/core/seed/style-media/cinematic_realism.webp.svg",
           "apps/api-go/internal/core/seed/style-media/anime_illustration.webp.svg",
           "apps/api-go/internal/core/seed/style-media/product_ad.webp.svg",
           "apps/api-go/internal/core/seed/style-media/editorial_fashion.webp.svg")
          + tuple("contracts/" + name + suffix for name in CONTRACT_NAMES for suffix in (".json", ".yaml")),
    "router": ("go.mod", "go.sum", "Dockerfile", "contracts/contract_test.go",
               "contracts/models-router.json", "contracts/models-router.yaml"),
}
SOURCE_SUFFIXES = {".go", ".mod", ".sum", ".sql", ".s", ".S", ".c", ".h", ".txt"}
LICENSE_NAMES = {"LICENSE", "PATENTS", "NOTICE", "AUTHORS", "CONTRIBUTORS"}
FORBIDDEN_PARTS = {".git", ".local", "node_modules", ".secrets", "secrets", "__pycache__", "sources"}
FORBIDDEN_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".crt", ".der", ".jks", ".keystore"}
ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
REMOTE_PATTERN = re.compile(r"^/tmp/studiotv-iteration-[a-zA-Z0-9_-]+$")
PINNED_GO = "public.ecr.aws/docker/library/golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd"


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def safe_source(relative):
    p = PurePosixPath(relative)
    return (not p.is_absolute() and ".." not in p.parts
            and not any(x in FORBIDDEN_PARTS or x.startswith(".env") for x in p.parts)
            and p.suffix.lower() not in FORBIDDEN_SUFFIXES)


def source_files(root, kind):
    candidates = {root / f for f in SOURCE_FILES[kind] if (root / f).is_file()}
    for directory in SOURCE_DIRS[kind]:
        folder = root / directory
        if not folder.is_dir() or folder.is_symlink():
            raise RuntimeError("missing or symlinked source whitelist root: " + directory)
        for current, dirs, names in os.walk(folder, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in FORBIDDEN_PARTS
                             and not d.startswith(".env") and not (Path(current) / d).is_symlink())
            for name in names:
                path = Path(current) / name
                relative = path.relative_to(root).as_posix()
                embedded_fixture = (kind == "router" and relative.startswith("internal/adapters/mock/fixtures/"))
                embedded_schema = "/vendor/github.com/santhosh-tekuri/jsonschema/v6/metaschemas/" in "/" + relative
                if path.suffix in SOURCE_SUFFIXES or name in LICENSE_NAMES or embedded_schema or embedded_fixture:
                    if safe_source(relative):
                        candidates.add(path)
    if kind == "studio":
        folder=root/"apps/web/public/project/assets"
        for path in folder.rglob("*"):
            if path.is_file() and not path.is_symlink() and safe_source(path.relative_to(root).as_posix()): candidates.add(path)
    for path in sorted(candidates):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink() or root not in path.resolve().parents or not safe_source(relative):
            raise RuntimeError("unsafe source whitelist entry: " + relative)
        yield path, relative


def snapshot(studio, router, output):
    manifest = {"whitelist": {"directories": SOURCE_DIRS, "files": SOURCE_FILES}, "files": []}
    archive = output / "source.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for kind, root in (("studio", studio), ("router", router)):
            for path, relative in source_files(root, kind):
                # Read each file once: its archived bytes and recorded hash agree.
                body = path.read_bytes()
                member = kind + "/" + relative
                info = tarfile.TarInfo(member)
                info.size, info.mode, info.mtime = len(body), 0o644, 0
                tar.addfile(info, io.BytesIO(body))
                manifest["files"].append({"path": member, "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)})
    # Detect concurrent edits/additions/deletions during the source snapshot.
    current = {}
    for kind, root in (("studio", studio), ("router", router)):
        for path, relative in source_files(root, kind):
            current[kind + "/" + relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    if current != {f["path"]: f["sha256"] for f in manifest["files"]}:
        raise RuntimeError("sources changed while archiving; wait for stable source and retry")
    entries = {f["path"] for f in manifest["files"]}
    for required in ("studio/infra/api.Dockerfile", "studio/apps/api-go/vendor/modules.txt",
                     "studio/contracts/openapi.json", "studio/contracts/domain-extension.json",
                     "studio/contracts/assistant-extension.json",
                     "studio/apps/api-go/internal/modules/modelgateway/adapters/router/integration_test.go",
                     "router/Dockerfile", "router/vendor/modules.txt", "router/internal/bootstrap/config.go"):
        if required not in entries:
            raise RuntimeError("required whitelist source missing: " + required)
    for kind, root, dockerfile in (("studio", studio, "infra/api.Dockerfile"), ("router", router, "Dockerfile")):
        if not (root / dockerfile).read_text().startswith("FROM " + PINNED_GO + " AS "):
            raise RuntimeError(kind + " Dockerfile must use the agreed pinned cached Go builder")
    # These are source files, not environment configuration or credentials.
    for kind, root in (("studio", studio), ("router", router)):
        git = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True)
        manifest[kind + "_revision"] = git.stdout.strip() if git.returncode == 0 else None
    manifest["archive_sha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
    write_json(output / "source-manifest.json", manifest)
    return archive


def summarize(raw, output, label, module, required, returncode, joint=False):
    tests, packages, runs, problems, lines = {}, {}, set(), [], []
    for line in raw.splitlines():
        try:
            event = json.loads(line)
            if not isinstance(event, dict) or "Action" not in event:
                raise ValueError()
        except (ValueError, TypeError):
            if line.strip():
                problems.append("non-JSON Go test output")
                lines.append(line + "\n")
            continue
        if "Output" in event:
            lines.append(event["Output"])
        package, test, action = event.get("Package", ""), event.get("Test"), event["Action"]
        if test and action == "run":
            runs.add((package, test))
        if action in ("pass", "fail", "skip"):
            if test:
                tests[(package, test)] = action
            else:
                packages[package] = action
    for relative, name in required:
        key = (module + "/" + relative, name)
        if key not in runs or tests.get(key) != "pass":
            problems.append("mandatory test did not run and PASS: " + "/".join(key))
    if joint:
        package = STUDIO_MODULE + "/internal/modules/modelgateway/adapters/router"
        for subtest in JOINT_SUBTESTS:
            key = (package, JOINT_TEST + "/" + subtest)
            if key not in runs or tests.get(key) != "pass":
                problems.append("mandatory joint subtest did not run and PASS: " + subtest)
    skipped = [p + "/" + t for (p, t), a in tests.items() if a == "skip"]
    failed = [p + "/" + t for (p, t), a in tests.items() if a == "fail"]
    if skipped:
        problems.append("test SKIP is forbidden in this verification")
    if failed or any(a == "fail" for a in packages.values()):
        problems.append("Go test failure")
    if returncode:
        problems.append("test process exited nonzero: " + str(returncode))
    if not tests or not packages:
        problems.append("missing machine-readable test completion")
    result = {"status": "PASS" if not problems else "FAIL", "returncode": returncode,
              "tests": {a: sum(x == a for x in tests.values()) for a in ("pass", "fail", "skip")},
              "packages": {a: sum(x == a for x in packages.values()) for a in ("pass", "fail", "skip")},
              "skipped_tests": skipped, "failed_tests": failed, "problems": sorted(set(problems)),
              "test_results": [{"package": p, "test": t, "action": a} for (p, t), a in sorted(tests.items())]}
    (output / (label + ".jsonl")).write_text(raw)
    (output / (label + ".log")).write_text("".join(lines))
    write_json(output / (label + "-summary.json"), result)
    return result


def local_client(studio, output):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TEST_MODELS_ROUTER_", "MODELS_ROUTER_"))
           and k not in ("DATABASE_URL", "TEST_DATABASE_URL", "ROUTER_DATABASE_URL", "GOFLAGS")}
    env.update(GOTOOLCHAIN="local", GOPROXY="off", GOSUMDB="off")
    command = ["go", "test", "-mod=vendor", "-count=1", "-v", "-json", "-timeout=2m",
               "-run", "^(" + "|".join(UNIT_TESTS) + ")$", "./internal/modules/modelgateway/adapters/router"]
    process = subprocess.run(command, cwd=studio / "apps/api-go", env=env, capture_output=True, text=True, timeout=180)
    required = [("internal/modules/modelgateway/adapters/router", t) for t in UNIT_TESTS]
    result = summarize(process.stdout, output, "studio-client-unit", STUDIO_MODULE, required, process.returncode)
    (output / "studio-client-unit-stderr.log").write_text(process.stderr)
    result["scope"] = "client unit tests only; PostgreSQL, ffmpeg and joint HTTP suite NOT RUN"
    write_json(output / "summary.json", result)
    return result["status"] == "PASS"


class RemoteRun:
    def __init__(self, root):
        self.root, self.output = root, root / "output"
        self.output.mkdir(mode=0o700, exist_ok=True)
        self.token = root.name.removeprefix("studiotv-iteration-")
        self.resources = {"containers": [], "network_ids": [], "images": []}
        self.result = {"status": "FAIL", "suites": {}, "errors": [], "cleanup_errors": [], "resources": self.resources}
        self.sensitive = []

    def redact(self, text):
        for value in self.sensitive:
            text = text.replace(value, "[REDACTED]")
        return text

    def record(self):
        write_json(self.output / "resources.json", self.resources)

    def command(self, argv, label, timeout=120, check=True):
        # Never log argv or host environment. Docker arguments contain no secret values.
        process = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        (self.output / (label + ".log")).write_text(self.redact(process.stdout + process.stderr))
        if check and process.returncode:
            raise RuntimeError(label + " failed; inspect its redacted log")
        return process

    def secret(self, directory, filename, value):
        path = directory / filename
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(value + "\n")
        self.sensitive.append(value)
        return path

    def build(self, kind, target, dockerfile):
        print("Building isolated " + kind + " " + target + " image", flush=True)
        tag = "studiotv-iteration-" + self.token + "-" + kind + "-" + target + ":test"
        iidfile = self.root / (kind + "-" + target + ".iid")
        self.resources["images"].append({"tag": tag, "id": None})
        self.record()
        self.command(["docker", "build", "--platform=linux/amd64", "--pull=false", "--target", target,
                      "--iidfile", str(iidfile), "-t", tag, "-f", str(self.root / kind / dockerfile),
                      str(self.root / kind)], "build-" + kind + "-" + target, timeout=1800)
        iid = iidfile.read_text().strip()
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", iid):
            raise RuntimeError("invalid newly built image ID")
        self.resources["images"][-1]["id"] = iid
        self.record()
        return tag

    def container(self, label, image, options=(), command=()):
        cidfile = self.root / (label + ".cid")
        process = self.command(["docker", "create", "--platform=linux/amd64", "--cidfile", str(cidfile),
                                "--label", "studiotv.iteration=" + self.token,
                                "--network", self.resources["network_ids"][0], *options, image, *command], "create-" + label)
        cid = process.stdout.strip()
        if not ID_PATTERN.fullmatch(cid) or cidfile.read_text().strip() != cid:
            raise RuntimeError("invalid created container ID")
        self.resources["containers"].append({"label": label, "id": cid})
        self.record()
        return cid

    def start(self, cid, label):
        self.command(["docker", "start", cid], "start-" + label)

    def wait_pg(self, cid, user, database, label):
        for _ in range(40):
            process = self.command(["docker", "exec", cid, "pg_isready", "-U", user, "-d", database], "ready-" + label, check=False)
            if process.returncode == 0:
                return
            time.sleep(1)
        raise RuntimeError("isolated PostgreSQL did not become ready: " + label)

    def suite(self, label, image, options):
        print("Running full " + label + " Go suite against disposable PostgreSQL", flush=True)
        # JSON Output preserves the verbose Go log and separate PASS/FAIL/SKIP.
        shell = ('export TEST_DATABASE_URL="$(cat /run/test-secrets/test-dsn)"; '
                 'exec go test -mod=vendor -count=1 -v -json -timeout=8m ./...')
        cid = self.container(label, image, options, ["sh", "-ec", shell])
        self.start(cid, label)
        waited = self.command(["docker", "wait", cid], "wait-" + label, timeout=900)
        exitcode = int(waited.stdout.strip())
        logged = self.command(["docker", "logs", cid], "raw-" + label, check=False)
        raw, stderr = self.redact(logged.stdout), self.redact(logged.stderr)
        (self.output / (label + "-stderr.log")).write_text(stderr)
        module, required = (STUDIO_MODULE, STUDIO_REQUIRED) if label == "studio" else (ROUTER_MODULE, ROUTER_REQUIRED)
        self.result["suites"][label] = summarize(raw, self.output, label, module, required, exitcode, joint=label == "studio")

    def execute(self):
        self.command(["uname", "-sm"], "platform")
        if (self.output / "platform.log").read_text().strip() != "Linux x86_64":
            raise RuntimeError("requires Linux amd64 isolation host")
        # Inspect only the allowed cached image, never production containers/volumes.
        self.command(["docker", "image", "inspect", "postgres:17-alpine", "--format", "{{.Id}}"], "postgres-image")
        studio = self.build("studio", "test", "infra/api.Dockerfile")
        router = self.build("router", "integration-test", "Dockerfile")
        runtime = self.build("router", "runtime", "Dockerfile")
        network_file = self.root / "network.id"
        with network_file.open("w") as file:
            process = subprocess.run(["docker", "network", "create", "--internal", "--driver", "bridge",
                                      "--label", "studiotv.iteration=" + self.token, "studiotv-iteration-" + self.token],
                                     stdout=file, stderr=subprocess.PIPE, text=True, timeout=30)
        network_id = network_file.read_text().strip()
        if ID_PATTERN.fullmatch(network_id):
            self.resources["network_ids"].append(network_id)
            self.record()
        if process.returncode or not self.resources["network_ids"]:
            raise RuntimeError("isolated internal network creation failed")
        internal = self.command(["docker", "network", "inspect", network_id, "--format", "{{.Internal}}"], "network-isolation")
        if internal.stdout.strip() != "true":
            raise RuntimeError("test network is not internal")
        self.result["isolation"] = {"internal_network": True, "published_ports": False,
                                    "database_containers": ["studio-pg", "router-pg"], "model_adapters": "explicit mock only, no external model calls"}
        secret_root = self.root / "test-secrets"
        secret_root.mkdir(mode=0o700)
        for kind in ("studio", "router"):
            directory = secret_root / kind
            directory.mkdir(mode=0o700)
            password = secrets.token_hex(32)
            user, database = kind + "_iteration_test", kind + "_iteration_test"
            self.secret(directory, "pg-password", password)
            dsn = "postgres://" + user + ":" + password + "@" + kind + "-test-db:5432/" + database + "?sslmode=disable"
            self.secret(directory, "test-dsn", dsn)
            mount = "type=bind,src=" + str(directory) + ",dst=/run/test-secrets,readonly"
            pg = self.container(kind + "-pg", "postgres:17-alpine", [
                "--network-alias", kind + "-test-db", "--mount", mount,
                "--tmpfs", "/var/lib/postgresql/data:rw,size=768m",
                "-e", "POSTGRES_USER=" + user, "-e", "POSTGRES_DB=" + database,
                "--entrypoint", "sh"], ["-ec", 'export POSTGRES_PASSWORD="$(cat /run/test-secrets/pg-password)"; exec docker-entrypoint.sh postgres'])
            self.start(pg, kind + "-pg")
            self.wait_pg(pg, user, database, kind + "-pg")
        studio_secrets, router_secrets = secret_root / "studio", secret_root / "router"
        token, key = secrets.token_hex(32), base64.b64encode(secrets.token_bytes(32)).decode()
        self.secret(studio_secrets, "router-token", token)
        self.secret(studio_secrets, "router-signing-key-b64", key)
        registry = {"credentials": [{"serviceRef": "studio-iteration-api", "clientApp": "studio-iteration-test", "token": token, "signingKeyB64": key}]}
        self.secret(router_secrets, "credentials.json", json.dumps(registry))
        mounts = {kind: ["--mount", "type=bind,src=" + str(secret_root / kind) + ",dst=/run/test-secrets,readonly"] for kind in ("studio", "router")}
        # Run Router's full suite before starting its runtime against its test PG.
        self.suite("router", router, [*mounts["router"], "-e", "GOTOOLCHAIN=local", "-e", "GOPROXY=off", "-e", "GOSUMDB=off"])
        user = str(os.getuid()) + ":" + str(os.getgid())
        runtime_options = [*mounts["router"], "--user", user,
                           "-e", "ROUTER_DATABASE_URL_FILE=/run/test-secrets/test-dsn"]
        migration = self.container("router-migration", runtime, [*runtime_options, "--entrypoint", "migrate"])
        self.start(migration, "router-migration")
        waited = self.command(["docker", "wait", migration], "wait-router-migration")
        self.command(["docker", "logs", migration], "router-migration", check=False)
        if waited.stdout.strip() != "0":
            raise RuntimeError("Router migration failed on disposable PG")
        service = self.container("router-service", runtime, [*runtime_options, "--network-alias", "test-router",
            "-e", "ROUTER_LISTEN_ADDR=:8090", "-e", "ROUTER_SERVICE_CREDENTIALS_FILE=/run/test-secrets/credentials.json"])
        self.start(service, "router-service")
        mock_service = self.container("router-mock-service", runtime, [*runtime_options, "--network-alias", "test-router-mock",
            "-e", "ROUTER_ADAPTER_MODE=mock", "-e", "ROUTER_LISTEN_ADDR=:8090", "-e", "ROUTER_SERVICE_CREDENTIALS_FILE=/run/test-secrets/credentials.json"])
        self.start(mock_service, "router-mock-service")
        # Readiness is bounded and checked by the same joint Go test, after a
        # TCP readiness check from the STUDIO container's own isolated network.
        shell = ('export TEST_DATABASE_URL="$(cat /run/test-secrets/test-dsn)"; '
                 'exec go test -mod=vendor -race -count=1 -v -json -timeout=8m -run "TestProductAsset|TestProductFile|TestMedia|TestStudioPersistent|TestStudioEdits|TestCatalogMaterialization|TestPLY|TestOBJ|TestChromium|TestFFmpeg|TestReverse|TestStudioBundle|TestEveryProtected" ./...')
        options = [*mounts["studio"], "-e", "GOTOOLCHAIN=local", "-e", "GOPROXY=off", "-e", "GOSUMDB=off",
            "-e", "TEST_MODELS_ROUTER_URL=http://test-router:8090", "-e", "TEST_MODELS_ROUTER_MOCK_BASE_URL=http://test-router-mock:8090", "-e", "TEST_CHROMIUM_SANDBOX_MODE=container", "-e", "CGO_ENABLED=1", "-e", "TEST_MODELS_ROUTER_CLIENT_APP=studio-iteration-test",
            "-e", "TEST_MODELS_ROUTER_TOKEN_FILE=/run/test-secrets/router-token",
            "-e", "TEST_MODELS_ROUTER_SIGNING_KEY_B64_FILE=/run/test-secrets/router-signing-key-b64"]
        # ffmpeg/ffprobe must exist; Go's media test PASS is separately mandatory.
        preflight = 'command -v chromium >/dev/null || exit 92; command -v ffmpeg >/dev/null || exit 90; command -v ffprobe >/dev/null || exit 91; '
        # Bash /dev/tcp needs no additional image dependency, and publishes no port.
        ready = 'for i in $(seq 1 40); do if bash -c "exec 3<>/dev/tcp/test-router/8090" 2>/dev/null; then break; fi; sleep 1; done; '
        cid = self.container("studio", studio, options, ["sh", "-ec", preflight + ready + shell])
        print("Running scoped STUDIO media/asset/Studio suite with actual local tools", flush=True)
        self.start(cid, "studio")
        waited = self.command(["docker", "wait", cid], "wait-studio", timeout=900)
        logged = self.command(["docker", "logs", cid], "raw-studio", check=False)
        (self.output / "studio-stderr.log").write_text(self.redact(logged.stderr))
        self.result["suites"]["studio"] = summarize(self.redact(logged.stdout), self.output, "studio", STUDIO_MODULE, STUDIO_REQUIRED, int(waited.stdout.strip()), joint=False)
        self.result["status"] = "PASS" if all(s["status"] == "PASS" for s in self.result["suites"].values()) else "FAIL"

    def cleanup(self):
        # cidfiles also recover exact IDs if interrupted just after docker create.
        known = {c["id"] for c in self.resources["containers"]}
        for path in sorted(self.root.glob("*.cid")):
            cid = path.read_text().strip()
            if ID_PATTERN.fullmatch(cid) and cid not in known:
                self.resources["containers"].append({"label": path.stem, "id": cid})
                known.add(cid)
        network_file = self.root / "network.id"
        if network_file.exists():
            nid = network_file.read_text().strip()
            if ID_PATTERN.fullmatch(nid) and nid not in self.resources["network_ids"]:
                self.resources["network_ids"].append(nid)
        self.record()
        for container in reversed(self.resources["containers"]):
            cid, label = container["id"], container["label"]
            if not ID_PATTERN.fullmatch(cid):
                continue
            try:
                self.command(["docker", "logs", cid], "final-" + label, check=False)
                removed = self.command(["docker", "rm", "-f", "-v", cid], "cleanup-" + label, check=False)
                if removed.returncode and "No such container" not in removed.stderr and "No such object" not in removed.stderr:
                    raise RuntimeError("cleanup failed for exact container ID: " + cid)
            except Exception as exc:
                self.result["cleanup_errors"].append(str(exc))
        for nid in self.resources["network_ids"]:
            try:
                removed = self.command(["docker", "network", "rm", nid], "cleanup-network", check=False)
                if removed.returncode and "not found" not in removed.stderr and "No such network" not in removed.stderr:
                    raise RuntimeError("cleanup failed for exact network ID: " + nid)
            except Exception as exc:
                self.result["cleanup_errors"].append(str(exc))
        # Remove only our unique tags, never a potentially shared cached image ID.
        for image in self.resources["images"]:
            if image["id"] is None:
                # A build may finish just as its caller is interrupted. Only
                # inspect our recorded unique tag, never cached shared tags.
                try:
                    found = self.command(["docker", "image", "inspect", image["tag"], "--format", "{{.Id}}"],
                                         "recover-" + image["tag"].split(":")[0], check=False)
                    if found.returncode:
                        if "No such image" not in found.stderr and "No such object" not in found.stderr:
                            self.result["cleanup_errors"].append("cannot verify unique test image cleanup: " + image["tag"])
                        continue
                    image["id"] = found.stdout.strip()
                except Exception as exc:
                    self.result["cleanup_errors"].append(str(exc))
                    continue
            try:
                removed = self.command(["docker", "image", "rm", image["tag"]], "cleanup-image-" + image["tag"].split(":")[0], check=False)
                if removed.returncode and "No such image" not in removed.stderr and "No such object" not in removed.stderr:
                    raise RuntimeError("cleanup failed for unique image tag: " + image["tag"])
            except Exception as exc:
                self.result["cleanup_errors"].append(str(exc))
        shutil.rmtree(self.root / "test-secrets", ignore_errors=True)
        self.record()
        if self.result["cleanup_errors"]:
            self.result["status"] = "FAIL"
        write_json(self.output / "summary.json", self.result)


def remote_main(root):
    if not REMOTE_PATTERN.fullmatch(str(root)) or root.is_symlink():
        raise RuntimeError("refusing non-test remote path")
    manifest = json.loads((root / "source-manifest.json").read_text())
    archive = root / "source.tar.gz"
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest["archive_sha256"]:
        raise RuntimeError("uploaded archive checksum mismatch")
    expected = {x["path"]: x for x in manifest["files"]}
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != set(expected):
            raise RuntimeError("archive whitelist manifest mismatch")
        for member in members:
            if not member.isfile() or not safe_source(member.name):
                raise RuntimeError("unsafe archive member")
            body = tar.extractfile(member).read()
            if hashlib.sha256(body).hexdigest() != expected[member.name]["sha256"]:
                raise RuntimeError("source member checksum mismatch")
            destination = root / member.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(body)
    runner = RemoteRun(root)
    write_json(root / "runner-process.json", {"pid": os.getpid(), "start_ticks": process_ticks(os.getpid())})
    def interrupted(signum, frame):
        raise InterruptedError("verification interrupted by signal " + str(signum))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        runner.execute()
    except Exception as exc:
        runner.result["errors"].append(runner.redact(str(exc)))
    finally:
        # Finish cleanup if a second terminal interrupt arrives.
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        runner.cleanup()
        (root / "finished").write_text("cleanup complete\n")
    print("Isolated verification " + runner.result["status"] + "; machine artifacts saved.", flush=True)
    return runner.result["status"] == "PASS"


def process_ticks(pid):
    # This reads only the recorded test runner's process identity, not its env.
    try:
        return (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def remote_cleanup(root):
    """Recover exact resources after interrupted/lost SSH; never kill by name."""
    if not REMOTE_PATTERN.fullmatch(str(root)) or root.is_symlink():
        raise RuntimeError("refusing non-test cleanup path")
    identity = root / "runner-process.json"
    if identity.exists():
        record = json.loads(identity.read_text())
        pid = record["pid"]
        if record["start_ticks"] and pid != os.getpid() and process_ticks(pid) == record["start_ticks"]:
            os.kill(pid, signal.SIGTERM)
            for _ in range(45):
                if (root / "finished").exists() or process_ticks(pid) != record["start_ticks"]:
                    break
                time.sleep(1)
            else:
                print("Test runner has not finished cleanup; retain its exact resource records.", flush=True)
                return False
    summary = root / "output" / "summary.json"
    if (root / "finished").exists() and summary.exists() and not json.loads(summary.read_text()).get("cleanup_errors"):
        return True
    runner = RemoteRun(root)
    resources = root / "output" / "resources.json"
    if resources.exists():
        runner.resources = json.loads(resources.read_text())
        runner.result["resources"] = runner.resources
    # A killed runner might not have persisted its in-memory redaction list.
    # Recover only secrets generated inside this task's private temp directory.
    secret_root = root / "test-secrets"
    if secret_root.exists():
        for file in secret_root.glob("*/*"):
            if file.is_file() and not file.is_symlink():
                value = file.read_text().strip()
                runner.sensitive.append(value)
                if file.name == "credentials.json":
                    for credential in json.loads(value)["credentials"]:
                        runner.sensitive.extend((credential["token"], credential["signingKeyB64"]))
    runner.result["errors"].append("verification interrupted; exact-ID cleanup recovered")
    runner.cleanup()
    (root / "finished").write_text("cleanup complete\n")
    return not runner.result["cleanup_errors"]


def remote_run(args, output):
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.host]
    allocation = subprocess.run(ssh + ["python3 -c " + shlex.quote("import tempfile; print(tempfile.mkdtemp(prefix='studiotv-iteration-', dir='/tmp'))")],
                                capture_output=True, text=True, check=True)
    remote = allocation.stdout.strip()
    if not REMOTE_PATTERN.fullmatch(remote):
        raise RuntimeError("unexpected allocated remote test path")
    write_json(output / "remote.json", {"host": args.host, "directory": remote})
    result, errors, launched = False, [], False
    try:
        subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(output / "source.tar.gz"),
                        str(output / "source-manifest.json"), str(Path(__file__).resolve()), args.host + ":" + remote + "/"], check=True)
        command = "python3 " + shlex.quote(remote + "/test-media.py") + " --remote-run " + shlex.quote(remote)
        launched = True
        with (output / "remote-run.log").open("w") as log:
            with subprocess.Popen(ssh + [command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as process:
                try:
                    for line in process.stdout:
                        log.write(line)
                        log.flush()
                        print(line, end="", flush=True)
                    result = process.wait() == 0
                except BaseException:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    raise
    finally:
        cleaned = True
        if launched:
            command = "python3 " + shlex.quote(remote + "/test-media.py") + " --remote-cleanup " + shlex.quote(remote)
            try:
                process = subprocess.run(ssh + [command], capture_output=True, text=True, timeout=60)
                cleaned = process.returncode == 0
            except Exception:
                cleaned = False
            if not cleaned:
                errors.append("remote exact-ID cleanup not confirmed; retained resource records at " + remote)
        try:
            if launched:
                subprocess.run(["scp", "-q", "-r", "-o", "BatchMode=yes", args.host + ":" + remote + "/output/.", str(output)], check=True)
        except Exception:
            errors.append("could not retrieve all remote verification artifacts")
        # Only our recorded mkdtemp path is removed, never a name glob.
        if cleaned:
            removal = "import shutil; shutil.rmtree(" + repr(remote) + ")"
            process = subprocess.run(ssh + ["python3 -c " + shlex.quote(removal)], capture_output=True, text=True)
            if process.returncode:
                errors.append("remote temporary directory cleanup failed: " + remote)
        if errors:
            write_json(output / "transport-errors.json", {"errors": errors})
            summary = output / "summary.json"
            data = json.loads(summary.read_text()) if summary.exists() else {}
            data.update(status="FAIL", transport_errors=errors)
            write_json(summary, data)
            result = False
    summary = output / "summary.json"
    if not summary.is_file() or json.loads(summary.read_text()).get("status") != "PASS":
        result = False
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--prepare", action="store_true")
    modes.add_argument("--local-client", action="store_true")
    modes.add_argument("--run", action="store_true")
    modes.add_argument("--remote-run", type=Path, help=argparse.SUPPRESS)
    modes.add_argument("--remote-cleanup", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--development-snapshot", action="store_true", help="verify an immutable intermediate snapshot; rerun after subsequent edits")
    parser.add_argument("--source-stable", action="store_true", help="both source owners have finished their changes")
    parser.add_argument("--host", default="deployment-host")
    parser.add_argument("--router-repo", type=Path)
    args = parser.parse_args()
    if args.remote_run:
        return 0 if remote_main(args.remote_run) else 1
    if args.remote_cleanup:
        return 0 if remote_cleanup(args.remote_cleanup) else 1
    if args.run and not (args.source_stable or args.development_snapshot):
        parser.error("--run requires --source-stable; wait for both source owners before full verification")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", args.host):
        parser.error("host must be a simple SSH host/alias")
    studio = Path(__file__).resolve().parent.parent
    output = studio / ".local" / "iteration-01" / (time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(6))
    output.mkdir(parents=True, mode=0o700)
    print("Verification artifacts: " + str(output), flush=True)
    if args.local_client:
        ok = local_client(studio, output)
    else:
        router = (args.router_repo or studio.parent / "studio-model-router").resolve()
        snapshot(studio, router, output)
        if args.prepare:
            write_json(output / "summary.json", {"status": "PREPARED", "full_suite": "NOT RUN; source archive only"})
            ok = True
        else:
            ok = remote_run(args, output)
    print(("PASS" if ok else "FAIL") + (" (source archive only; no tests run)" if args.prepare else ""), flush=True)
    return 0 if ok else 1


STUDIO_REQUIRED = (('internal/core', 'TestProductAssetImporterPostgresIntegrityAndOwnership'), ('internal/core', 'TestProductFileUploadIdempotencyPostgres'), ('internal/core', 'TestMediaTaskPersistentExecutionAndCancellationPostgres'), ('internal/core', 'TestStudioPersistentRenderSnapshotAndSignedPreviewPostgres'), ('internal/core', 'TestCatalogMaterializationBoundLocalBytesPostgres')) + (("internal/modules/media/adapters/chromium","TestChromiumRendersAuthoredHTMLToPlayableMovie"),("internal/modules/media/adapters/ffmpeg","TestFFmpegTransformsCompletePlayableOutput"),("internal/core","TestStudioEditsPersistentOwnedHTMLAndReceiptsPostgres"),("internal/modules/media/adapters/chromium","TestChromiumExecutesActualStudioFrameAndEditBridge"))
if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as exc:
        # No environment/argv dump or traceback containing secret values.
        print("Verification stopped: " + type(exc).__name__, file=sys.stderr)
        sys.exit(1)
