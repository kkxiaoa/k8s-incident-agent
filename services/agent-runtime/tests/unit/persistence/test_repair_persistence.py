from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import event, func, select
from sqlalchemy.exc import OperationalError
from tests.factories import normalized_trigger

from k8s_incident_agent.diagnosis.contracts import ValidatedDiagnosis
from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    IncidentStatus,
    ModelSnapshot,
    RunBudget,
    RunStatus,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import (
    DiagnosisRow,
    RepairProposalRow,
    RunEventRow,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PersistenceOperationError,
)
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationResponse,
)
from k8s_incident_agent.repair.records import RepairTerminalRecord
from k8s_incident_agent.runtime.paths import RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 9, 7, 9, 0, tzinfo=UTC)
MODEL = ModelSnapshot(
    provider="deepseek",
    model_id="deepseek-v4-flash",
    thinking_mode=False,
    prompt_version="stage2-repair-v1",
)
BUDGET = RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


@asynccontextmanager
async def _database(tmp_path: Path) -> AsyncGenerator[BusinessDatabase]:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        yield database
    finally:
        await database.dispose()


async def prepared_repair_record(
    repository: IncidentRepository,
    *,
    outcome: str = "passed",
    error_code: str | None = None,
    error_retryable: bool | None = None,
    include_proposal: bool = True,
) -> tuple[UUID, UUID, RepairTerminalRecord]:
    created = await repository.create_incident_and_run(
        normalized_trigger(),
        MODEL,
        BUDGET,
    )
    await repository.start_run(created.run_id, NOW)
    evidence_ids: list[UUID] = []
    for index, kind in enumerate(("workload", "rollout_history"), start=1):
        call_id = f"call-{index}"
        await repository.record_tool_started(created.run_id, call_id, f"get_{kind}")
        persisted = await repository.record_evidence(
            EvidenceRecord(
                run_id=created.run_id,
                tool_call_id=call_id,
                tool_name=f"get_{kind}",
                evidence_kind=kind,
                target_ref={"kind": "Deployment"},
                observed_at=NOW,
                payload={"index": index},
                truncated=False,
                redacted=False,
            )
        )
        evidence_ids.append(persisted.id)
    target = normalized_trigger().target
    diagnosis = ValidatedDiagnosis.model_validate(
        {
            "outcome": "diagnosed",
            "summary": "The configured image is unavailable.",
            "root_causes": [
                {
                    "code": "image_invalid_registry",
                    "statement": "The current image uses a reserved registry.",
                    "confidence": "high",
                    "evidence_ids": [str(value) for value in evidence_ids],
                }
            ],
            "missing_information": [],
            "recommendations": [
                {
                    "action": "确认上一版本镜像仍可拉取后再批准修复",
                    "purpose": "避免回到同样不可用的镜像",
                    "preconditions": "rollout 历史中记录了上一版本镜像",
                    "risk": "上一版本同样有问题时修复不能恢复",
                    "verification": "观察镜像拉取失败 Pod 数是否回到 0",
                    "evidence_ids": [str(value) for value in evidence_ids],
                }
            ],
            "repair_intent": {
                "action": "set_container_image",
                "target": target.model_dump(mode="json"),
                "container_name": "workload",
                "replacement_image": "registry.k8s.io/agnhost:2.53",
                "evidence_ids": [str(value) for value in evidence_ids],
            },
            "redacted": False,
        }
    )
    proposal = None
    validation = None
    if include_proposal:
        proposal = compile_repair_proposal(
            EvidenceBoundImageChange(
                run_id=created.run_id,
                action="set_container_image",
                target=target,
                target_uid="deployment-uid",
                target_resource_version="42",
                container_index=0,
                container_name="workload",
                current_image="registry.invalid/workload:v2",
                replacement_image="registry.k8s.io/agnhost:2.53",
                evidence_ids=sorted(evidence_ids, key=str),
            ),
            schema_checked_at=NOW + timedelta(seconds=1),
            policy_checked_at=NOW + timedelta(seconds=2),
            diff_checked_at=NOW + timedelta(seconds=3),
        )
        validation = PatchValidationResponse.model_validate(
            {
                "proposal_id": proposal.id,
                "run_id": created.run_id,
                "proposal_digest": proposal.digest,
                "outcome": outcome,
                "checked_at": NOW + timedelta(seconds=4),
                "error": (
                    None
                    if outcome == "passed"
                    else {"code": error_code, "retryable": error_retryable}
                ),
            }
        )
    terminal = RepairTerminalRecord(
        run_id=created.run_id,
        diagnosis_completed_at=NOW + timedelta(milliseconds=500),
        completed_at=NOW + timedelta(seconds=5),
        diagnosis=diagnosis,
        proposal=proposal,
        validation=validation,
        error_code=error_code,
        error_retryable=error_retryable,
        model_calls=2,
        tool_calls=3,
    )
    return created.incident_id, created.run_id, terminal


@pytest.mark.asyncio
async def test_repair_success_is_atomic_replayable_and_projected(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, run_id, terminal = await prepared_repair_record(repository)

        first = await repository.persist_repair_terminal(terminal)
        replay = await repository.persist_repair_terminal(terminal)
        detail = await repository.get_incident_detail(
            incident_id,
            run_id=run_id,
            event_limit=100,
        )

        assert replay == first
        assert first.incident_status is IncidentStatus.WAITING_APPROVAL
        assert first.run_status is RunStatus.COMPLETED
        assert detail is not None
        assert detail.incident.status is IncidentStatus.WAITING_APPROVAL
        assert detail.run.status is RunStatus.COMPLETED
        assert detail.diagnosis is not None
        # A repair Run keeps the recommendations of the same diagnosis; NULL
        # stays reserved for Runs recorded before the column existed.
        assert detail.diagnosis.recommendations is not None
        [recommendation] = detail.diagnosis.recommendations
        assert recommendation.action == "确认上一版本镜像仍可拉取后再批准修复"
        assert detail.repair is not None
        assert detail.repair.proposal == terminal.proposal
        assert detail.repair.validation == terminal.validation
        repair_events = [
            item.event_type
            for item in reversed(detail.events)
            if item.event_key
            in {
                "diagnosis.completed",
                "repair.patch_ready",
                "repair.dry_run_passed",
                "run:terminal",
            }
        ]
        assert repair_events == [
            "diagnosis.completed",
            "repair.patch_ready",
            "repair.dry_run_passed",
            "repair.waiting_approval",
        ]


@pytest.mark.asyncio
async def test_historical_repair_run_remains_readable_after_rerun_starts(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, run_id, terminal = await prepared_repair_record(repository)
        await repository.persist_repair_terminal(terminal)
        rerun = await repository.create_run(incident_id, MODEL, BUDGET)
        assert rerun is not None
        await repository.start_run(rerun.run_id, NOW + timedelta(seconds=10))

        historical = await repository.get_incident_detail(
            incident_id,
            run_id=run_id,
            event_limit=100,
        )
        history = await repository.list_run_records(
            incident_id,
            limit=10,
            before_attempt=None,
        )
        replay = await repository.persist_repair_terminal(terminal)

        assert historical is not None
        assert historical.incident.status is IncidentStatus.TRIAGING
        assert historical.run.id == run_id
        assert historical.repair is not None
        assert history is not None
        assert [item.status for item in history.items] == [
            RunStatus.RUNNING,
            RunStatus.COMPLETED,
        ]
        assert replay.run_id == run_id


@pytest.mark.asyncio
async def test_stale_dry_run_keeps_diagnosis_and_failed_validation(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, run_id, terminal = await prepared_repair_record(
            repository,
            outcome="failed",
            error_code="stale_resource",
            error_retryable=False,
        )

        persisted = await repository.persist_repair_terminal(terminal)
        detail = await repository.get_incident_detail(
            incident_id,
            run_id=run_id,
            event_limit=100,
        )

        assert persisted.incident_status is IncidentStatus.STALE_RESOURCE
        assert persisted.run_status is RunStatus.FAILED
        assert detail is not None
        assert detail.diagnosis is not None
        assert detail.repair is not None
        assert detail.repair.validation.error is not None
        assert detail.repair.validation.error.code == "stale_resource"
        assert detail.events[0].event_type == "run.failed"


@pytest.mark.asyncio
async def test_policy_failure_persists_diagnosis_without_a_proposal(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, run_id, terminal = await prepared_repair_record(
            repository,
            error_code="repair_policy_denied",
            error_retryable=False,
            include_proposal=False,
        )

        await repository.persist_repair_terminal(terminal)
        detail = await repository.get_incident_detail(
            incident_id,
            run_id=run_id,
            event_limit=100,
        )

        assert detail is not None
        assert detail.incident.status is IncidentStatus.FAILED
        assert detail.diagnosis is not None
        assert detail.repair is None
        assert [
            item.event_type
            for item in reversed(detail.events)
            if item.event_key in {"diagnosis.completed", "run:terminal"}
        ] == [
            "diagnosis.completed",
            "run.failed",
        ]


@pytest.mark.asyncio
async def test_repair_projection_insert_failure_rolls_back_everything(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, run_id, terminal = await prepared_repair_record(repository)

        def fail_insert(_mapper: object, _connection: object, _target: object) -> None:
            raise OperationalError("insert", {}, RuntimeError("sensitive"))

        event.listen(RepairProposalRow, "before_insert", fail_insert)
        try:
            with pytest.raises(PersistenceOperationError):
                await repository.persist_repair_terminal(terminal)
        finally:
            event.remove(RepairProposalRow, "before_insert", fail_insert)

        snapshot = await repository.get_workflow_run_snapshot(run_id)
        assert snapshot.run_status is RunStatus.RUNNING
        assert snapshot.incident_id == incident_id
        async with database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(DiagnosisRow))
                == 0
            )
            assert (
                await session.scalar(
                    select(func.count()).select_from(RepairProposalRow)
                )
                == 0
            )
            assert (
                await session.scalar(
                    select(func.count())
                    .select_from(RunEventRow)
                    .where(RunEventRow.event_key == "run:terminal")
                )
                == 0
            )
