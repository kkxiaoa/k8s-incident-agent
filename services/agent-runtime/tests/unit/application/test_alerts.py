import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select
from tests.unit.persistence.test_alert_intake import (
    _database,  # pyright: ignore[reportPrivateUsage]
)

from k8s_incident_agent.application.alerts import AlertmanagerApplicationService
from k8s_incident_agent.monitoring.auth import AlertmanagerWebhookAuthenticator
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.monitoring.errors import AlertTargetInvalidError
from k8s_incident_agent.persistence.models import RunRow
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT


def alert_payload() -> bytes:
    return (
        b'{"version":"4","groupKey":"group","truncatedAlerts":0,'
        b'"status":"firing","receiver":"runtime","groupLabels":{},'
        b'"commonLabels":{},"commonAnnotations":{},"routeLabels":{},'
        b'"externalURL":"http://alertmanager.example",'
        b'"notification_reason":"","alerts":[{"status":"firing",'
        b'"labels":{"alertname":"K8sIncidentImagePullBackOff",'
        b'"cluster":"k8s-incident-agent",'
        b'"namespace":"k8s-incident-scenarios",'
        b'"deployment":"image-pull-backoff"},"annotations":{},'
        b'"startsAt":"2026-09-02T08:00:00Z",'
        b'"endsAt":"0001-01-01T00:00:00Z",'
        b'"generatorURL":"http://prometheus.example",'
        b'"fingerprint":"0123456789abcdef"}]}'
    )


def watchdog_payload() -> bytes:
    return (
        b'{"version":"4","groupKey":"group","truncatedAlerts":0,'
        b'"status":"firing","receiver":"runtime","groupLabels":{},'
        b'"commonLabels":{},"commonAnnotations":{},"routeLabels":{},'
        b'"externalURL":"http://alertmanager.example",'
        b'"notification_reason":"","alerts":[{"status":"firing",'
        b'"labels":{"alertname":"Watchdog","cluster":"k8s-incident-agent",'
        b'"severity":"none"},"annotations":{},'
        b'"startsAt":"2026-09-02T08:00:00Z",'
        b'"endsAt":"0001-01-01T00:00:00Z",'
        b'"generatorURL":"http://prometheus.example",'
        b'"fingerprint":"0123456789abcdef"}]}'
    )


@pytest.mark.parametrize("invalid_target", [False, True])
async def test_whole_batch_is_validated_before_any_signal_is_committed(
    tmp_path: Path,
    invalid_target: bool,
) -> None:
    credential = tmp_path / "credential"
    credential.write_bytes(b"a" * 32)
    received_at = datetime(2026, 9, 2, 8, 1, tzinfo=UTC)
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        service = AlertmanagerApplicationService(
            catalog=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
            authenticator=AlertmanagerWebhookAuthenticator.from_file(credential),
            repository=repository,
            cluster_id="k8s-incident-agent",
            diagnostic_namespace="k8s-incident-scenarios",
            now=lambda: received_at,
        )
        document = json.loads(alert_payload())
        other = json.loads(watchdog_payload())["alerts"][0]
        if invalid_target:
            other["labels"]["cluster"] = "outside-scope"
        document["alerts"].append(other)
        payload = json.dumps(document).encode()
        if invalid_target:
            with pytest.raises(AlertTargetInvalidError):
                await service.ingest(payload)
        else:
            await service.ingest(payload)
        overview = await repository.get_monitoring_overview(received_at)
        assert overview.unassigned_count == (0 if invalid_target else 1)
        assert overview.total_incidents == 0
        assert await repository.get_watchdog_last_received_at() == (
            None if invalid_target else received_at
        )
        async with database.session_factory() as session:
            assert await session.scalar(select(func.count()).select_from(RunRow)) == 0
