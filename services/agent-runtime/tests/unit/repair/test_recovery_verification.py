from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any, cast

import pytest
from tests.recovery_fixtures import MonitoringFixture, RecoveryFixture
from tests.unit.persistence.test_alert_intake import (
    _occurrence,  # pyright: ignore[reportPrivateUsage]
    _timestamp,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.persistence.test_repair_persistence import BUDGET
from tests.unit.repair.test_repair_preparation import (
    credential as diagnostic_credential,
)
from tests.unit.routes.test_approvals import applied_result, approval_harness
from tests.unit.routes.test_operator import credential as credential

from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    IncidentStatus,
    RepairWorkflowRunSnapshot,
    RunStatus,
)
from k8s_incident_agent.kubernetes.contracts import RecoveryLogs
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.repair.verification import verify_recovery


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "old_pod",
        "zero",
        "observed_generation",
        "stale",
        "missing",
        "alert",
        "rule_error",
        "up",
        "monitoring_partial",
        "drift",
    ],
)
async def test_exact_applied_recovery_through_sdk_http_sqlite_and_public_api(
    tmp_path: Path,
    credential: tuple[str, str],
    fault: str | None,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        kube = RecoveryFixture()
        metrics = MonitoringFixture(harness.clock)
        if fault == "old_pod":
            kube.old_ready_pod = True
        elif fault == "zero":
            kube.deployment.spec.replicas = 0
        elif fault == "observed_generation":
            kube.deployment.status.observed_generation = 3
        elif fault == "stale":
            metrics.oldest = harness.now() - timedelta(seconds=61)
        elif fault == "missing":
            metrics.covered = 0
        elif fault == "alert":
            metrics.active = True
        elif fault == "rule_error":
            metrics.rule_health = "err"
        elif fault == "up":
            metrics.up = 0
        elif fault == "monitoring_partial":
            metrics.partial = True
        elif fault == "drift":
            kube.deployment.metadata.generation = 5

        async def tick(seconds: float) -> None:
            harness.clock[0] += timedelta(seconds=seconds)
            kube.now = harness.now()
            await harness.repository.apply_alert_occurrences(
                (), None, BUDGET, watchdog_received_at=harness.now()
            )

        await tick(0)
        prometheus = metrics.service()
        try:
            await verify_recovery(
                harness.run_id,
                repository=harness.repository,
                adapter=kube.adapter(),
                prometheus=prometheus,
                credential=diagnostic_credential(),
                now=harness.now,
                sleep=tick,
            )
        finally:
            await prometheus.close()
        detail = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert (
            detail is not None
            and detail.repair is not None
            and detail.repair.verification is not None
        )
        verification = detail.repair.verification
        assert verification.execution_id == run.execution.id
        assert verification.deadline_at == verification.started_at + timedelta(
            minutes=10
        )
        if fault is None:
            assert detail.incident.status is IncidentStatus.RESOLVED
            assert detail.run.status is RunStatus.COMPLETED
            assert (
                verification.outcome == "recovered" and verification.sample_count == 13
            )
            assert verification.last_observed_at == verification.started_at + timedelta(
                seconds=60
            )
        else:
            assert detail.incident.status is IncidentStatus.FAILED
            assert detail.run.status is RunStatus.FAILED
            assert verification.outcome != "recovered"
        assert not detail.run_creation_blocked
        assert (
            detail.repair.execution is not None
            and detail.repair.execution.status == "APPLIED"
        )
        assert await harness.repository.claim_execution(now=harness.now) is None
        response = await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        assert response.status_code == 200, response.text
        assert response.json()["verification"]["outcome"] == verification.outcome
        assert any(
            item["event"] == "repair.verification_updated"
            for item in response.json()["eventPage"]["items"]
        )
        if fault is None:
            cutoff = harness.now() + timedelta(days=8)
            artifacts = tmp_path / "runtime" / "runs"
            targets = await harness.repository.list_prune_targets(cutoff, artifacts)
            assert len(targets) == 1 and targets[0].verification_rows == 1
            assert await harness.repository.delete_prune_target(
                targets[0], cutoff, artifacts
            )
            assert (
                await harness.repository.get_incident_detail(
                    harness.incident_id, run_id=harness.run_id, event_limit=100
                )
                is None
            )


@pytest.mark.parametrize("interruption", ["gap", "missing", "restart", "refiring"])
async def test_missing_samples_restarts_and_refiring_reset_the_window(
    tmp_path: Path, credential: tuple[str, str], interruption: str
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        started = harness.now()
        kube, metrics = RecoveryFixture(), MonitoringFixture(harness.clock)
        interrupted = False

        async def tick(seconds: float) -> None:
            nonlocal interrupted
            if (
                interruption == "gap"
                and not interrupted
                and harness.now() - started == timedelta(seconds=15)
            ):
                seconds += 10
                interrupted = True
            harness.clock[0] += timedelta(seconds=seconds)
            kube.now = harness.now()
            elapsed = (harness.now() - started).total_seconds()
            kube.error = (
                KubernetesErrorCode.REQUEST_TIMEOUT
                if interruption == "missing" and elapsed == 20
                else None
            )
            if interruption == "restart" and elapsed >= 20:
                kube.pod.status.container_statuses[0].restart_count = 1
            metrics.active = interruption == "refiring" and elapsed == 60
            await harness.repository.apply_alert_occurrences(
                (), None, BUDGET, watchdog_received_at=harness.now()
            )

        await tick(0)
        service = metrics.service()
        try:
            await verify_recovery(
                harness.run_id,
                repository=harness.repository,
                adapter=kube.adapter(),
                prometheus=service,
                credential=diagnostic_credential(),
                now=harness.now,
                sleep=tick,
            )
        finally:
            await service.close()
        after = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert (
            after.verification is not None and after.verification.outcome == "recovered"
        )
        expected_seconds = {"gap": 90, "missing": 85, "restart": 80, "refiring": 125}[
            interruption
        ]
        assert after.verification.completed_at == started + timedelta(
            seconds=expected_seconds
        )
        assert after.verification.deadline_at == started + timedelta(minutes=10)


@pytest.mark.parametrize("late_success", [False, True])
async def test_unknown_never_enters_verification_or_releases_target(
    tmp_path: Path, credential: tuple[str, str], late_success: bool
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        harness.clock[0] += timedelta(seconds=41)
        await harness.repository.reconcile_executions(harness.now())
        if late_success:
            await harness.repository.report_execution(
                run.execution.id, result, now=harness.now
            )
        kube, metrics = RecoveryFixture(), MonitoringFixture(harness.clock)
        service = metrics.service()
        try:
            await verify_recovery(
                harness.run_id,
                repository=harness.repository,
                adapter=kube.adapter(),
                prometheus=service,
                credential=diagnostic_credential(),
                now=harness.now,
            )
        finally:
            await service.close()
        assert not metrics.requests and kube.reads == 0
        detail = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert (
            detail is not None
            and detail.run_creation_blocked
            and detail.repair is not None
        )
        assert detail.repair.verification is None
        assert (
            detail.repair.execution is not None
            and detail.repair.execution.status == "UNKNOWN"
        )


async def test_restart_after_original_deadline_does_not_query_or_extend_it(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        started = harness.now()
        harness.clock[0] += timedelta(minutes=11)
        kube, metrics = RecoveryFixture(), MonitoringFixture(harness.clock)
        service = metrics.service()
        try:
            await verify_recovery(
                harness.run_id,
                repository=harness.repository,
                adapter=kube.adapter(),
                prometheus=service,
                credential=diagnostic_credential(),
                now=harness.now,
            )
        finally:
            await service.close()
        after = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert (
            after.verification is not None and after.verification.outcome == "timeout"
        )
        assert after.verification.deadline_at == started + timedelta(minutes=10)
        assert (
            after.verification.sample_count == 0
            and not metrics.requests
            and kube.reads == 0
        )


@pytest.mark.parametrize("resolve", [False, True])
async def test_alert_source_requires_its_own_resolved_occurrence(
    tmp_path: Path, credential: tuple[str, str], resolve: bool
) -> None:
    occurrence = _occurrence()
    async with approval_harness(tmp_path, credential, occurrence=occurrence) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        started = harness.now()
        kube, metrics = RecoveryFixture(), MonitoringFixture(harness.clock)

        async def tick(seconds: float) -> None:
            harness.clock[0] += timedelta(seconds=seconds)
            kube.now = harness.now()
            occurrences = (
                (_occurrence(status=AlertSignalStatus.RESOLVED, ends_at=_timestamp(3)),)
                if resolve and harness.now() >= started + timedelta(seconds=20)
                else ()
            )
            await harness.repository.apply_alert_occurrences(
                occurrences, None, BUDGET, watchdog_received_at=harness.now()
            )

        await tick(0)
        service = metrics.service()
        try:
            await verify_recovery(
                harness.run_id,
                repository=harness.repository,
                adapter=kube.adapter(),
                prometheus=service,
                credential=diagnostic_credential(),
                now=harness.now,
                sleep=tick,
            )
        finally:
            await service.close()
        after = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert after.verification is not None
        assert after.verification.outcome == ("recovered" if resolve else "timeout")
        assert after.verification.reason == (
            None if resolve else "occurrence_not_resolved"
        )
        if resolve:
            assert after.verification.completed_at == started + timedelta(seconds=80)


@pytest.mark.parametrize("slow_logs", [False, True])
async def test_auxiliary_logs_cannot_change_recovery_proven_before_deadline(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    slow_logs: bool,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        started = harness.now()
        kube, metrics = RecoveryFixture(), MonitoringFixture(harness.clock)

        async def tick(seconds: float) -> None:
            harness.clock[0] += timedelta(seconds=seconds)
            kube.now = harness.now()
            await harness.repository.apply_alert_occurrences(
                (), None, BUDGET, watchdog_received_at=harness.now()
            )

        await tick(539)
        adapter = kube.adapter()
        original = adapter.read_recovery_logs

        async def read_logs(*args: Any, **kwargs: Any) -> RecoveryLogs:
            if slow_logs:
                harness.clock[0] += timedelta(seconds=1)
                raise TimeoutError
            return await original(*args, **kwargs)

        monkeypatch.setattr(adapter, "read_recovery_logs", read_logs)
        service = metrics.service()
        try:
            await verify_recovery(
                harness.run_id,
                repository=harness.repository,
                adapter=adapter,
                prometheus=service,
                credential=diagnostic_credential(),
                now=harness.now,
                sleep=tick,
            )
        finally:
            await service.close()
        after = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert (
            after is not None
            and after.repair is not None
            and after.repair.verification is not None
        )
        assert after.repair.verification.outcome == "recovered"
        assert after.repair.verification.completed_at == started + timedelta(
            seconds=599
        )
        assert after.repair.verification.deadline_at == started + timedelta(seconds=600)
        assert (
            after.run.status is RunStatus.COMPLETED and not after.run_creation_blocked
        )
        if slow_logs:
            assert any(
                isinstance(logs := item.payload.get("logs"), dict)
                and logs.get("error") == KubernetesErrorCode.REQUEST_TIMEOUT.value
                for item in after.evidence
            )
