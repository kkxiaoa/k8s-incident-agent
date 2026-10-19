import asyncio
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1ContainerState,
    V1ContainerStateRunning,
    V1ContainerStateTerminated,
    V1ContainerStateWaiting,
    V1ExecAction,
    V1HTTPGetAction,
    V1ListMeta,
    V1PodList,
    V1Probe,
    V1ResourceRequirements,
)
from sqlalchemy import select, text
from tests.unit.monitoring.test_reconciliation import CurrentTargetFixture
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET

from k8s_incident_agent.application.event_projection import validated_stream_item
from k8s_incident_agent.diagnosis.policy import DiagnosticPolicyCatalog
from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    NormalizedIncidentTrigger,
)
from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    CanonicalAlertTimestamp,
    DiagnosisOutcome,
    DiagnosisWorkflowRunSnapshot,
    EvidenceRecord,
    NormalizedAlertOccurrence,
    PersistedEvidence,
    RootCauseRecord,
    TerminalRecord,
)
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.monitoring.contracts import (
    CurrentAlertObservation,
    CurrentAlertState,
    CurrentAlertSummary,
    ObservationReason,
    RuleAlertObservation,
)
from k8s_incident_agent.persistence.models import (
    AlertSignalRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    ActiveRunExistsError,
    IncidentRepository,
    PersistenceOperationError,
)

CATALOG = load_alert_catalog(Path(__file__).resolve().parents[5] / "monitoring/catalog")
CRASH = "K8sIncidentCrashLoopBackOff"
LIVENESS = "K8sIncidentLivenessProbeRestart"
REPLICAS = "K8sIncidentDeploymentReplicasUnavailable"


class RollingPodsFixture(CurrentTargetFixture):
    def __init__(self) -> None:
        super().__init__()
        self.pod.spec.containers[0].resources = V1ResourceRequirements(
            limits={"cpu": "1", "memory": "64Mi"}
        )
        self.deployment.spec.template.spec.containers[0].resources = deepcopy(
            self.pod.spec.containers[0].resources
        )
        self.pod.status.container_statuses[0].image_id = "containerd://old-image"
        self.pod.status.container_statuses[0].state = V1ContainerState(
            waiting=V1ContainerStateWaiting(reason="CrashLoopBackOff")
        )
        self.pod.status.container_statuses[0].ready = False
        self.new_pod = deepcopy(self.pod)
        self.new_pod.metadata.name, self.new_pod.metadata.uid = "new-pod", "new-pod-uid"
        self.new_pod.metadata.owner_references[0].name = "rs-new"
        self.new_pod.metadata.owner_references[0].uid = "rs-new"
        self.new_pod.spec.containers[0].image = "registry.invalid/workload:new"
        self.new_pod.spec.containers[0].resources = V1ResourceRequirements(
            limits={"cpu": "1", "memory": "128Mi"}
        )
        self.new_pod.spec.containers[0].readiness_probe.http_get.path = "/new-ready"
        self.new_pod.status.container_statuses[0].image = self.new_pod.spec.containers[
            0
        ].image
        self.new_pod.status.container_statuses[0].image_id = "containerd://new-image"
        self.new_pod.status.container_statuses[0].state = V1ContainerState(
            running=V1ContainerStateRunning()
        )
        self.new_pod.status.container_statuses[0].ready = True
        self.pods = [self.pod, self.new_pod]

    async def list_namespaced_pod(self, **_: object) -> object:
        return V1PodList(metadata=V1ListMeta(), items=self.pods)


def occurrence(
    alert: str, index: int, at: datetime = FRESH_NOW
) -> NormalizedAlertOccurrence:
    entry = CATALOG.find(alert)
    assert entry is not None
    return NormalizedAlertOccurrence(
        trigger=NormalizedIncidentTrigger(
            source=IncidentSource(
                type="alertmanager", ref=alert, revision=CATALOG.version
            ),
            display_name=entry.display_name,
            trigger_summary=entry.trigger_summary,
            target=TARGET,
        ),
        fingerprint=f"{index:016x}",
        starts_at=CanonicalAlertTimestamp(at.strftime("%Y-%m-%dT%H:%M:%S.000000000Z")),
        status=AlertSignalStatus.FIRING,
        ends_at=None,
    )


async def observation(
    at: datetime = FRESH_NOW,
    *,
    alerts: tuple[str, ...] = (CRASH, LIVENESS, REPLICAS),
    fixture: CurrentTargetFixture | None = None,
) -> CurrentAlertObservation:
    fixture = fixture or CurrentTargetFixture(at)
    fixture.now = at
    fixture.deployment.metadata.creation_timestamp = FRESH_NOW - timedelta(minutes=30)
    fixture.pod.metadata.creation_timestamp = FRESH_NOW - timedelta(minutes=25)
    return CurrentAlertObservation(
        target=TARGET,
        catalog_version=CATALOG.version,
        facts=await fixture.adapter().read_current_target(TARGET),
        summary=CurrentAlertSummary(
            state=CurrentAlertState.FIRING,
            complete=True,
            observed_at=at,
            received_at=at,
            target_healthy=True,
            reason=None,
            rules=tuple(
                RuleAlertObservation(
                    alert_id=alert,
                    state=CurrentAlertState.FIRING,
                    complete=True,
                    reason=None,
                    evaluated_at=at,
                )
                for alert in alerts
            ),
        ),
    )


async def test_concurrent_reconciliation_associates_three_symptoms_and_creates_one_fixed_run(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        signals = tuple(
            occurrence(alert, index)
            for index, alert in enumerate((CRASH, LIVENESS, REPLICAS))
        )
        await repository.apply_alert_occurrences(signals)
        await repository.save_current_alert_observation(await observation())
        results = await asyncio.gather(
            *(
                repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
                for _ in range(2)
            )
        )
        assert sum(len(result) for result in results) == 1
        async with database.session_factory() as session:
            incidents = list(await session.scalars(select(IncidentRow)))
            runs = list(await session.scalars(select(RunRow)))
            saved = list(await session.scalars(select(AlertSignalRow)))
        assert len(incidents) == len(runs) == 1
        assert {signal.incident_id for signal in saved} == {incidents[0].id}
        assert incidents[0].target_uid is not None
        snapshot = await repository.get_workflow_run_snapshot(UUID(runs[0].id))
        assert isinstance(snapshot, DiagnosisWorkflowRunSnapshot)
        assert snapshot.source == signals[0].trigger.source
        assert snapshot.diagnosis_trigger is not None
        assert len(snapshot.diagnosis_trigger.changes) == 3
        events = await repository.list_incident_events(
            UUID(incidents[0].id), after_id=0, limit=100
        )
        assert all(
            event.run_id is None for event in events if event.event_type != "run.queued"
        )
        assert events[-1].payload["attempt"] == 1
        for event in events:
            wire = validated_stream_item(event).model_dump(mode="json")
            if event.event_type == "diagnosis.change_recorded":
                assert "facts" not in wire["data"]["change"]
                assert wire["data"]["change"]["eventId"] == str(event.id)
                persisted_change = event.payload["change"]
                assert isinstance(persisted_change, dict)
                assert "facts" in persisted_change
        await repository.apply_alert_occurrences(
            signals, received_at=FRESH_NOW + timedelta(seconds=1)
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        assert (
            await repository.list_incident_events(
                UUID(incidents[0].id), after_id=0, limit=100
            )
            == events
        )


async def test_model_unavailable_keeps_real_incident_without_placeholder_run(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(await observation())
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, None, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            incident = (await session.scalars(select(IncidentRow))).one()
            assert list(await session.scalars(select(RunRow))) == []
            assert incident.pending_diagnosis_json is not None
        detail = await repository.get_incident_detail(
            UUID(incident.id), run_id=None, event_limit=100
        )
        assert detail is not None and detail.run is None
        assert detail.alert_summary.state is CurrentAlertState.FIRING
        created = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        assert len(created) == 1


async def fail_run(repository: IncidentRepository, run_id: UUID, at: datetime) -> None:
    await repository.start_run(run_id, at)
    await repository.persist_terminal(
        TerminalRecord(
            run_id=run_id,
            completed_at=at + timedelta(seconds=1),
            outcome=None,
            summary=None,
            root_causes=(),
            missing_information=(),
            redacted=False,
            error_code="request_timeout",
            error_retryable=True,
            model_calls=1,
            tool_calls=0,
            input_tokens=None,
            output_tokens=None,
        )
    )


async def diagnose_run(
    repository: IncidentRepository,
    run_id: UUID,
    fixture: CurrentTargetFixture,
    at: datetime,
) -> None:
    await repository.start_run(run_id, at)
    fixture.now = at + timedelta(seconds=5)
    adapter = fixture.adapter()
    observations = (
        ("get_workload", await adapter.read_workload(TARGET)),
        ("get_pods", await adapter.read_pods(TARGET)),
    )
    evidence_ids: list[UUID] = []
    for tool, observed in observations:
        await repository.record_tool_started(run_id, tool, tool)
        evidence = await repository.record_evidence(
            EvidenceRecord(
                run_id=run_id,
                tool_call_id=tool,
                tool_name=tool,
                evidence_kind=observed.evidence_kind,
                target_ref=observed.target_ref.model_dump(mode="json", by_alias=True),
                observed_at=observed.observed_at,
                payload=observed.payload.model_dump(mode="json", by_alias=True),
                truncated=observed.truncated,
                redacted=observed.redacted,
            )
        )
        evidence_ids.append(evidence.id)
    await repository.persist_terminal(
        TerminalRecord(
            run_id=run_id,
            completed_at=at + timedelta(seconds=10),
            outcome=DiagnosisOutcome.DIAGNOSED,
            summary="Observed workload and actual container state.",
            root_causes=(
                RootCauseRecord(
                    code="container_failure",
                    statement="The workload and Pod observations support the cause.",
                    confidence="high",
                    evidence_ids=tuple(evidence_ids),
                ),
            ),
            missing_information=(),
            redacted=False,
            error_code=None,
            error_retryable=None,
            model_calls=1,
            tool_calls=2,
            input_tokens=None,
            output_tokens=None,
        )
    )


def with_image(
    observed: CurrentAlertObservation, image_id: str
) -> CurrentAlertObservation:
    assert observed.facts is not None
    facts = observed.facts.model_copy(deep=True)
    container = facts.pods[0].pod.containers[0]
    facts.pods[0].pod.containers[0] = container.model_copy(
        update={"image_id": image_id}
    )
    return observed.model_copy(update={"facts": facts})


async def test_failures_consume_three_automatic_runs_and_manual_does_not_refund(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        signal = occurrence(CRASH, 1)
        await repository.apply_alert_occurrences((signal,))
        for index in range(3):
            clock[0] = FRESH_NOW + timedelta(minutes=10 * index)
            await repository.save_current_alert_observation(
                with_image(await observation(clock[0]), f"containerd://image-{index}")
            )
            created = await repository.reconcile_episode_diagnosis(
                TARGET, CATALOG, MODEL, BUDGET
            )
            assert len(created) == 1
            await fail_run(repository, created[0], clock[0])
            await repository.apply_alert_occurrences((signal,))
            assert (
                await repository.reconcile_episode_diagnosis(
                    TARGET, CATALOG, MODEL, BUDGET
                )
                == ()
            )
        clock[0] += timedelta(minutes=10)
        await repository.save_current_alert_observation(
            with_image(await observation(clock[0]), "containerd://image-new")
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            incident = (await session.scalars(select(IncidentRow))).one()
            assert (
                incident.pending_diagnosis_json is not None
                and "budget_exhausted" in incident.pending_diagnosis_json
            )
        manual = await repository.create_run(
            UUID(incident.id), MODEL, BUDGET, operator_ref="operator"
        )
        assert manual is not None
        await fail_run(repository, manual.run_id, clock[0])
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        await repository.save_current_alert_observation(
            with_image(await observation(clock[0]), "containerd://another-image")
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            runs = list(await session.scalars(select(RunRow).order_by(RunRow.attempt)))
            assert [run.request_source for run in runs] == [
                "system",
                "system",
                "system",
                "operator",
            ]


async def test_new_occurrence_keeps_its_anchor_and_cooldown_survives_repository_restart(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(await observation())
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        frozen = await repository.get_workflow_run_snapshot(first)
        clock[0] += timedelta(minutes=1)
        latest = occurrence(LIVENESS, 2, clock[0])
        await repository.apply_alert_occurrences((latest,))
        await repository.save_current_alert_observation(await observation(clock[0]))
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        assert await repository.get_workflow_run_snapshot(first) == frozen
        await fail_run(repository, first, FRESH_NOW)
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        clock[0] = FRESH_NOW + timedelta(minutes=10)
        # A persisted deadline alone never authorizes a Run from an old sample.
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        await repository.save_current_alert_observation(await observation(clock[0]))
        (second,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        snapshot = await repository.get_workflow_run_snapshot(second)
        assert isinstance(snapshot, DiagnosisWorkflowRunSnapshot)
        assert snapshot.source == latest.trigger.source
        assert snapshot.occurred_at == FRESH_NOW + timedelta(minutes=1)
        assert snapshot.diagnosis_trigger is not None
        assert snapshot.diagnosis_trigger.changes[0].fingerprint == latest.fingerprint
        first_context = await repository.get_incident_monitoring_context(
            snapshot.incident_id, run_limit=1, run_id=first
        )
        latest_context = await repository.get_incident_monitoring_context(
            snapshot.incident_id, run_limit=1, run_id=second
        )
        assert first_context is not None and first_context.source.ref == CRASH
        assert (
            latest_context is not None
            and latest_context.source == latest.trigger.source
        )
        assert latest_context.occurred_at == snapshot.occurred_at
        assert (
            latest_context.alert_signal is not None
            and latest_context.alert_signal.starts_at == latest.starts_at
        )
        policy = DiagnosticPolicyCatalog(scenarios=(), alerts=CATALOG).resolve(
            snapshot.source, snapshot.target
        )
        assert policy.trigger_panel_id == "liveness-probe-restarts"
        assert policy.trigger_duration == "30s"


async def test_older_primary_evidence_cannot_replace_a_later_consumed_change(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    fixture = CurrentTargetFixture()
    status = fixture.pod.status.container_statuses[0]
    status.image_id = "containerd://image-a"
    resources = V1ResourceRequirements(limits={"cpu": "1", "memory": "64Mi"})
    fixture.pod.spec.containers[0].resources = resources
    fixture.deployment.spec.template.spec.containers[0].resources = resources
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(
            await observation(alerts=(CRASH,), fixture=fixture)
        )
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        await diagnose_run(repository, first, fixture, clock[0])
        clock[0] += timedelta(minutes=1)
        await repository.apply_alert_occurrences((occurrence(LIVENESS, 2, clock[0]),))
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH, LIVENESS), fixture=fixture)
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        clock[0] += timedelta(minutes=1)
        status.image_id = "containerd://image-b"
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH, LIVENESS), fixture=fixture)
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        clock[0] = FRESH_NOW + timedelta(minutes=10)
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH, LIVENESS), fixture=fixture)
        )
        (second,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        snapshot = await repository.get_workflow_run_snapshot(second)
        assert isinstance(snapshot, DiagnosisWorkflowRunSnapshot)
        assert snapshot.source.ref == LIVENESS
        assert snapshot.diagnosis_trigger is not None
        assert {change.source.ref for change in snapshot.diagnosis_trigger.changes} == {
            CRASH,
            LIVENESS,
        }
        await diagnose_run(repository, second, fixture, clock[0])
        clock[0] += timedelta(minutes=10)
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH, LIVENESS), fixture=fixture)
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            assert len(list(await session.scalars(select(RunRow)))) == 2
        clock[0] += timedelta(minutes=1)
        status.image_id = "containerd://image-c"
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH, LIVENESS), fixture=fixture)
        )
        (third,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        assert third not in (first, second)
        async with database.session_factory() as session:
            assert len(list(await session.scalars(select(RunRow)))) == 3


@pytest.mark.parametrize(
    "change,expected",
    [
        ("equivalent_resources", False),
        ("restart_reset", False),
        ("pod_replaced", False),
        ("last_state_lost", False),
        ("image_id", True),
        ("template_image", True),
        ("actual_image", True),
        ("actual_probe", True),
        ("template_probe", True),
        ("resources", True),
        ("last_state", True),
    ],
)
async def test_only_known_safe_semantic_changes_create_another_run(
    tmp_path: Path,
    change: str,
    expected: bool,
) -> None:
    clock = [FRESH_NOW]
    fixture = CurrentTargetFixture()
    status = fixture.pod.status.container_statuses[0]
    status.image_id = "containerd://known-image"
    status.restart_count = 5
    resources = V1ResourceRequirements(limits={"cpu": "1000m", "memory": "64Mi"})
    fixture.pod.spec.containers[0].resources = resources
    fixture.deployment.spec.template.spec.containers[0].resources = resources
    terminated = V1ContainerState(
        terminated=V1ContainerStateTerminated(exit_code=137, reason="OOMKilled")
    )
    if change == "last_state_lost":
        status.last_state = terminated
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(
            await observation(fixture=fixture)
        )
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        await fail_run(repository, first, clock[0])
        clock[0] += timedelta(minutes=10)
        if change == "equivalent_resources":
            resources.limits = {"cpu": "1", "memory": "67108864"}
        elif change == "restart_reset":
            status.restart_count = 0
            fixture.deployment.metadata.resource_version = "new-version"
            status.state.running.started_at = clock[0] - timedelta(seconds=30)
        elif change == "pod_replaced":
            fixture.pod.metadata.uid = "replacement-pod"
            fixture.pod.metadata.name = "replacement"
        elif change == "last_state_lost":
            status.last_state = None
            status.restart_count = 0
        elif change == "image_id":
            status.image_id = "containerd://different-image"
        elif change == "template_image":
            fixture.deployment.spec.template.spec.containers[0].image = "nginx:changed"
        elif change == "actual_image":
            fixture.pod.spec.containers[0].image = "nginx:changed"
            status.image = "nginx:changed"
        elif change == "actual_probe":
            fixture.pod.spec.containers[0].readiness_probe.http_get.path = "/different"
        elif change == "template_probe":
            fixture.deployment.spec.template.spec.containers[
                0
            ].readiness_probe = V1Probe(
                http_get=V1HTTPGetAction(path="/different", port=80)
            )
        elif change == "resources":
            fixture.pod.spec.containers[0].resources = V1ResourceRequirements(
                limits={"cpu": "2", "memory": "64Mi"}
            )
        elif change == "last_state":
            status.last_state = terminated
        await repository.save_current_alert_observation(
            await observation(clock[0], fixture=fixture)
        )
        created = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        assert len(created) == int(expected)
        if created:
            snapshot = await repository.get_workflow_run_snapshot(created[0])
            assert isinstance(snapshot, DiagnosisWorkflowRunSnapshot)
            assert (
                snapshot.diagnosis_trigger is not None
                and snapshot.diagnosis_trigger.reason == "facts_changed"
            )


@pytest.mark.parametrize(
    "change,expected",
    [
        ("state_ready_swap", True),
        ("ready_swap", True),
        ("probe_swap", True),
        ("resource_swap", True),
        ("image_id_swap", True),
        ("identity_replacement", False),
        ("duplicate_pod", False),
        ("pod_removed", False),
        ("no_pods", False),
        ("image_id_missing", False),
        ("status_missing", False),
        ("last_state_lost", False),
        ("new_image_id_known", True),
        ("exec_command_changed", False),
    ],
)
async def test_pod_semantics_keep_configuration_and_state_associated_without_churn(
    tmp_path: Path, change: str, expected: bool
) -> None:
    clock = [FRESH_NOW]
    fixture = RollingPodsFixture()
    old_status = fixture.pod.status.container_statuses[0]
    new_status = fixture.new_pod.status.container_statuses[0]
    old_spec = fixture.pod.spec.containers[0]
    new_spec = fixture.new_pod.spec.containers[0]
    if change == "last_state_lost":
        old_status.last_state = V1ContainerState(
            terminated=V1ContainerStateTerminated(exit_code=137, reason="OOMKilled")
        )
    elif change == "new_image_id_known":
        old_status.image_id = ""
    elif change == "exec_command_changed":
        old_spec.readiness_probe = V1Probe(_exec=V1ExecAction(command=["/bin/true"]))
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        observed = await observation(alerts=(CRASH,), fixture=fixture)
        assert observed.facts is not None
        assert {pod.pod.owner.uid for pod in observed.facts.pods} == {
            "rs-old",
            "rs-new",
        }
        await repository.save_current_alert_observation(observed)
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        await fail_run(repository, first, clock[0])
        clock[0] += timedelta(minutes=10)
        if change in ("state_ready_swap", "ready_swap"):
            old_status.ready, new_status.ready = new_status.ready, old_status.ready
            if change == "state_ready_swap":
                old_status.state, new_status.state = new_status.state, old_status.state
        elif change == "probe_swap":
            old_spec.readiness_probe, new_spec.readiness_probe = (
                new_spec.readiness_probe,
                old_spec.readiness_probe,
            )
        elif change == "resource_swap":
            old_spec.resources, new_spec.resources = (
                new_spec.resources,
                old_spec.resources,
            )
        elif change == "image_id_swap":
            old_status.image_id, new_status.image_id = (
                new_status.image_id,
                old_status.image_id,
            )
        elif change == "identity_replacement":
            fixture.pod.metadata.name, fixture.pod.metadata.uid = (
                "replacement",
                "replacement-uid",
            )
            fixture.new_pod.metadata.name, fixture.new_pod.metadata.uid = (
                "another",
                "another-uid",
            )
        elif change == "duplicate_pod":
            duplicate = deepcopy(fixture.pod)
            duplicate.metadata.name, duplicate.metadata.uid = (
                "duplicate",
                "duplicate-uid",
            )
            fixture.pods.append(duplicate)
        elif change == "pod_removed":
            fixture.pods = [fixture.new_pod]
        elif change == "no_pods":
            fixture.pods = []
        elif change == "image_id_missing":
            old_status.image_id = ""
        elif change == "status_missing":
            fixture.pod.status.container_statuses = []
        elif change == "last_state_lost":
            old_status.last_state = None
        elif change == "new_image_id_known":
            old_status.image_id = "containerd://old-image"
        elif change == "exec_command_changed":
            old_spec.readiness_probe = V1Probe(
                _exec=V1ExecAction(command=["/bin/false"])
            )
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH,), fixture=fixture)
        )
        created = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        assert len(created) == int(expected)
        if created:
            await fail_run(repository, created[0], clock[0])
        clock[0] += timedelta(minutes=10)
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH,), fixture=fixture)
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            assert len(list(await session.scalars(select(RunRow)))) == 1 + int(expected)
        if change == "image_id_missing":
            for image_id, creates_run in (
                ("containerd://old-image", False),
                ("containerd://newly-observed-image", True),
            ):
                clock[0] += timedelta(minutes=10)
                old_status.image_id = image_id
                await repository.save_current_alert_observation(
                    await observation(clock[0], alerts=(CRASH,), fixture=fixture)
                )
                assert len(
                    await repository.reconcile_episode_diagnosis(
                        TARGET, CATALOG, MODEL, BUDGET
                    )
                ) == int(creates_run)


async def test_run_creation_failure_rolls_back_association_and_change_consumption(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(await observation())
        async with database.session_factory() as session, session.begin():
            await session.execute(
                text(
                    "CREATE TRIGGER fail_run BEFORE INSERT ON agent_runs BEGIN SELECT RAISE(ABORT, 'injected run failure'); END"
                )
            )
        with pytest.raises(PersistenceOperationError):
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
        async with database.session_factory() as session, session.begin():
            for model in (IncidentRow, RunRow, RunEventRow):
                assert list(await session.scalars(select(model))) == []
            assert (
                await session.scalars(select(AlertSignalRow))
            ).one().incident_id is None
            await session.execute(text("DROP TRIGGER fail_run"))
        (run_id,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        assert await repository.list_recoverable_run_ids() == (run_id,)


@pytest.mark.parametrize(
    "baseline",
    [
        "diagnosed",
        "uncited",
        "insufficient",
        "failed",
        "incomplete",
        "foreign_uid",
        "unmatched_image",
    ],
)
async def test_only_sufficient_cited_same_uid_evidence_can_refine_attempted_facts(
    tmp_path: Path, baseline: str
) -> None:
    clock = [FRESH_NOW]
    fixture = CurrentTargetFixture()
    status = fixture.pod.status.container_statuses[0]
    status.image_id = "" if baseline == "incomplete" else "containerd://same-image"
    status.state = V1ContainerState(
        waiting=V1ContainerStateWaiting(reason="CrashLoopBackOff")
    )
    status.ready = False
    resources = V1ResourceRequirements(limits={"cpu": "1", "memory": "64Mi"})
    fixture.pod.spec.containers[0].resources = resources
    fixture.deployment.spec.template.spec.containers[0].resources = resources
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(
            await observation(fixture=fixture)
        )
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        await repository.start_run(first, clock[0])
        status.image_id = (
            "containerd://another-image"
            if baseline == "unmatched_image"
            else "containerd://same-image"
        )
        if baseline != "unmatched_image":
            status.state = V1ContainerState(
                terminated=V1ContainerStateTerminated(exit_code=137, reason="OOMKilled")
            )
        fixture.now = clock[0] + timedelta(seconds=5)
        adapter = fixture.adapter()
        workload, pods = (
            await adapter.read_workload(TARGET),
            await adapter.read_pods(TARGET),
        )
        evidence: list[PersistedEvidence] = []
        for tool, observed in (("get_workload", workload), ("get_pods", pods)):
            await repository.record_tool_started(first, tool, tool)
            target_ref = observed.target_ref.model_dump(mode="json", by_alias=True)
            if baseline == "foreign_uid":
                target_ref["uid"] = "another-object-uid"
            evidence.append(
                await repository.record_evidence(
                    EvidenceRecord(
                        run_id=first,
                        tool_call_id=tool,
                        tool_name=tool,
                        evidence_kind=observed.evidence_kind,
                        target_ref=target_ref,
                        observed_at=observed.observed_at,
                        payload=observed.payload.model_dump(mode="json", by_alias=True),
                        truncated=False,
                        redacted=observed.redacted,
                    )
                )
            )
        outcome = (
            None
            if baseline == "failed"
            else DiagnosisOutcome.INSUFFICIENT_EVIDENCE
            if baseline == "insufficient"
            else DiagnosisOutcome.DIAGNOSED
        )
        await repository.persist_terminal(
            TerminalRecord(
                run_id=first,
                completed_at=clock[0] + timedelta(seconds=10),
                outcome=outcome,
                summary=None
                if outcome is None
                else "Observed workload and actual container state.",
                root_causes=()
                if outcome is not DiagnosisOutcome.DIAGNOSED
                else (
                    RootCauseRecord(
                        code="container_failure",
                        statement="The workload and Pod observations support the cause.",
                        confidence="high",
                        evidence_ids=tuple(
                            item.id
                            for item in (
                                evidence[:1] if baseline == "uncited" else evidence
                            )
                        ),
                    ),
                ),
                missing_information=("Container cause is unknown.",)
                if baseline == "insufficient"
                else (),
                redacted=False,
                error_code="request_timeout" if outcome is None else None,
                error_retryable=True if outcome is None else None,
                model_calls=1,
                tool_calls=2,
                input_tokens=None,
                output_tokens=None,
            )
        )
        clock[0] += timedelta(minutes=10)
        await repository.save_current_alert_observation(
            await observation(clock[0], fixture=fixture)
        )
        created = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        assert len(created) == int(baseline != "diagnosed")
        if created:
            await fail_run(repository, created[0], clock[0])
            clock[0] += timedelta(minutes=10)
            await repository.save_current_alert_observation(
                await observation(clock[0], fixture=fixture)
            )
            assert (
                await repository.reconcile_episode_diagnosis(
                    TARGET, CATALOG, MODEL, BUDGET
                )
                == ()
            )


@pytest.mark.parametrize("shared_image", [False, True])
async def test_cited_pod_state_cannot_cover_unobserved_container_readiness(
    tmp_path: Path, shared_image: bool
) -> None:
    clock = [FRESH_NOW]
    fixture = RollingPodsFixture()
    old_status = fixture.pod.status.container_statuses[0]
    new_status = fixture.new_pod.status.container_statuses[0]
    if shared_image:
        fixture.new_pod.spec.containers[0].image = fixture.pod.spec.containers[0].image
        fixture.new_pod.spec.containers[0].resources = deepcopy(
            fixture.pod.spec.containers[0].resources
        )
        new_status.image = old_status.image
        new_status.image_id = old_status.image_id
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(
            await observation(alerts=(CRASH,), fixture=fixture)
        )
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        old_status.state, new_status.state = new_status.state, old_status.state
        old_status.ready, new_status.ready = new_status.ready, old_status.ready
        await diagnose_run(repository, first, fixture, clock[0])
        clock[0] += timedelta(minutes=10)
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH,), fixture=fixture)
        )
        (second,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        await fail_run(repository, second, clock[0])
        clock[0] += timedelta(minutes=10)
        await repository.save_current_alert_observation(
            await observation(clock[0], alerts=(CRASH,), fixture=fixture)
        )
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )


async def test_failed_current_read_retains_history_but_never_authorizes_pending_diagnosis(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        observed = await observation()
        await repository.save_current_alert_observation(observed)
        await repository.reconcile_episode_diagnosis(TARGET, CATALOG, None, BUDGET)
        await repository.save_current_alert_observation(
            observed.model_copy(
                update={
                    "facts": None,
                    "summary": CurrentAlertSummary(
                        observed_at=FRESH_NOW,
                        received_at=FRESH_NOW,
                        reason=ObservationReason.UNAVAILABLE,
                    ),
                }
            )
        )
        retained = await repository.get_current_alert_observation(TARGET)
        assert retained is not None and retained.facts is not None
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            assert list(await session.scalars(select(RunRow))) == []
            incident = (await session.scalars(select(IncidentRow))).one()
            assert (
                incident.pending_diagnosis_json is not None
                and "awaiting_observation" in incident.pending_diagnosis_json
            )


async def test_recreated_uid_never_inherits_old_occurrence_or_automatic_budget(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        old = occurrence(CRASH, 1)
        await repository.apply_alert_occurrences((old,))
        await repository.save_current_alert_observation(await observation())
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        old_snapshot = await repository.get_workflow_run_snapshot(first)
        clock[0] += timedelta(minutes=1)
        replacement = CurrentTargetFixture(clock[0])
        replacement.deployment.metadata.uid = "replacement-deployment"
        replacement.deployment.metadata.creation_timestamp = clock[0] - timedelta(
            seconds=30
        )
        for replica in replacement.replicas:
            replica.metadata.owner_references[0].uid = "replacement-deployment"
        observed = await observation(clock[0])
        observed = observed.model_copy(
            update={"facts": await replacement.adapter().read_current_target(TARGET)}
        )
        await repository.save_current_alert_observation(observed)
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        new = occurrence(CRASH, 2, clock[0])
        await repository.apply_alert_occurrences((new,))
        (second,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        current = await repository.get_workflow_run_snapshot(second)
        assert current.incident_id != old_snapshot.incident_id
        assert await repository.get_workflow_run_snapshot(first) == old_snapshot
        async with database.session_factory() as session:
            current_run = await session.get(RunRow, str(second))
            assert current_run is not None and current_run.attempt == 1
            old_signal = await session.get(
                AlertSignalRow, (old.fingerprint, old.starts_at)
            )
            new_signal = await session.get(
                AlertSignalRow, (new.fingerprint, new.starts_at)
            )
            assert old_signal is not None and old_signal.incident_id == str(
                old_snapshot.incident_id
            )
            assert new_signal is not None and new_signal.incident_id == str(
                current.incident_id
            )


async def test_manual_and_automatic_creation_share_one_atomic_slot_and_keep_later_changes(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        await repository.save_current_alert_observation(await observation())
        (first,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        await fail_run(repository, first, clock[0])
        initial = await repository.get_workflow_run_snapshot(first)
        clock[0] += timedelta(minutes=10)
        await repository.apply_alert_occurrences((occurrence(LIVENESS, 2, clock[0]),))
        await repository.save_current_alert_observation(await observation(clock[0]))
        await asyncio.gather(
            repository.create_run(
                initial.incident_id, MODEL, BUDGET, operator_ref="operator"
            ),
            repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET),
            return_exceptions=True,
        )
        async with database.session_factory() as session:
            runs = list(await session.scalars(select(RunRow).order_by(RunRow.attempt)))
            assert len(runs) == 2 and runs[1].attempt == 2
        with pytest.raises(ActiveRunExistsError):
            await repository.create_run(
                initial.incident_id, MODEL, BUDGET, operator_ref="operator"
            )
        await repository.apply_alert_occurrences((occurrence(REPLICAS, 3, clock[0]),))
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            incident = await session.get(IncidentRow, str(initial.incident_id))
            assert incident is not None and incident.pending_diagnosis_json is not None
            assert REPLICAS in incident.pending_diagnosis_json
        await fail_run(repository, UUID(runs[1].id), clock[0])
        clock[0] += timedelta(minutes=10)
        await repository.save_current_alert_observation(await observation(clock[0]))
        (third,) = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        snapshot = await repository.get_workflow_run_snapshot(third)
        assert (
            isinstance(snapshot, DiagnosisWorkflowRunSnapshot)
            and snapshot.diagnosis_trigger is not None
        )
        assert REPLICAS in {
            reference.source.ref for reference in snapshot.diagnosis_trigger.changes
        }


@pytest.mark.parametrize("state", [CurrentAlertState.CLEAR, CurrentAlertState.UNKNOWN])
async def test_pending_change_is_rechecked_when_no_rule_is_firing(
    tmp_path: Path, state: CurrentAlertState
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        observed = await observation()
        await repository.save_current_alert_observation(observed)
        await repository.reconcile_episode_diagnosis(TARGET, CATALOG, None, BUDGET)
        observed = observed.model_copy(
            update={
                "summary": observed.summary.model_copy(
                    update={
                        "state": state,
                        "complete": state is CurrentAlertState.CLEAR,
                        "rules": tuple(
                            rule.model_copy(
                                update={
                                    "state": state,
                                    "complete": state is CurrentAlertState.CLEAR,
                                }
                            )
                            for rule in observed.summary.rules
                        ),
                    }
                )
            }
        )
        await repository.save_current_alert_observation(observed)
        assert (
            await repository.reconcile_episode_diagnosis(TARGET, CATALOG, MODEL, BUDGET)
            == ()
        )
        async with database.session_factory() as session:
            incident = (await session.scalars(select(IncidentRow))).one()
            if state is CurrentAlertState.CLEAR:
                assert incident.pending_diagnosis_json is None
            else:
                assert (
                    incident.pending_diagnosis_json is not None
                    and "awaiting_observation" in incident.pending_diagnosis_json
                )


async def test_old_signal_never_binds_to_new_uid_but_an_independent_firing_rule_can_bind(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.apply_alert_occurrences(
            (
                occurrence(CRASH, 1, FRESH_NOW - timedelta(hours=1)),
                occurrence(LIVENESS, 2),
            )
        )
        observed = await observation()
        observed = observed.model_copy(
            update={
                "summary": observed.summary.model_copy(
                    update={
                        "state": CurrentAlertState.UNKNOWN,
                        "complete": False,
                        "rules": tuple(
                            rule
                            if rule.alert_id == LIVENESS
                            else rule.model_copy(
                                update={
                                    "state": CurrentAlertState.UNKNOWN,
                                    "complete": False,
                                }
                            )
                            for rule in observed.summary.rules
                        ),
                    }
                )
            }
        )
        await repository.save_current_alert_observation(observed)
        created = await repository.reconcile_episode_diagnosis(
            TARGET, CATALOG, MODEL, BUDGET
        )
        assert len(created) == 1
        snapshot = await repository.get_workflow_run_snapshot(created[0])
        assert snapshot.source.ref == LIVENESS
        async with database.session_factory() as session:
            old = await session.get(
                AlertSignalRow,
                (
                    occurrence(CRASH, 1, FRESH_NOW - timedelta(hours=1)).fingerprint,
                    occurrence(CRASH, 1, FRESH_NOW - timedelta(hours=1)).starts_at,
                ),
            )
            assert old is not None and old.incident_id is None
