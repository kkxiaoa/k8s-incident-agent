"""Check the isolated startup stub against the repository's actual Kubernetes SDK."""

import asyncio
import importlib.util
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path
from types import SimpleNamespace

from k8s_incident_agent.kubernetes.access import verify_diagnostic_access
from kubernetes.aio.client import (
    ApiClient,
    AuthorizationV1Api,
    Configuration,
    VersionApi,
)


class SmokeProducerContract(unittest.TestCase):
    def test_actual_sdk_version_and_access_review_contract(self):
        spec = importlib.util.spec_from_file_location(
            "smoke_runtime", Path(__file__).with_name("smoke-runtime.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        server = HTTPServer(("127.0.0.1", 0), module.KubernetesStub)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        async def check():
            configuration = Configuration(host=f"http://127.0.0.1:{server.server_port}")
            async with ApiClient(configuration) as client:
                await verify_diagnostic_access(
                    SimpleNamespace(
                        version_api=VersionApi(client),
                        authorization_api=AuthorizationV1Api(client),
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


if __name__ == "__main__":
    unittest.main()
