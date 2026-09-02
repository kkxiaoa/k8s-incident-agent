from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest

from k8s_incident_agent.application.alerts import AlertmanagerApplicationService
from k8s_incident_agent.application.scheduling import RunScheduler
from k8s_incident_agent.domain.models import (
    ModelSnapshot,
    PersistedAlertBatch,
    RunBudget,
)
from k8s_incident_agent.monitoring.auth import AlertmanagerWebhookAuthenticator
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT

RUN_ID = UUID("00000000-0000-4000-8000-000000000001")


class _Repository:
    def __init__(self) -> None:
        self.occurrences: tuple[object, ...] | None = None
        self.watchdog_received_at: datetime | None = None

    async def apply_alert_occurrences(
        self,
        occurrences: tuple[object, ...],
        _model: ModelSnapshot,
        _budget: RunBudget,
        *,
        watchdog_received_at: datetime | None = None,
    ) -> PersistedAlertBatch:
        self.occurrences = occurrences
        self.watchdog_received_at = watchdog_received_at
        return PersistedAlertBatch(
            created_run_ids=((RUN_ID,) if occurrences else ()),
            events=(),
        )


class _FailingScheduler:
    def __init__(self) -> None:
        self.run_ids: list[UUID] = []

    async def schedule(self, run_id: UUID) -> None:
        self.run_ids.append(run_id)
        raise RuntimeError("injected scheduling failure")


def _payload() -> bytes:
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


def _watchdog_payload() -> bytes:
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


@pytest.mark.asyncio
async def test_committed_run_survives_immediate_scheduler_failure(
    tmp_path: Path,
) -> None:
    repository = _Repository()
    scheduler = _FailingScheduler()
    credential = tmp_path / "credential"
    credential.write_bytes(b"a" * 32)
    service = AlertmanagerApplicationService(
        catalog=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
        authenticator=AlertmanagerWebhookAuthenticator.from_file(credential),
        repository=cast(IncidentRepository, repository),
        supervisor=cast(RunScheduler, scheduler),
        model=ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        budget=RunBudget(
            max_model_calls=8,
            max_tool_calls=6,
            timeout_seconds=180,
        ),
        cluster_id="k8s-incident-agent",
        diagnostic_namespace="k8s-incident-scenarios",
        now=lambda: datetime(2026, 9, 2, 8, 1, tzinfo=UTC),
    )

    await service.ingest(_payload())

    assert repository.occurrences is not None
    assert len(repository.occurrences) == 1
    assert repository.watchdog_received_at is None
    assert scheduler.run_ids == [RUN_ID]


@pytest.mark.asyncio
async def test_watchdog_refreshes_health_without_creating_or_scheduling_incident(
    tmp_path: Path,
) -> None:
    repository = _Repository()
    scheduler = _FailingScheduler()
    credential = tmp_path / "credential"
    credential.write_bytes(b"a" * 32)
    received_at = datetime(2026, 9, 2, 8, 1, tzinfo=UTC)
    service = AlertmanagerApplicationService(
        catalog=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
        authenticator=AlertmanagerWebhookAuthenticator.from_file(credential),
        repository=cast(IncidentRepository, repository),
        supervisor=cast(RunScheduler, scheduler),
        model=ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        budget=RunBudget(
            max_model_calls=8,
            max_tool_calls=6,
            timeout_seconds=180,
        ),
        cluster_id="k8s-incident-agent",
        diagnostic_namespace="k8s-incident-scenarios",
        now=lambda: received_at,
    )

    await service.ingest(_watchdog_payload())

    assert repository.occurrences == ()
    assert repository.watchdog_received_at == received_at
    assert scheduler.run_ids == []
