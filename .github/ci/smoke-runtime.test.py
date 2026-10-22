"""Check the isolated startup stub against the repository's actual Kubernetes SDK."""

import asyncio
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import HTTPServer
from pathlib import Path
from types import ModuleType
from unittest import mock

from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    AuthorizationV1Api,
    Configuration,
    CoreV1Api,
    DiscoveryV1Api,
    EventsV1Api,
    StorageV1Api,
    VersionApi,
)

from k8s_incident_agent.kubernetes.access import verify_diagnostic_access
from k8s_incident_agent.kubernetes.client import KubernetesClients


def load_fixture() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "smoke_runtime", Path(__file__).with_name("smoke-runtime.py")
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load the isolated startup fixture")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SmokeProducerContract(unittest.TestCase):
    def test_actual_sdk_version_and_access_review_contract(self):
        module = load_fixture()
        server = HTTPServer(("127.0.0.1", 0), module.KubernetesStub)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        async def check():
            configuration = Configuration(host=f"http://127.0.0.1:{server.server_port}")
            async with ApiClient(configuration) as client:
                await verify_diagnostic_access(
                    KubernetesClients(
                        api_client=client,
                        apps_api=AppsV1Api(client),
                        core_api=CoreV1Api(client),
                        discovery_api=DiscoveryV1Api(client),
                        events_api=EventsV1Api(client),
                        storage_api=StorageV1Api(client),
                        version_api=VersionApi(client),
                        authorization_api=AuthorizationV1Api(client),
                        cluster_id="k8s-incident-agent",
                        diagnostic_namespace="k8s-incident-scenarios",
                        timeout_seconds=2,
                    )
                )

        try:
            asyncio.run(check())
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()


class BackupProbe(unittest.TestCase):
    def test_real_cli_copies_migrated_data_wal_and_artifacts(self):
        self.check_backup(lock_works=True)

    def test_probe_rejects_a_backup_that_ignores_runtime_ownership(self):
        self.check_backup(lock_works=False)

    def check_backup(self, *, lock_works: bool) -> None:
        module = load_fixture()
        config = (
            Path(__file__).resolve().parents[2] / "services/agent-runtime/alembic.ini"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data = root / "data"
            destination = root / "backups"
            data.mkdir(mode=0o700)
            destination.mkdir(mode=0o700)
            environment = {
                "RUNTIME_DATA_DIR": str(data),
                "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}",
            }
            previous_umask = os.umask(0o077)
            try:
                with mock.patch.dict(os.environ, environment):
                    subprocess.run(
                        ["alembic", "-c", str(config), "upgrade", "head"],
                        check=True,
                        capture_output=True,
                        timeout=30,
                    )
                    if lock_works:
                        module.verify_backup(data, destination, time.monotonic() + 30)
                        self.assertEqual(len(list(destination.iterdir())), 1)
                    else:
                        with (
                            mock.patch.object(module, "RuntimeLock"),
                            self.assertRaisesRegex(
                                RuntimeError, "did not reject an occupied Runtime"
                            ),
                        ):
                            module.verify_backup(
                                data, destination, time.monotonic() + 30
                            )
            finally:
                os.umask(previous_umask)


class StartupFailureOutput(unittest.TestCase):
    def test_failed_migration_keeps_a_bounded_output_tail(self):
        module = load_fixture()
        with tempfile.TemporaryDirectory() as directory:
            alembic = Path(directory, "alembic")
            alembic.write_text(
                "#!/bin/sh\n"
                "head -c 3000 /dev/zero | tr '\\0' x\n"
                "echo\n"
                "echo migration refused >&2\n"
                "exit 3\n"
            )
            alembic.chmod(0o700)
            path = Path(directory, "output")
            search_path = f"{directory}{os.pathsep}{os.environ['PATH']}"
            with (
                mock.patch.dict(os.environ, {"PATH": search_path}),
                path.open("wb") as output,
                self.assertRaises(subprocess.CalledProcessError),
            ):
                module.start_candidate("[]", output, time.monotonic() + 30)
            tail = module.output_tail(path)
        self.assertTrue(tail.endswith("x\nmigration refused\n"))
        self.assertEqual(len(tail.encode()), module.OUTPUT_TAIL_BYTES)


if __name__ == "__main__":
    unittest.main()
