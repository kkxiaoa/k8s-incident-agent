"""Isolated candidate startup, not Kubernetes/model or repair acceptance evidence."""

import importlib.util
import json
import os
import platform
import secrets
import shutil
import sqlite3
import ssl
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import IO

from argon2 import PasswordHasher
from argon2.profiles import RFC_9106_LOW_MEMORY

from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.runtime.paths import RuntimePaths

# A total hang bound for migration, backup, and startup on emulated platforms.
STARTUP_SECONDS = 300
OUTPUT_TAIL_BYTES = 2000


class KubernetesStub(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def reply(self, status: int, body: object) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path != "/version/":
            self.reply(404, {})
            return
        self.reply(
            200,
            {
                "major": "1",
                "minor": "36",
                "gitVersion": "v1.36.2",
                "gitCommit": "smoke",
                "gitTreeState": "clean",
                "buildDate": "2026-09-22T00:00:00Z",
                "goVersion": "smoke",
                "compiler": "gc",
                "platform": "linux/amd64",
            },
        )

    def do_POST(self) -> None:
        if self.path != "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews":
            self.reply(404, {})
            return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 8192:
            self.reply(400, {})
            return
        attributes = json.loads(self.rfile.read(size))["spec"]["resourceAttributes"]
        key = (
            attributes.get("group", ""),
            attributes["resource"],
            attributes.get("subresource", ""),
            attributes["verb"],
        )
        namespaced = {
            ("apps", "deployments", "", "get"),
            ("apps", "replicasets", "", "list"),
            ("", "pods", "", "list"),
            ("", "pods", "log", "get"),
            ("events.k8s.io", "events", "", "list"),
            ("", "services", "", "get"),
            ("discovery.k8s.io", "endpointslices", "", "list"),
            ("", "persistentvolumeclaims", "", "get"),
        }
        cluster = {
            ("storage.k8s.io", "storageclasses", "", "get"),
            ("authorization.k8s.io", "selfsubjectaccessreviews", "", "create"),
        }
        allowed = (
            key in namespaced
            and attributes.get("namespace") == "k8s-incident-scenarios"
        ) or (key in cluster and not attributes.get("namespace"))
        self.reply(
            201,
            {
                "apiVersion": "authorization.k8s.io/v1",
                "kind": "SelfSubjectAccessReview",
                "spec": {"resourceAttributes": attributes},
                "status": {"allowed": allowed, "denied": not allowed},
            },
        )


def verify_backup(root: Path, destination: Path, deadline: float) -> None:
    paths = RuntimePaths.prepare(root)
    artifact = (
        paths.run_artifacts / "00000000-0000-4000-8000-000000000001" / "probe.txt"
    )
    artifact.parent.mkdir(parents=True, mode=0o700)
    paths.run_artifacts.chmod(0o700)
    artifact.write_text("isolated backup probe", encoding="utf-8")
    artifact.chmod(0o600)
    command = ["runtime", "backup", "--destination", str(destination)]
    # Keep the connection open so the committed record remains in the WAL.
    with closing(sqlite3.connect(paths.checkpoint_database)) as checkpoint:
        checkpoint.execute("PRAGMA journal_mode=WAL")
        checkpoint.execute("PRAGMA wal_autocheckpoint=0")
        checkpoint.execute("CREATE TABLE smoke_probe (value TEXT)")
        checkpoint.execute("INSERT INTO smoke_probe VALUES ('committed WAL record')")
        checkpoint.commit()
        paths.checkpoint_database.chmod(0o600)
        lock = RuntimeLock(paths.runtime_lock)
        lock.acquire()
        try:
            refused = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=deadline - time.monotonic(),
                check=False,
            )
            if refused.returncode != 1 or json.loads(refused.stderr) != {
                "error": {"code": "runtime_in_use", "phase": "backup"}
            }:
                raise RuntimeError(
                    "Candidate backup did not reject an occupied Runtime"
                )
        finally:
            lock.release()
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=deadline - time.monotonic(),
            check=True,
        )
        backup = destination / json.loads(result.stdout)["backup"]
        for name in ("incidents.sqlite3", "checkpoints.sqlite3"):
            with closing(
                sqlite3.connect(f"file:{backup / name}?mode=ro", uri=True)
            ) as copy:
                if copy.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise RuntimeError("Candidate backup database is not intact")
                query = (
                    "SELECT version_num FROM alembic_version"
                    if name == "incidents.sqlite3"
                    else "SELECT value FROM smoke_probe"
                )
                with closing(
                    sqlite3.connect(f"file:{root / name}?mode=ro", uri=True)
                ) as source:
                    if (
                        copy.execute(query).fetchall()
                        != source.execute(query).fetchall()
                    ):
                        raise RuntimeError("Candidate backup lost migrated or WAL data")
        if (backup / artifact.relative_to(root)).read_bytes() != artifact.read_bytes():
            raise RuntimeError("Candidate backup lost an artifact")
        for item in (backup, *backup.rglob("*")):
            if stat.S_IMODE(item.stat().st_mode) != (0o700 if item.is_dir() else 0o600):
                raise RuntimeError("Candidate backup permissions are not private")


def start_candidate(raw_command: str, output: IO[bytes], deadline: float) -> None:
    subprocess.run(
        ["alembic", "upgrade", "head"],
        check=True,
        timeout=deadline - time.monotonic(),
        stdout=output,
        stderr=subprocess.STDOUT,
    )
    verify_backup(
        Path(os.environ["RUNTIME_DATA_DIR"]),
        Path("/var/backups/k8s-incident-agent"),
        deadline,
    )
    child = subprocess.Popen(
        json.loads(raw_command), stdout=output, stderr=subprocess.STDOUT
    )
    try:
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(
                    "Candidate Runtime stopped during startup "
                    f"with exit code {child.returncode}"
                )
            try:
                with urllib.request.urlopen(
                    "http://127.0.0.1:8000/healthz", timeout=1
                ) as response:
                    result = json.load(response)
                    if (
                        response.status == 200
                        and result["status"] == "ok"
                        and result["diagnosis"]["status"] == "unavailable"
                    ):
                        return
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(0.5)
        raise RuntimeError(
            "Candidate Runtime did not become ready without model credentials "
            f"within {STARTUP_SECONDS} s"
        )
    finally:
        child.terminate()
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def output_tail(path: Path) -> str:
    with path.open("rb") as output:
        output.seek(max(0, path.stat().st_size - OUTPUT_TAIL_BYTES))
        return output.read().decode(errors="replace")


def main() -> None:
    architecture, raw_command = sys.argv[1:]
    deadline = time.monotonic() + STARTUP_SECONDS
    expected = "x86_64" if architecture == "amd64" else "aarch64"
    if platform.machine() != expected:
        raise RuntimeError("Candidate architecture differs from requested platform")
    if platform.python_version() != os.environ["PYTHON_VERSION"]:
        raise RuntimeError("Candidate Python differs from its declared version")
    if any(importlib.util.find_spec(name) for name in ("pip", "ensurepip")) or any(
        shutil.which(name) for name in ("pip", "pip3", "pip3.13")
    ):
        raise RuntimeError("Candidate retains a runtime package manager")
    os.umask(0o077)
    subprocess.run(["/bin/true"], check=True, timeout=5)
    permissions = Path("/tmp/permissions")
    permissions.mkdir(mode=0o755)
    permissions.chmod(0o755)
    subprocess.run(
        ["/usr/bin/test", "!", "-L", str(permissions)], check=True, timeout=5
    )
    subprocess.run(
        ["/usr/bin/chmod", "--recursive", "u=rwX,go=,a-s", str(permissions)],
        check=True,
        timeout=5,
    )
    if stat.S_IMODE(permissions.stat().st_mode) != 0o700:
        raise RuntimeError("Candidate permission initialization failed")
    verifier = Path("/tmp/operator-verifier")
    verifier.write_text(
        PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY).hash(
            secrets.token_bytes(32)
        )
    )
    hmac = Path("/tmp/validator-key")
    hmac.write_bytes(secrets.token_bytes(32))
    os.environ.update(
        OPERATOR_VERIFIER_FILE=str(verifier),
        OPERATOR_ORIGIN="http://127.0.0.1:3000",
        PATCH_VALIDATOR_HMAC_KEY_FILE=str(hmac),
        KUBERNETES_CREDENTIAL_MODE="in_cluster",
        KUBERNETES_SERVICE_HOST="127.0.0.1",
        KUBERNETES_SERVICE_PORT="8443",
    )
    server = HTTPServer(("127.0.0.1", 8443), KubernetesStub)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain("/smoke/tls/ca.crt", "/smoke/tls/key.pem")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    path = Path("/tmp/candidate-output")
    with path.open("wb") as output:
        try:
            start_candidate(raw_command, output, deadline)
        except Exception:
            # Shown only on failure; the smoke holds no credential with authority.
            print(f"Candidate output tail:\n{output_tail(path)}", file=sys.stderr)
            raise
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
