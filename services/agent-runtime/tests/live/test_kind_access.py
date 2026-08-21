import json
from datetime import UTC, datetime
from typing import cast

import pytest

from k8s_incident_agent.config import Settings
from k8s_incident_agent.kubernetes.access import verify_stage_one_access
from k8s_incident_agent.kubernetes.client import create_kubernetes_clients
from k8s_incident_agent.kubernetes.credentials import (
    load_diagnostic_credential,
    require_credential_ttl,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

pytestmark = pytest.mark.live_kind


def _scenario_target() -> ScenarioTarget:
    scenario_path = (
        REPOSITORY_ROOT / "scenarios" / "image-pull-backoff" / "scenario.json"
    )
    document = cast(object, json.loads(scenario_path.read_text(encoding="utf-8")))
    assert isinstance(document, dict)
    scenario = cast(dict[str, object], document)
    return ScenarioTarget.model_validate(scenario["target"])


@pytest.mark.asyncio
async def test_fixed_kind_diagnostic_access_gate() -> None:
    settings = Settings()  # pyright: ignore[reportCallIssue]
    now = datetime.now(UTC)
    credential = load_diagnostic_credential(settings.runtime_paths, now)
    require_credential_ttl(credential, 240, now)
    clients = await create_kubernetes_clients(
        credential,
        timeout_seconds=10,
    )
    try:
        await verify_stage_one_access(clients, _scenario_target())
    finally:
        await clients.close()
