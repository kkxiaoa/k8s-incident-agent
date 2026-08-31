from datetime import UTC, datetime

import pytest

from k8s_incident_agent.config import Settings
from k8s_incident_agent.kubernetes.access import verify_stage_one_access
from k8s_incident_agent.kubernetes.client import create_kubernetes_clients
from k8s_incident_agent.kubernetes.credentials import (
    load_diagnostic_credential,
    require_credential_window,
)

pytestmark = pytest.mark.live_kind


@pytest.mark.asyncio
async def test_fixed_kind_diagnostic_access_gate() -> None:
    settings = Settings()  # pyright: ignore[reportCallIssue]
    now = datetime.now(UTC)
    credential = load_diagnostic_credential(settings.runtime_paths, now)
    require_credential_window(credential, 240, now)
    clients = await create_kubernetes_clients(
        credential,
        timeout_seconds=settings.kubernetes_timeout_seconds,
        cluster_id=settings.kubernetes_cluster_id,
        diagnostic_namespace=settings.kubernetes_diagnostic_namespace,
    )
    try:
        await verify_stage_one_access(clients)
    finally:
        await clients.close()
