from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    EventsV1EventList,
    V1Container,
    V1ContainerState,
    V1ContainerStateWaiting,
    V1ContainerStatus,
    V1ListMeta,
    V1ObjectReference,
    V1PodList,
    V1PodStatus,
    V1ReplicaSetList,
)
from sqlalchemy import func, select, update
from tests.factories import normalized_trigger
from tests.unit.kubernetes.test_adapter_events import (
    _event,  # pyright: ignore[reportPrivateUsage]
    _pod,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.kubernetes.test_adapter_rollout_history import (
    TARGET,
    _deployment,  # pyright: ignore[reportPrivateUsage]
    _replica_set,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    NOW,
    _database,  # pyright: ignore[reportPrivateUsage]
)

from k8s_incident_agent.diagnosis.contracts import ValidatedDiagnosis
from k8s_incident_agent.domain.contracts import RepairHistorySelection
from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    JsonValue,
    NormalizedAlertOccurrence,
    RepairWorkflowRunSnapshot,
    RunStatus,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.persistence.models import RunEventRow
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.repair.client import PatchValidator
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationResponse,
    RepairProposal,
)
from k8s_incident_agent.repair.preparation import prepare_repair
from k8s_incident_agent.repair.records import RepairTerminalRecord

FRESH_NOW = NOW + timedelta(minutes=1)
CURRENT = "registry.invalid/workload:v2"
PREVIOUS = "registry.k8s.io/agnhost:2.53"


class KubernetesFixture:
    def __init__(self, now: datetime = FRESH_NOW) -> None:
        self.now = now
        self.deployment = cast(Any, _deployment())
        self.deployment.metadata.resource_version = "fresh-rv"
        self.replicas: list[Any] = [
            _replica_set("rs-new", "rs-new", "3", [("workload", CURRENT)]),
            _replica_set("rs-old", "rs-old", "2", [("workload", PREVIOUS)]),
            _replica_set(
                "rs-older",
                "rs-older",
                "1",
                [("workload", "registry.k8s.io/agnhost:2.52")],
            ),
        ]
        self.pod = cast(Any, _pod("broken-pod", "pod-uid", "rs-new"))
        self.pod.metadata.owner_references[0].name = "rs-new"
        self.pod.spec.containers = [V1Container(name="workload", image=CURRENT)]
        self.pod.status = V1PodStatus(
            phase="Pending",
            container_statuses=[
                V1ContainerStatus(
                    name="workload",
                    image=CURRENT,
                    image_id="",
                    ready=False,
                    restart_count=0,
                    state=V1ContainerState(
                        waiting=V1ContainerStateWaiting(reason="ImagePullBackOff")
                    ),
                )
            ],
        )
        self.event = cast(
            Any,
            _event(
                "pull-failed",
                "event-uid",
                V1ObjectReference(
                    api_version="v1",
                    kind="Pod",
                    namespace=TARGET.namespace,
                    name="broken-pod",
                    uid="pod-uid",
                ),
                now,
                note="Failed to pull image",
            ),
        )
        self.error: KubernetesErrorCode | None = None
        self.rv_drift = False
        self.reads = 0

    def adapter(self) -> KubernetesEvidenceAdapter:
        return KubernetesEvidenceAdapter(
            cast(
                KubernetesClients,
                SimpleNamespace(
                    apps_api=self,
                    core_api=self,
                    events_api=self,
                    discovery_api=object(),
                    storage_api=object(),
                    timeout_seconds=10.0,
                    cluster_id=TARGET.cluster,
                    diagnostic_namespace=TARGET.namespace,
                ),
            ),
            clock=lambda: self.now,
        )

    async def read_namespaced_deployment(self, **_: object) -> object:
        if self.error is not None:
            raise KubernetesBoundaryError(self.error)
        self.reads += 1
        if self.rv_drift:
            self.deployment.metadata.resource_version = f"rv-{self.reads}"
        return self.deployment

    async def list_namespaced_replica_set(self, **_: object) -> object:
        return V1ReplicaSetList(metadata=V1ListMeta(), items=self.replicas)

    async def list_namespaced_pod(self, **_: object) -> object:
        return V1PodList(metadata=V1ListMeta(), items=[self.pod])

    async def list_namespaced_event(self, **_: object) -> object:
        return EventsV1EventList(metadata=V1ListMeta(), items=[self.event])


class ValidatorFixture:
    error: str | None = None

    async def validate(
        self, proposal: RepairProposal, *, deadline: object
    ) -> PatchValidationResponse:
        del deadline
        return PatchValidationResponse.model_validate(
            {
                "proposal_id": proposal.id,
                "run_id": proposal.run_id,
                "proposal_digest": proposal.digest,
                "outcome": "failed" if self.error else "passed",
                "checked_at": FRESH_NOW,
                "error": {"code": self.error, "retryable": False}
                if self.error
                else None,
            }
        )


def credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=FRESH_NOW + timedelta(hours=1),
        _kubeconfig={},
    )


async def seed_source(
    repository: IncidentRepository, occurrence: NormalizedAlertOccurrence | None = None
) -> tuple[UUID, UUID]:
    if occurrence is None:
        created = await repository.create_incident_and_run(
            normalized_trigger(), MODEL, BUDGET
        )
        incident_id, run_id = created.incident_id, created.run_id
    else:
        batch = await repository.apply_alert_occurrences((occurrence,), MODEL, BUDGET)
        run_id = batch.created_run_ids[0]
        incident_id = (await repository.get_workflow_run_snapshot(run_id)).incident_id
    await repository.start_run(run_id, NOW)
    source_fixture = KubernetesFixture(NOW)
    source_fixture.deployment.metadata.resource_version = "old-rv"
    adapter = source_fixture.adapter()
    evidence_ids: list[UUID] = []
    for kind, reader in (
        ("workload", adapter.read_workload),
        ("rollout_history", adapter.read_rollout_history),
    ):
        observation = await reader(TARGET)
        await repository.record_tool_started(run_id, kind, f"get_{kind}")
        evidence = await repository.record_evidence(
            EvidenceRecord(
                run_id=run_id,
                tool_call_id=kind,
                tool_name=f"get_{kind}",
                evidence_kind=kind,
                target_ref=cast(
                    dict[str, JsonValue],
                    observation.target_ref.model_dump(mode="json", by_alias=True),
                ),
                observed_at=observation.observed_at,
                payload=cast(
                    dict[str, JsonValue],
                    observation.payload.model_dump(mode="json", by_alias=True),
                ),
                truncated=False,
                redacted=False,
            )
        )
        evidence_ids.append(evidence.id)
    diagnosis = ValidatedDiagnosis.model_validate(
        {
            "outcome": "diagnosed",
            "summary": "The configured image cannot be pulled.",
            "root_causes": [
                {
                    "code": "image_invalid_registry",
                    "statement": "The image references a reserved registry.",
                    "confidence": "high",
                    "evidence_ids": [str(value) for value in evidence_ids],
                }
            ],
            "missing_information": [],
            "redacted": False,
            "repair_intent": {
                "action": "set_container_image",
                "target": TARGET.model_dump(),
                "container_name": "workload",
                "replacement_image": PREVIOUS,
                "evidence_ids": [str(value) for value in evidence_ids],
            },
        }
    )
    proposal = compile_repair_proposal(
        EvidenceBoundImageChange(
            run_id=run_id,
            action="set_container_image",
            target=TARGET,
            target_uid="deployment-uid",
            target_resource_version="old-rv",
            container_index=0,
            container_name="workload",
            current_image=CURRENT,
            replacement_image=PREVIOUS,
            evidence_ids=sorted(evidence_ids, key=str),
        ),
        schema_checked_at=NOW,
        policy_checked_at=NOW,
        diff_checked_at=NOW,
    )
    validation = PatchValidationResponse(
        proposal_id=proposal.id,
        run_id=run_id,
        proposal_digest=proposal.digest,
        outcome="passed",
        checked_at=NOW,
        error=None,
    )
    await repository.persist_repair_terminal(
        RepairTerminalRecord(
            run_id=run_id,
            diagnosis_completed_at=NOW,
            completed_at=NOW,
            diagnosis=diagnosis,
            proposal=proposal,
            validation=validation,
            error_code=None,
            error_retryable=None,
            model_calls=1,
            tool_calls=2,
        )
    )
    return incident_id, run_id


async def create_preparation(
    repository: IncidentRepository,
    incident_id: UUID,
    source_run_id: UUID,
    selection: RepairHistorySelection | None = None,
) -> RepairWorkflowRunSnapshot:
    created = await repository.create_repair_run(
        incident_id,
        source_run_id,
        selection=selection,
        replaces_run_id=None,
        operator_ref="sandbox-operator",
        now=FRESH_NOW,
    )
    assert created is not None
    await repository.start_run(created.run_id, FRESH_NOW)
    run = await repository.get_workflow_run_snapshot(created.run_id)
    assert isinstance(run, RepairWorkflowRunSnapshot)
    return run


@pytest.mark.parametrize(
    "selection,image",
    [
        (None, PREVIOUS),
        (
            RepairHistorySelection(revision=1, replica_set_uid="rs-older"),
            "registry.k8s.io/agnhost:2.52",
        ),
    ],
)
async def test_fresh_evidence_and_controlled_history_prepare_a_new_waiting_run(
    tmp_path: Path,
    selection: RepairHistorySelection | None,
    image: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        before = await repository.get_incident_detail(
            incident_id, run_id=source_id, event_limit=100
        )
        run = await create_preparation(repository, incident_id, source_id, selection)
        prepared = await prepare_repair(
            run,
            repository=repository,
            adapter=KubernetesFixture().adapter(),
            credential=credential(),
            validator=cast(PatchValidator, ValidatorFixture()),
            now=lambda: FRESH_NOW,
        )
        assert prepared.error_code is None
        await repository.persist_prepared_repair(prepared)
        detail = await repository.get_incident_detail(
            incident_id, run_id=run.id, event_limit=100
        )
        assert detail is not None and detail.repair is not None
        assert (
            detail.run.status is RunStatus.WAITING_APPROVAL and detail.diagnosis is None
        )
        assert detail.run.waiting_expires_at == FRESH_NOW + timedelta(minutes=15)
        assert detail.repair.proposal.replacement_image == image
        assert detail.repair.proposal.target_resource_version == "fresh-rv"
        assert len(detail.evidence) == 4
        assert {
            item.event.payload["runKind"]
            for item in await _evidence_outcomes(repository, run.id)
        } == {"repair"}
        assert before is not None
        after = await repository.get_incident_detail(
            incident_id, run_id=source_id, event_limit=100
        )
        assert (
            after is not None
            and after.run == before.run
            and after.repair == before.repair
            and after.evidence == before.evidence
        )


async def _evidence_outcomes(repository: IncidentRepository, run_id: UUID) -> list[Any]:
    return [
        await repository.get_tool_outcome(run_id, f"repair:{name}", name)
        for name in ("get_workload", "get_rollout_history", "get_pods", "get_events")
    ]


async def test_repair_evidence_replay_requires_the_persisted_started_event_to_precede_it(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(repository, incident_id, source_id)
        await prepare_repair(
            run,
            repository=repository,
            adapter=KubernetesFixture().adapter(),
            credential=credential(),
            validator=cast(PatchValidator, ValidatorFixture()),
            now=lambda: FRESH_NOW,
        )
        async with database.session_factory() as session, session.begin():
            maximum = await session.scalar(select(func.max(RunEventRow.id)))
            assert maximum is not None
            await session.execute(
                update(RunEventRow)
                .where(
                    RunEventRow.run_id == str(run.id),
                    RunEventRow.event_key == "tool:repair:get_workload:started",
                )
                .values(id=maximum + 1)
            )
        with pytest.raises(RecoveryConsistencyError):
            await repository.get_tool_outcome(
                run.id, "repair:get_workload", "get_workload"
            )
        detail = await repository.get_incident_detail(
            incident_id, run_id=run.id, event_limit=100
        )
        assert (
            detail is not None
            and detail.run.status is RunStatus.RUNNING
            and detail.repair is None
        )


@pytest.mark.parametrize(
    "case,expected",
    [
        ("uid", "stale_resource"),
        ("container", "stale_resource"),
        ("image", "stale_resource"),
        ("symptom", "stale_resource"),
        ("event_uid", "stale_resource"),
        ("rv_drift", "stale_resource"),
        ("candidate_missing", "repair_no_candidate"),
        ("candidate_ambiguous", "repair_no_candidate"),
        ("redacted", "repair_policy_denied"),
        ("truncated", "repair_policy_denied"),
        ("credential", "authentication_failed"),
        ("permission", "permission_denied"),
        ("timeout", "repair_timeout"),
        ("gate", "patch_validator_admission_denied"),
    ],
)
async def test_preparation_failures_preserve_evidence_and_never_wait(
    tmp_path: Path,
    case: str,
    expected: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(repository, incident_id, source_id)
        fixture = KubernetesFixture()
        validator = ValidatorFixture()
        if case == "uid":
            fixture.deployment.metadata.uid = "recreated"
        if case == "container":
            fixture.deployment.spec.template.spec.containers[0].name = "changed"
        if case == "image":
            fixture.deployment.spec.template.spec.containers[0].image = PREVIOUS
        if case == "symptom":
            fixture.pod.status.container_statuses[
                0
            ].state.waiting.reason = "CrashLoopBackOff"
        if case == "event_uid":
            fixture.event.regarding.uid = "unrelated"
        if case == "rv_drift":
            fixture.rv_drift = True
        if case == "candidate_missing":
            fixture.replicas = fixture.replicas[:1]
        if case == "candidate_ambiguous":
            fixture.replicas[-1].spec.template.spec.containers[0].image = PREVIOUS
        if case == "redacted":
            fixture.event.note = "token=abcdefghijklmnopqrstuvwxyz"
        if case == "truncated":
            fixture.event.note = "A" * 10000
        if case == "permission":
            fixture.error = KubernetesErrorCode.PERMISSION_DENIED
        if case == "gate":
            validator.error = "patch_validator_admission_denied"
        check_now = (
            FRESH_NOW + timedelta(seconds=61) if case == "timeout" else FRESH_NOW
        )
        lease = credential()
        if case == "credential":
            lease = DiagnosticCredential(
                kubeconfig_path=lease.kubeconfig_path,
                context_name=lease.context_name,
                server_url=lease.server_url,
                expires_at=FRESH_NOW,
                _kubeconfig={},
            )
        result = await prepare_repair(
            run,
            repository=repository,
            adapter=fixture.adapter(),
            credential=lease,
            validator=cast(PatchValidator, validator),
            now=lambda: check_now,
        )
        assert result.error_code == expected
        await repository.persist_prepared_repair(result)
        detail = await repository.get_incident_detail(
            incident_id, run_id=run.id, event_limit=100
        )
        assert detail is not None and detail.run.status is RunStatus.FAILED
        assert (
            detail.run.error_code == expected and detail.run.waiting_expires_at is None
        )
        assert (detail.repair is not None) == (case == "gate")


@pytest.mark.parametrize("revision,uid", [(3, "rs-new"), (2, "other"), (1, "rs-old")])
async def test_controlled_selection_rejects_current_or_mismatched_fresh_history(
    tmp_path: Path,
    revision: int,
    uid: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(
            repository,
            incident_id,
            source_id,
            RepairHistorySelection(revision=revision, replica_set_uid=uid),
        )
        result = await prepare_repair(
            run,
            repository=repository,
            adapter=KubernetesFixture().adapter(),
            credential=credential(),
            validator=cast(PatchValidator, ValidatorFixture()),
            now=lambda: FRESH_NOW,
        )
        await repository.persist_prepared_repair(result)
        detail = await repository.get_incident_detail(
            incident_id, run_id=run.id, event_limit=100
        )
        assert detail is not None and detail.run.error_code == "repair_no_candidate"
        assert detail.run.status is RunStatus.FAILED and detail.repair is None
