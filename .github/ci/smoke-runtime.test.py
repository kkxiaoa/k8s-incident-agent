"""Check the isolated startup stub against the repository's actual Kubernetes SDK."""

import asyncio
import importlib.util
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path

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


class SmokeProducerContract(unittest.TestCase):
    def test_actual_sdk_version_and_access_review_contract(self):
        spec = importlib.util.spec_from_file_location(
            "smoke_runtime", Path(__file__).with_name("smoke-runtime.py")
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("Cannot load the isolated startup fixture")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
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


if __name__ == "__main__":
    unittest.main()
