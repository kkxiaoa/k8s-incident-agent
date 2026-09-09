from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast, override
from uuid import UUID, uuid4

import pytest
from langchain_core.language_models.base import LanguageModelInput
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.runnables import Runnable
from langchain_core.runnables.config import RunnableConfig
from langchain_core.tools import BaseTool
from pydantic import PrivateAttr

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.policy import DiagnosticPolicy
from k8s_incident_agent.domain.contracts import IncidentSource
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    DiagnosisValidationSnapshot,
    IncidentStatus,
    ModelSnapshot,
    PersistedEvidence,
    RunBudget,
    RunEvent,
    RunRecord,
    RunStatus,
    TerminalRecord,
    WorkflowRunSnapshot,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.repair.client import PatchValidator
from k8s_incident_agent.repair.contracts import (
    PatchValidationResponse,
    RepairProposal,
)
from k8s_incident_agent.repair.records import RepairTerminalRecord
from k8s_incident_agent.scenarios.contracts import ScenarioTarget
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import GraphDependencies, build_incident_graph

NOW = datetime(2026, 9, 7, 9, 0, tzinfo=UTC)
CURRENT_IMAGE = "registry.invalid/k8s-incident-agent/missing:v2"
PREVIOUS_IMAGE = "registry.k8s.io/e2e-test-images/agnhost:2.53"
REPAIR_POLICY = DiagnosticPolicy(
    tool_names=(
        "get_workload",
        "get_rollout_history",
        "get_pods",
        "get_events",
        "query_prometheus",
    ),
    required_evidence=frozenset({"workload", "rollout_history", "pods", "events"}),
    prometheus_panel_ids=("image-pull-affected-pods",),
    repair_action="set_container_image",
)


class _ToolCallingModel(FakeMessagesListChatModel):
    _calls: int = PrivateAttr(default=0)

    @property
    def calls(self) -> int:
        return self._calls

    @override
    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[LanguageModelInput, AIMessage]:
        del tools, tool_choice, kwargs
        return cast("Runnable[LanguageModelInput, AIMessage]", self)

    @override
    async def _agenerate(self, *args: Any, **kwargs: Any) -> Any:
        self._calls += 1
        return await super()._agenerate(*args, **kwargs)


class _Repository:
    def __init__(
        self,
        snapshot: WorkflowRunSnapshot,
        validation_snapshot: DiagnosisValidationSnapshot,
    ) -> None:
        self.snapshot = snapshot
        self.validation_snapshot = validation_snapshot
        self.terminals: list[TerminalRecord] = []
        self.repair_terminals: list[RepairTerminalRecord] = []

    async def get_workflow_run_snapshot(self, run_id: UUID) -> WorkflowRunSnapshot:
        assert run_id == self.snapshot.id
        return self.snapshot

    async def start_run(self, run_id: UUID, started_at: datetime) -> RunRecord:
        assert run_id == self.snapshot.id
        self.snapshot = replace(
            self.snapshot,
            run_status=RunStatus.RUNNING,
            started_at=started_at,
        )
        return RunRecord(
            id=run_id,
            incident_id=self.snapshot.incident_id,
            status=RunStatus.RUNNING,
            incident_status=IncidentStatus.TRIAGING,
            started_at=started_at,
            event=RunEvent(
                id=1,
                incident_id=self.snapshot.incident_id,
                run_id=run_id,
                event_key="run.started",
                event_type="run.started",
                occurred_at=started_at,
                payload={},
            ),
        )

    async def get_diagnosis_validation_snapshot(
        self,
        run_id: UUID,
    ) -> DiagnosisValidationSnapshot:
        assert run_id == self.snapshot.id
        return self.validation_snapshot

    async def persist_terminal(self, terminal: TerminalRecord) -> object:
        self.terminals.append(terminal)
        return object()

    async def persist_repair_terminal(
        self,
        terminal: RepairTerminalRecord,
    ) -> object:
        self.repair_terminals.append(terminal)
        return object()


class _Validator:
    def __init__(
        self,
        *,
        failure: tuple[str, bool] | None = None,
    ) -> None:
        self.failure = failure
        self.calls: list[RepairProposal] = []

    async def validate(
        self,
        proposal: RepairProposal,
        *,
        deadline: datetime,
    ) -> PatchValidationResponse:
        assert deadline == NOW + timedelta(seconds=180)
        self.calls.append(proposal)
        return PatchValidationResponse.model_validate(
            {
                "proposal_id": proposal.id,
                "run_id": proposal.run_id,
                "proposal_digest": proposal.digest,
                "outcome": "failed" if self.failure is not None else "passed",
                "checked_at": NOW,
                "error": (
                    None
                    if self.failure is None
                    else {
                        "code": self.failure[0],
                        "retryable": self.failure[1],
                    }
                ),
            }
        )


def _run() -> WorkflowRunSnapshot:
    return WorkflowRunSnapshot(
        id=uuid4(),
        incident_id=uuid4(),
        source=IncidentSource(
            type="scenario",
            ref="image-pull-backoff",
            revision="1",
        ),
        run_status=RunStatus.QUEUED,
        trigger_summary="The target Deployment cannot pull its image.",
        target=ScenarioTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="image-pull-backoff",
        ),
        model=_model_snapshot(),
        budget=RunBudget(
            max_model_calls=8,
            max_tool_calls=6,
            timeout_seconds=180,
        ),
        started_at=None,
    )


def _model_snapshot() -> ModelSnapshot:
    return ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-v4-flash",
        thinking_mode=False,
        prompt_version="stage1-v1",
    )


def _credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(hours=1),
        _kubeconfig={},
    )


def _context(run: WorkflowRunSnapshot) -> DiagnosticToolContext:
    return DiagnosticToolContext(
        run=AgentRunSnapshot(
            id=run.id,
            started_at=NOW,
            timeout_seconds=run.budget.timeout_seconds,
        ),
        target=run.target,
        credential=_credential(),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        repository=cast(IncidentRepository, object()),
        now=lambda: NOW,
        prometheus=cast(PrometheusQueryService, object()),
    )


def _dependencies(
    saver: object,
    repository: _Repository,
    model: _ToolCallingModel,
    validator: _Validator,
) -> GraphDependencies:
    return GraphDependencies(
        repository=cast(IncidentRepository, repository),
        checkpointer=cast(Any, saver),
        model=model,
        model_snapshot=_model_snapshot(),
        credential=_credential(),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        prometheus=cast(PrometheusQueryService, object()),
        now=lambda: NOW,
        patch_validator=cast(PatchValidator, validator),
    )


def _evidence(
    *,
    run: WorkflowRunSnapshot,
    evidence_id: UUID,
    kind: str,
    payload: dict[str, Any],
    target_uid: str = "deployment-uid",
) -> PersistedEvidence:
    return PersistedEvidence(
        id=evidence_id,
        run_id=run.id,
        tool_call_id=f"call-{kind}",
        tool_name=f"get_{kind}",
        evidence_kind=kind,
        target_ref={
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "namespace": "k8s-incident-scenarios",
            "name": "image-pull-backoff",
            "uid": target_uid,
        },
        observed_at=NOW,
        payload=payload,
        truncated=False,
        redacted=False,
        event=RunEvent(
            id=1,
            incident_id=run.incident_id,
            run_id=run.id,
            event_key=f"tool:call-{kind}:evidence",
            event_type="evidence.recorded",
            occurred_at=NOW,
            payload={},
        ),
    )


def _validation_snapshot(
    run: WorkflowRunSnapshot,
    *,
    rollout_uid: str = "deployment-uid",
) -> tuple[DiagnosisValidationSnapshot, dict[str, UUID]]:
    ids = {kind: uuid4() for kind in ("workload", "rollout_history", "pods", "events")}
    source_workload = {
        "resourceVersion": "42",
        "selector": {"matchLabels": {"app": "image-pull"}},
    }
    workload = _evidence(
        run=run,
        evidence_id=ids["workload"],
        kind="workload",
        payload={
            "workload": {
                "resourceVersion": "42",
                "generation": 3,
                "observedGeneration": 3,
                "replicas": {
                    "desired": 1,
                    "updated": 1,
                    "ready": 0,
                    "available": 0,
                },
                "selector": {"matchLabels": {"app": "image-pull"}},
                "containers": [
                    {
                        "name": "workload",
                        "image": CURRENT_IMAGE,
                        "imagePullPolicy": "Always",
                        "command": [],
                        "args": [],
                        "probes": [],
                        "sourceIndex": 0,
                    }
                ],
                "conditions": [],
            }
        },
    )
    rollout = _evidence(
        run=run,
        evidence_id=ids["rollout_history"],
        kind="rollout_history",
        target_uid=rollout_uid,
        payload={
            "sourceWorkload": source_workload,
            "revisions": [
                {
                    "revision": 3,
                    "replicaSetRef": {
                        "apiVersion": "apps/v1",
                        "kind": "ReplicaSet",
                        "namespace": "k8s-incident-scenarios",
                        "name": "image-pull-new",
                        "uid": "replicaset-new",
                    },
                    "containers": [{"name": "workload", "image": CURRENT_IMAGE}],
                },
                {
                    "revision": 2,
                    "replicaSetRef": {
                        "apiVersion": "apps/v1",
                        "kind": "ReplicaSet",
                        "namespace": "k8s-incident-scenarios",
                        "name": "image-pull-old",
                        "uid": "replicaset-old",
                    },
                    "containers": [{"name": "workload", "image": PREVIOUS_IMAGE}],
                },
            ],
        },
    )
    pods = _evidence(
        run=run,
        evidence_id=ids["pods"],
        kind="pods",
        payload={
            "sourceWorkload": source_workload,
            "pods": [
                {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "namespace": "k8s-incident-scenarios",
                    "name": "image-pull-pod",
                    "uid": "pod-uid",
                    "resourceVersion": "43",
                    "owner": {
                        "apiVersion": "apps/v1",
                        "kind": "ReplicaSet",
                        "name": "image-pull-new",
                        "uid": "replicaset-new",
                        "controller": True,
                    },
                    "phase": "Pending",
                    "conditions": [],
                    "containers": [
                        {
                            "name": "workload",
                            "image": CURRENT_IMAGE,
                            "imageId": None,
                            "restartCount": 0,
                            "state": {
                                "status": "waiting",
                                "reason": "ImagePullBackOff",
                                "message": "Image pull failed.",
                            },
                        }
                    ],
                }
            ],
        },
    )
    events = _evidence(
        run=run,
        evidence_id=ids["events"],
        kind="events",
        payload={
            "sourceWorkload": source_workload,
            "associatedReplicaSetCount": 1,
            "associatedPodCount": 1,
            "events": [
                {
                    "apiVersion": "events.k8s.io/v1",
                    "kind": "Event",
                    "namespace": "k8s-incident-scenarios",
                    "name": "image-pull-event",
                    "uid": "event-uid",
                    "resourceVersion": "44",
                    "regarding": {
                        "apiVersion": "v1",
                        "kind": "Pod",
                        "namespace": "k8s-incident-scenarios",
                        "name": "image-pull-pod",
                        "uid": "pod-uid",
                    },
                    "type": "Warning",
                    "reason": "Failed",
                    "action": "Pulling",
                    "note": "Image pull failed.",
                    "eventTime": NOW.isoformat(),
                    "seriesCount": 1,
                    "reportingController": "kubelet",
                }
            ],
        },
    )
    return (
        DiagnosisValidationSnapshot(
            evidence_by_id={
                item.id: item for item in (workload, rollout, pods, events)
            },
            tool_failures=(),
            unresolved_tool_failures=(),
        ),
        ids,
    )


def _diagnosis_response(
    run: WorkflowRunSnapshot,
    evidence_ids: dict[str, UUID],
    *,
    include_repair: bool = True,
) -> AIMessage:
    args: dict[str, Any] = {
        "outcome": "diagnosed",
        "summary": "The reserved image registry cannot be pulled.",
        "root_causes": [
            {
                "code": "image_pull_forbidden",
                "statement": "The current image uses the reserved invalid registry.",
                "confidence": "high",
                "evidence_ids": [str(value) for value in evidence_ids.values()],
            }
        ],
        "missing_information": [],
    }
    if include_repair:
        args["repair_intent"] = {
            "action": "set_container_image",
            "target": run.target.model_dump(mode="json"),
            "container_name": "workload",
            "replacement_image": PREVIOUS_IMAGE,
            "evidence_ids": [
                str(evidence_ids["workload"]),
                str(evidence_ids["rollout_history"]),
            ],
        }
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": args,
                "id": "call-structured",
                "type": "tool_call",
            }
        ],
    )


def _config(run: WorkflowRunSnapshot) -> RunnableConfig:
    return {"configurable": {"thread_id": str(run.id)}}


@pytest.mark.asyncio
async def test_repair_workflow_reaches_waiting_approval_with_fixed_patch(
    tmp_path: Path,
) -> None:
    run = _run()
    snapshot, ids = _validation_snapshot(run)
    repository = _Repository(run, snapshot)
    validator = _Validator()
    model = _ToolCallingModel(responses=[_diagnosis_response(run, ids)])

    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(
            _dependencies(saver, repository, model, validator),
            run,
            REPAIR_POLICY,
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            _config(run),
            context=_context(run),
            durability="sync",
        )

    assert model.calls == 1
    assert len(validator.calls) == 1
    assert repository.terminals == []
    assert len(repository.repair_terminals) == 1
    terminal = repository.repair_terminals[0]
    assert terminal.error_code is None
    assert terminal.proposal is not None
    assert terminal.validation is not None
    assert terminal.validation.outcome == "passed"
    assert terminal.proposal.evidence_ids == tuple(
        sorted((ids["workload"], ids["rollout_history"]), key=str)
    )
    assert [operation.op for operation in terminal.proposal.patch] == [
        "test",
        "test",
        "test",
        "test",
        "replace",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "boundary",
    [
        "validate_repair_schema",
        "validate_repair_policy",
        "validate_repair_diff",
        "validate_repair_dry_run",
    ],
)
async def test_repair_checkpoint_resume_keeps_one_run_and_one_dry_run(
    tmp_path: Path,
    boundary: str,
) -> None:
    run = _run()
    snapshot, ids = _validation_snapshot(run)
    repository = _Repository(run, snapshot)
    validator = _Validator()
    first_model = _ToolCallingModel(responses=[_diagnosis_response(run, ids)])
    database = tmp_path / f"{boundary}.sqlite3"

    async with open_checkpoint_store(database) as saver:
        first_graph = build_incident_graph(
            _dependencies(saver, repository, first_model, validator),
            run,
            REPAIR_POLICY,
        )
        await first_graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            _config(run),
            context=_context(run),
            interrupt_after=[boundary],
            durability="sync",
        )
        checkpoint = await first_graph.aget_state(_config(run))
        assert checkpoint.next != ()

        resumed_model = _ToolCallingModel(responses=[AIMessage(content="unused")])
        resumed_graph = build_incident_graph(
            _dependencies(saver, repository, resumed_model, validator),
            run,
            REPAIR_POLICY,
        )
        await resumed_graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            None,
            _config(run),
            context=_context(run),
            durability="sync",
        )

    assert first_model.calls == 1
    assert resumed_model.calls == 0
    assert len(validator.calls) == 1
    assert len(repository.repair_terminals) == 1
    assert repository.repair_terminals[0].validation is not None


@pytest.mark.asyncio
async def test_dry_run_failure_persists_proposal_and_typed_error(
    tmp_path: Path,
) -> None:
    run = _run()
    snapshot, ids = _validation_snapshot(run)
    repository = _Repository(run, snapshot)
    validator = _Validator(failure=("stale_resource", False))
    model = _ToolCallingModel(responses=[_diagnosis_response(run, ids)])

    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(
            _dependencies(saver, repository, model, validator),
            run,
            REPAIR_POLICY,
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            _config(run),
            context=_context(run),
            durability="sync",
        )

    [terminal] = repository.repair_terminals
    assert terminal.proposal is not None
    assert terminal.validation is not None
    assert terminal.validation.outcome == "failed"
    assert terminal.error_code == "stale_resource"
    assert terminal.error_retryable is False


@pytest.mark.asyncio
async def test_policy_failure_persists_diagnosis_without_proposal(
    tmp_path: Path,
) -> None:
    run = _run()
    snapshot, ids = _validation_snapshot(run, rollout_uid="recreated-uid")
    repository = _Repository(run, snapshot)
    validator = _Validator()
    model = _ToolCallingModel(responses=[_diagnosis_response(run, ids)])

    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(
            _dependencies(saver, repository, model, validator),
            run,
            REPAIR_POLICY,
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            _config(run),
            context=_context(run),
            durability="sync",
        )

    assert validator.calls == []
    [terminal] = repository.repair_terminals
    assert terminal.proposal is None
    assert terminal.validation is None
    assert terminal.error_code == "repair_policy_denied"


@pytest.mark.asyncio
async def test_no_repair_candidate_keeps_diagnosed_terminal(
    tmp_path: Path,
) -> None:
    run = _run()
    snapshot, ids = _validation_snapshot(run)
    repository = _Repository(run, snapshot)
    validator = _Validator()
    model = _ToolCallingModel(
        responses=[_diagnosis_response(run, ids, include_repair=False)]
    )

    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(
            _dependencies(saver, repository, model, validator),
            run,
            REPAIR_POLICY,
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            _config(run),
            context=_context(run),
            durability="sync",
        )

    assert validator.calls == []
    assert repository.repair_terminals == []
    [terminal] = repository.terminals
    assert terminal.outcome is not None
    assert terminal.outcome.value == "diagnosed"
    assert terminal.error_code is None
