"""Isolated candidate startup, not Kubernetes/model or repair acceptance evidence."""

import json
import os
import platform
import secrets
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import IO

from argon2 import PasswordHasher
from argon2.profiles import RFC_9106_LOW_MEMORY

# A hang bound, not a startup target: an emulated platform compiles every
# imported module from source many times slower than a native one.
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


def start_candidate(raw_command: str, output: IO[bytes], deadline: float) -> None:
    subprocess.run(
        ["alembic", "upgrade", "head"],
        check=True,
        timeout=deadline - time.monotonic(),
        stdout=output,
        stderr=subprocess.STDOUT,
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
    os.umask(0o077)
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
