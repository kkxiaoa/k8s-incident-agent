from __future__ import annotations

import json
import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    NOW,
    prepared_repair_record,
)
from tests.unit.repair.test_repair_preparation import (
    FRESH_NOW,
    KubernetesFixture,
    ValidatorFixture,
    create_preparation,
    credential,
    seed_source,
)

from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.application.scheduling import RunScheduler
from k8s_incident_agent.domain.models import (
    RepairOperation,
    RepairWorkflowRunSnapshot,
    RunKind,
    RunStatus,
)
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredentialLease
from k8s_incident_agent.persistence.database import create_business_database
from k8s_incident_agent.persistence.models import (
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    ActiveRunExistsError,
    IncidentRepository,
)
from k8s_incident_agent.repair.client import PatchValidator
from k8s_incident_agent.repair.preparation import prepare_repair
from k8s_incident_agent.runtime.paths import RuntimePaths

TABLES = (
    "incidents",
    "agent_runs",
    "run_events",
    "evidence",
    "diagnoses",
    "repair_proposals",
)


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(Path(__file__).resolve().parents[3] / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


def _application(repository: IncidentRepository) -> IncidentApplicationService:
    return IncidentApplicationService(
        catalog=(),
        repository=repository,
        supervisor=cast(RunScheduler, object()),
        credential=cast(DiagnosticCredentialLease, object()),
        model=lambda: None,
        budget=BUDGET,
        now=lambda: NOW,
    )


def _rows(paths: RuntimePaths) -> dict[str, list[dict[str, Any]]]:
    with sqlite3.connect(paths.business_database) as connection:
        connection.row_factory = sqlite3.Row
        return {
            table: [
                dict(row)
                for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY id')
            ]
            for table in TABLES
        }


def _dump(paths: RuntimePaths) -> str:
    with sqlite3.connect(paths.business_database) as connection:
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        return "\n".join(connection.iterdump())


async def _legacy_database(tmp_path: Path) -> tuple[RuntimePaths, UUID, UUID]:
    # Capture real repository/compiler output; explicitly encode it in the old
    # revision's schema, independently of the new downgrade implementation.
    capture = RuntimePaths.prepare(tmp_path / "capture")
    command.upgrade(_alembic_config(capture), "head")
    database = await create_business_database(capture)
    try:
        repository = IncidentRepository(database.session_factory)
        incident_id, run_id, terminal = await prepared_repair_record(repository)
        await repository.persist_repair_terminal(terminal)
    finally:
        await database.dispose()
    captured = _rows(capture)
    paths = RuntimePaths.prepare(tmp_path / "legacy")
    command.upgrade(_alembic_config(paths), "20260907_0005")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        for table in TABLES:
            columns = [
                row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')
            ]
            for row in captured[table]:
                if table == "run_events":
                    payload = json.loads(row["payload_json"])
                    payload.pop("runKind")
                    payload["schemaVersion"] = 4
                    row["schema_version"] = 4
                    row["payload_json"] = json.dumps(
                        payload,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                connection.execute(
                    f'INSERT INTO "{table}" ({", ".join(columns)}) VALUES ({", ".join("?" for _ in columns)})',
                    [row[column] for column in columns],
                )
    return paths, incident_id, run_id


async def test_nonempty_upgrade_retains_owners_proposal_evidence_and_legacy_terminal(
    tmp_path: Path,
) -> None:
    paths, incident_id, run_id = await _legacy_database(tmp_path)
    before = _rows(paths)
    command.upgrade(_alembic_config(paths), "head")
    after = _rows(paths)
    for row in after["agent_runs"]:
        assert row.pop("kind") == "diagnosis"
        assert row.pop("operation") is None
        for column in (
            "source_run_id",
            "request_source",
            "operator_ref",
            "selection_revision",
            "selection_replica_set_uid",
            "waiting_expires_at",
            "end_reason",
        ):
            assert row.pop(column) is None
    for row in after["run_events"]:
        assert row["schema_version"] == 5
        payload = json.loads(row["payload_json"])
        assert payload.pop("runKind") == "diagnosis"
        payload["schemaVersion"] = 4
        row["schema_version"] = 4
        row["payload_json"] = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    assert after == before
    database = await create_business_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        detail = await repository.get_incident_detail(
            incident_id, run_id=run_id, event_limit=100
        )
        assert detail is not None
        wire = (
            await _application(repository).get_incident(incident_id, run_id=run_id)
        ).model_dump(mode="json")
        assert wire["selectedRun"]["kind"] == "diagnosis"
        assert wire["selectedRun"]["status"] == "COMPLETED"
        assert wire["incident"]["status"] == "WAITING_APPROVAL"
        assert wire["diagnosis"] is not None and wire["repair"] is not None
        assert wire["eventPage"]["items"][0]["event"] == "repair.waiting_approval"
        assert wire["eventPage"]["items"][0]["data"]["runStatus"] == "COMPLETED"
        assert await repository.list_recoverable_run_ids() == ()
    finally:
        await database.dispose()
    command.downgrade(_alembic_config(paths), "20260907_0005")
    assert _rows(paths) == before


@pytest.mark.parametrize("corruption", ["QUEUED", "RUNNING", "json", "owner", "schema"])
async def test_incompatible_legacy_data_fails_before_mutation(
    tmp_path: Path, corruption: str
) -> None:
    paths, _, _ = await _legacy_database(tmp_path)
    with sqlite3.connect(paths.business_database) as connection:
        if corruption in ("QUEUED", "RUNNING"):
            connection.execute("UPDATE agent_runs SET status=?", (corruption,))
        elif corruption == "json":
            connection.execute("UPDATE run_events SET payload_json='{' WHERE id=1")
        elif corruption == "owner":
            connection.execute(
                "UPDATE run_events SET payload_json=json_set(payload_json, '$.runId', ?) WHERE id=1",
                (str(uuid4()),),
            )
        else:
            connection.execute("UPDATE run_events SET schema_version=3 WHERE id=1")
    before = _dump(paths)
    with pytest.raises(
        RuntimeError, match=r"Drain active|valid JSON|schema or ownership"
    ):
        command.upgrade(_alembic_config(paths), "head")
    assert _dump(paths) == before


async def test_failed_restore_rolls_back_table_rebuild_children_and_revision(
    tmp_path: Path,
) -> None:
    paths, _, _ = await _legacy_database(tmp_path)
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "CREATE TRIGGER fail_event_restore BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END"
        )
    before = _dump(paths)
    from sqlalchemy.exc import IntegrityError

    with pytest.raises(IntegrityError, match="injected restore failure"):
        command.upgrade(_alembic_config(paths), "head")
    assert _dump(paths) == before


def _repair_row(
    incident_id: UUID, status: RunStatus = RunStatus.WAITING_APPROVAL
) -> RunRow:
    return RunRow(
        id=str(uuid4()),
        incident_id=str(incident_id),
        attempt=2,
        kind=RunKind.REPAIR,
        operation=RepairOperation.APPLY,
        status=status,
        model_provider=None,
        model_id=None,
        thinking_mode=None,
        prompt_version=None,
        max_model_calls=None,
        max_tool_calls=None,
        timeout_seconds=60,
        model_calls=None,
        tool_calls=None,
        input_tokens=None,
        output_tokens=None,
        error_code=None,
        error_retryable=None,
        created_at=NOW,
        started_at=None if status is RunStatus.QUEUED else NOW,
        completed_at=None,
        updated_at=NOW,
    )


@pytest.mark.parametrize(
    "status", [RunStatus.QUEUED, RunStatus.RUNNING, RunStatus.WAITING_APPROVAL]
)
async def test_repair_active_run_blocks_unbound_rerun_and_retention_but_is_recoverable(
    tmp_path: Path, status: RunStatus
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        created = await repository.create_repair_run(
            incident_id,
            source_id,
            selection=None,
            replaces_run_id=None,
            operator_ref="sandbox-operator",
            now=FRESH_NOW,
        )
        assert created is not None
        if status is not RunStatus.QUEUED:
            await repository.start_run(created.run_id, FRESH_NOW)
        if status is RunStatus.WAITING_APPROVAL:
            running = await repository.get_workflow_run_snapshot(created.run_id)
            assert isinstance(running, RepairWorkflowRunSnapshot)
            await repository.persist_prepared_repair(
                await prepare_repair(
                    running,
                    repository=repository,
                    adapter=KubernetesFixture().adapter(),
                    credential=credential(),
                    validator=cast(PatchValidator, ValidatorFixture()),
                    now=lambda: FRESH_NOW,
                )
            )
        snapshot = await repository.get_workflow_run_snapshot(created.run_id)
        assert isinstance(snapshot, RepairWorkflowRunSnapshot)
        assert snapshot.operation is RepairOperation.APPLY
        assert not hasattr(snapshot, "model") and not hasattr(snapshot, "budget")
        assert await repository.list_recoverable_run_ids() == (created.run_id,)
        assert (
            await repository.list_prune_targets(
                NOW + timedelta(days=365), paths.run_artifacts
            )
            == ()
        )
        with pytest.raises(ActiveRunExistsError):
            await repository.create_run(incident_id, MODEL, BUDGET)
        async with database.session_factory() as session:
            stored = await session.scalar(
                select(RunRow).where(RunRow.id == str(created.run_id))
            )
            assert stored is not None and stored.status is status
        detail = await repository.get_incident_detail(
            incident_id, run_id=created.run_id, event_limit=100
        )
        assert detail is not None
        wire = (
            await _application(repository).get_incident(
                incident_id, run_id=created.run_id
            )
        ).model_dump(mode="json")
        assert wire["selectedRun"]["kind"] == "repair"
        assert wire["selectedRun"]["operation"] == "apply"
        assert wire["selectedRun"]["completedAt"] is None
        assert wire["diagnosis"] is None
    finally:
        await database.dispose()
    before = _dump(paths)
    with pytest.raises(RuntimeError, match="would discard request facts"):
        command.downgrade(_alembic_config(paths), "20260907_0005")
    assert _dump(paths) == before


@pytest.mark.parametrize(
    "change",
    [
        "operation=NULL",
        "operation='other'",
        "model_id='fake-model'",
        "model_calls=0",
        "input_tokens=0",
        "kind='diagnosis'",
        "kind='other'",
    ],
)
async def test_database_rejects_fake_repair_model_usage_and_invalid_kind_fields(
    tmp_path: Path, change: str
) -> None:
    paths, incident_id, _ = await _legacy_database(tmp_path)
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        repair = _repair_row(incident_id)
        async with database.session_factory() as session, session.begin():
            session.add(repair)
    finally:
        await database.dispose()
    with sqlite3.connect(paths.business_database) as connection:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                f"UPDATE agent_runs SET {change} WHERE id=?", (repair.id,)
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE agent_runs SET status='WAITING_APPROVAL' WHERE kind='diagnosis'"
            )


async def test_repair_waiting_reads_its_own_proposal_events_and_evidence_without_legacy_diagnosis(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        incident_id, diagnostic_id = await seed_source(repository)
        application = _application(repository)
        legacy = await application.get_incident(incident_id, run_id=diagnostic_id)
        assert legacy.repair is not None
        run = await create_preparation(repository, incident_id, diagnostic_id)
        await repository.persist_prepared_repair(
            await prepare_repair(
                run,
                repository=repository,
                adapter=KubernetesFixture().adapter(),
                credential=credential(),
                validator=cast(PatchValidator, ValidatorFixture()),
                now=lambda: FRESH_NOW,
            )
        )
        detail = await application.get_incident(incident_id, run_id=run.id)
        assert detail.diagnosis is None and detail.repair is not None
        assert detail.repair.id != legacy.repair.id
        assert len(detail.evidence) == 4
        assert set(detail.repair.evidence_ids) == {
            row.id
            for row in detail.evidence
            if row.evidence_kind in ("workload", "rollout_history")
        }
        assert {row.id for row in detail.evidence}.isdisjoint(
            row.id for row in legacy.evidence
        )
        assert detail.selected_run.kind is RunKind.REPAIR
        assert detail.selected_run.source_run_id == diagnostic_id
        assert detail.selected_run.waiting_expires_at == FRESH_NOW + timedelta(
            minutes=15
        )
        events = await application.list_run_events(
            incident_id, run.id, limit=100, cursor=None
        )
        waiting = [
            item
            for item in events.items
            if item.root.event == "repair.waiting_approval"
        ]
        assert len(waiting) == 1
        assert (
            waiting[0].root.data.model_dump(mode="json")["runStatus"]
            == "WAITING_APPROVAL"
        )
        history = await application.list_runs(incident_id, limit=50, cursor=None)
        assert [(run.kind, run.status) for run in history.items] == [
            (RunKind.REPAIR, RunStatus.WAITING_APPROVAL),
            (RunKind.DIAGNOSIS, RunStatus.COMPLETED),
        ]
        retained = await application.get_incident(incident_id, run_id=diagnostic_id)
        assert retained.selected_run == legacy.selected_run
        assert retained.diagnosis == legacy.diagnosis
        assert retained.repair == legacy.repair
        assert retained.evidence == legacy.evidence
        assert retained.event_page == legacy.event_page
    finally:
        await database.dispose()
