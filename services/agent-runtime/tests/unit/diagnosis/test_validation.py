from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from tests.factories import normalized_trigger

from k8s_incident_agent.diagnosis.contracts import (
    DiagnosisCandidate,
    Recommendation,
)
from k8s_incident_agent.diagnosis.validation import (
    DiagnosisValidationError,
    RepairIntentUnsupportedError,
    UnresolvedToolFailuresError,
    validate_diagnosis,
)
from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    JsonValue,
    ModelSnapshot,
    RunBudget,
    ToolFailureRecord,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import RunEventRow
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PersistenceOperationError,
    RecoveryConsistencyError,
)
from k8s_incident_agent.repair.contracts import SetContainerImageIntent
from k8s_incident_agent.runtime.paths import RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 23, 9, 0, tzinfo=UTC)
MODEL = ModelSnapshot(
    provider="deepseek",
    model_id="deepseek-v4-flash",
    thinking_mode=False,
    prompt_version="stage1-v1",
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


def _scenario(name: str):
    return normalized_trigger(name)


async def _running_run(repository: IncidentRepository, name: str) -> UUID:
    created = await repository.create_incident_and_run(_scenario(name), MODEL, BUDGET)
    await repository.start_run(created.run_id, NOW)
    return created.run_id


async def _record_evidence(
    repository: IncidentRepository,
    run_id: UUID,
    *,
    tool_call_id: str,
    tool_name: str,
    payload: dict[str, JsonValue] | None = None,
) -> UUID:
    await repository.record_tool_started(run_id, tool_call_id, tool_name)
    persisted = await repository.record_evidence(
        _evidence_record(
            run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            payload=payload,
        )
    )
    return persisted.id


def _evidence_record(
    run_id: UUID,
    *,
    tool_call_id: str,
    tool_name: str,
    payload: dict[str, JsonValue] | None = None,
) -> EvidenceRecord:
    return EvidenceRecord(
        run_id=run_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        evidence_kind=tool_name.removeprefix("get_"),
        target_ref={"name": "deployment-a"},
        observed_at=NOW,
        payload={"observed": True} if payload is None else payload,
        truncated=False,
        redacted=False,
    )


def _container_logs_payload(
    *,
    message: str | None,
    include_container: bool = True,
) -> dict[str, JsonValue]:
    containers: list[JsonValue] = []
    if include_container:
        previous: dict[str, JsonValue]
        if message is None:
            previous = {
                "source": "previous",
                "status": "previous_unavailable",
                "lines": [],
            }
        else:
            previous = {
                "source": "previous",
                "status": "available",
                "lines": [{"timestamp": NOW.isoformat(), "message": message}],
            }
        containers.append(
            {
                "podRef": {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "namespace": "default",
                    "name": "pod-a",
                    "uid": "pod-uid",
                },
                "owner": {
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "name": "deployment-a",
                    "uid": "deployment-uid",
                    "controller": True,
                },
                "container": "app",
                "restartCount": 3,
                "snapshots": [
                    {
                        "source": "current",
                        "status": "no_logs_in_window",
                        "lines": [],
                    },
                    previous,
                ],
            }
        )
    return {
        "sourceWorkload": {
            "resourceVersion": "17",
            "selector": {"matchLabels": {"app": "crash-loop"}},
        },
        "containers": containers,
    }


def _image_pull_payloads(image: str) -> dict[str, dict[str, JsonValue]]:
    source_workload: dict[str, JsonValue] = {
        "resourceVersion": "17",
        "selector": {"matchLabels": {"app": "image-pull"}},
    }
    return {
        "get_workload": {
            "workload": {
                "resourceVersion": "17",
                "generation": 1,
                "observedGeneration": 1,
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
                        "image": image,
                        "imagePullPolicy": "Always",
                        "command": [],
                        "args": [],
                        "probes": [],
                    }
                ],
                "conditions": [],
            }
        },
        "get_pods": {
            "sourceWorkload": source_workload,
            "pods": [
                {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "namespace": "k8s-incident-scenarios",
                    "name": "image-pull-pod",
                    "uid": "pod-uid",
                    "resourceVersion": "18",
                    "owner": {
                        "apiVersion": "apps/v1",
                        "kind": "ReplicaSet",
                        "name": "image-pull-rs",
                        "uid": "rs-uid",
                        "controller": True,
                    },
                    "phase": "Pending",
                    "conditions": [],
                    "containers": [
                        {
                            "name": "workload",
                            "image": image,
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
        "get_events": {
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
                    "resourceVersion": "19",
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
    }


def _diagnosed_with_evidence(
    evidence_ids: tuple[UUID, ...],
    *,
    code: str,
) -> DiagnosisCandidate:
    candidate = _diagnosed(evidence_ids[0], code=code)
    return candidate.model_copy(
        update={
            "root_causes": [
                candidate.root_causes[0].model_copy(
                    update={"evidence_ids": list(evidence_ids)}
                )
            ]
        }
    )


async def _record_failure(
    repository: IncidentRepository,
    run_id: UUID,
    *,
    tool_call_id: str,
    tool_name: str,
    error_code: str,
    retryable: bool,
    occurred_at: datetime = NOW,
) -> None:
    await repository.record_tool_started(run_id, tool_call_id, tool_name)
    await repository.record_tool_failure(
        ToolFailureRecord(
            run_id=run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            error_code=error_code,
            retryable=retryable,
            occurred_at=occurred_at,
        )
    )


def _diagnosed(
    evidence_id: UUID,
    *,
    code: str = "observed_runtime_failure",
    summary: str = "The observations support a diagnosis.",
    statement: str = "The cited evidence identifies the failure.",
) -> DiagnosisCandidate:
    return DiagnosisCandidate.model_validate(
        {
            "outcome": "diagnosed",
            "summary": summary,
            "root_causes": [
                {
                    "code": code,
                    "statement": statement,
                    "confidence": "high",
                    "evidence_ids": [str(evidence_id)],
                }
            ],
            "missing_information": [],
        }
    )


def _insufficient(
    *,
    summary: str = "The available observations are insufficient.",
    missing: str = "A successful observation is still required.",
) -> DiagnosisCandidate:
    return DiagnosisCandidate.model_validate(
        {
            "outcome": "insufficient_evidence",
            "summary": summary,
            "root_causes": [],
            "missing_information": [missing],
        }
    )


def _recommendation(
    evidence_id: UUID, *, action: str = "重新拉取镜像前先确认上一版本"
) -> dict[str, object]:
    return {
        "action": action,
        "purpose": "在不改动集群的前提下判断下一步",
        "preconditions": "确认上一版本镜像仍可拉取",
        "risk": "上一版本同样有问题时无法恢复",
        "verification": "观察失败 Pod 数是否回到 0",
        "evidence_ids": [str(evidence_id)],
    }


def _text_that_expands_during_redaction(max_code_points: int) -> str:
    suffix = " token=a"
    return "x" * (max_code_points - len(suffix)) + suffix


@pytest.mark.asyncio
async def test_validator_sanitizes_model_text_and_preserves_model_code(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "valid-diagnosis")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-pods",
            tool_name="get_pods",
        )
        candidate = _diagnosed(
            evidence_id,
            code="registry_observation",
            summary="Observed state\x00 api_key=provider-secret",
            statement="Authorization: Bearer opaque-secret",
        )

        validated = await validate_diagnosis(
            candidate, run_id, repository, required_evidence=frozenset()
        )

        serialized = validated.model_dump_json()
        assert validated.redacted is True
        assert validated.root_causes[0].code == "registry_observation"
        assert "provider-secret" not in serialized
        assert "opaque-secret" not in serialized
        assert "[REDACTED]" in serialized


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model_code",
    ["image_pull_forbidden", "image_reference_unavailable_or_unauthenticated"],
)
async def test_validator_canonicalizes_reserved_invalid_registry_failure(
    tmp_path: Path,
    model_code: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"invalid-registry-{model_code}")
        evidence_ids: list[UUID] = []
        for tool_name, payload in _image_pull_payloads(
            "registry.invalid/k8s-incident-agent/missing:v1"
        ).items():
            evidence_ids.append(
                await _record_evidence(
                    repository,
                    run_id,
                    tool_call_id=f"call-{tool_name}",
                    tool_name=tool_name,
                    payload=payload,
                )
            )

        validated = await validate_diagnosis(
            _diagnosed_with_evidence(tuple(evidence_ids), code=model_code),
            run_id,
            repository,
            required_evidence=frozenset({"workload", "pods", "events"}),
        )

        assert validated.root_causes[0].code == "image_invalid_registry"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "image",
    [
        "registry.example.com/private/workload:v1",
        "invalid/private/workload:v1",
    ],
)
async def test_validator_preserves_credentials_code_for_regular_registry(
    tmp_path: Path,
    image: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "registry-credentials")
        evidence_ids: list[UUID] = []
        for tool_name, payload in _image_pull_payloads(image).items():
            evidence_ids.append(
                await _record_evidence(
                    repository,
                    run_id,
                    tool_call_id=f"call-{tool_name}",
                    tool_name=tool_name,
                    payload=payload,
                )
            )

        validated = await validate_diagnosis(
            _diagnosed_with_evidence(
                tuple(evidence_ids),
                code="image_registry_credentials_failure",
            ),
            run_id,
            repository,
            required_evidence=frozenset({"workload", "pods", "events"}),
        )

        assert validated.root_causes[0].code == "image_registry_credentials_failure"


@pytest.mark.asyncio
async def test_insufficient_evidence_requires_a_successful_observation(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "insufficient-without-evidence")

        with pytest.raises(DiagnosisValidationError) as error:
            await validate_diagnosis(
                _insufficient(), run_id, repository, required_evidence=frozenset()
            )

        assert error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "max_code_points"),
    [("summary", 1024), ("statement", 1024), ("missing_information", 512)],
)
async def test_validator_rejects_text_truncated_after_redaction(
    tmp_path: Path,
    field: str,
    max_code_points: int,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"truncated-{field}")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-events",
            tool_name="get_events",
        )
        value = _text_that_expands_during_redaction(max_code_points)
        if field == "summary":
            candidate = _diagnosed(evidence_id, summary=value)
        elif field == "statement":
            candidate = _diagnosed(evidence_id, statement=value)
        else:
            candidate = _insufficient(missing=value)

        with pytest.raises(DiagnosisValidationError) as error:
            await validate_diagnosis(
                candidate, run_id, repository, required_evidence=frozenset()
            )

        assert error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize("reference_kind", ["unknown", "cross_run"])
async def test_diagnosed_rejects_evidence_outside_the_current_run(
    tmp_path: Path,
    reference_kind: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        current_run = await _running_run(repository, f"current-{reference_kind}")
        await _record_evidence(
            repository,
            current_run,
            tool_call_id="call-current",
            tool_name="get_workload",
        )
        if reference_kind == "cross_run":
            other_run = await _running_run(repository, "foreign-evidence")
            referenced = await _record_evidence(
                repository,
                other_run,
                tool_call_id="call-foreign",
                tool_name="get_pods",
            )
        else:
            referenced = uuid4()

        with pytest.raises(DiagnosisValidationError) as error:
            await validate_diagnosis(
                _diagnosed(referenced),
                current_run,
                repository,
                required_evidence=frozenset(),
            )

        assert error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
async def test_diagnosed_requires_evidence_and_rejects_unknown_code(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        empty_run = await _running_run(repository, "empty-run")

        with pytest.raises(DiagnosisValidationError):
            await validate_diagnosis(
                _diagnosed(uuid4()),
                empty_run,
                repository,
                required_evidence=frozenset(),
            )

        evidence_id = await _record_evidence(
            repository,
            empty_run,
            tool_call_id="call-workload",
            tool_name="get_workload",
        )
        with pytest.raises(DiagnosisValidationError):
            await validate_diagnosis(
                _diagnosed(evidence_id, code="unknown"),
                empty_run,
                repository,
                required_evidence=frozenset(),
            )


@pytest.mark.asyncio
async def test_diagnosed_must_cite_each_required_evidence_kind(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "required-evidence")
        workload_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-workload",
            tool_name="get_workload",
        )
        await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-pods",
            tool_name="get_pods",
        )

        with pytest.raises(DiagnosisValidationError):
            await validate_diagnosis(
                _diagnosed(workload_id),
                run_id,
                repository,
                required_evidence=frozenset({"workload", "pods"}),
            )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("message", "include_container"),
    [(None, False), (None, True), ("", True)],
)
async def test_diagnosed_rejects_container_logs_without_usable_messages(
    tmp_path: Path,
    message: str | None,
    include_container: bool,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "empty-container-logs")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-container-logs",
            tool_name="get_container_logs",
            payload=_container_logs_payload(
                message=message,
                include_container=include_container,
            ),
        )

        with pytest.raises(DiagnosisValidationError):
            await validate_diagnosis(
                _diagnosed(evidence_id, code="invalid_startup_arguments"),
                run_id,
                repository,
                required_evidence=frozenset({"container_logs"}),
            )


@pytest.mark.asyncio
async def test_diagnosed_accepts_cited_container_logs_with_a_usable_message(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "usable-container-logs")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-container-logs",
            tool_name="get_container_logs",
            payload=_container_logs_payload(message="unknown command: invalid"),
        )

        validated = await validate_diagnosis(
            _diagnosed(evidence_id, code="invalid_startup_arguments"),
            run_id,
            repository,
            required_evidence=frozenset({"container_logs"}),
        )

        assert validated.outcome == "diagnosed"


@pytest.mark.asyncio
async def test_retryable_failure_is_resolved_only_by_later_same_tool_success(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)

        unresolved_run = await _running_run(repository, "unresolved-retry")
        await _record_failure(
            repository,
            unresolved_run,
            tool_call_id="call-timeout",
            tool_name="get_events",
            error_code="request_timeout",
            retryable=True,
        )
        alternate_evidence_id = await _record_evidence(
            repository,
            unresolved_run,
            tool_call_id="call-other-tool",
            tool_name="get_pods",
        )
        with pytest.raises(UnresolvedToolFailuresError) as unresolved:
            await validate_diagnosis(
                _insufficient(),
                unresolved_run,
                repository,
                required_evidence=frozenset(),
            )
        assert [failure.tool_call_id for failure in unresolved.value.failures] == [
            "call-timeout"
        ]
        diagnosed = await validate_diagnosis(
            _diagnosed(alternate_evidence_id),
            unresolved_run,
            repository,
            required_evidence=frozenset(),
        )
        assert diagnosed.outcome == "diagnosed"

        resolved_run = await _running_run(repository, "resolved-retry")
        await _record_failure(
            repository,
            resolved_run,
            tool_call_id="call-timeout",
            tool_name="get_events",
            error_code="request_timeout",
            retryable=True,
            occurred_at=datetime(2099, 1, 1, tzinfo=UTC),
        )
        await _record_evidence(
            repository,
            resolved_run,
            tool_call_id="call-retry",
            tool_name="get_events",
        )

        validated = await validate_diagnosis(
            _insufficient(),
            resolved_run,
            repository,
            required_evidence=frozenset(),
        )
        assert validated.outcome == "insufficient_evidence"


@pytest.mark.asyncio
async def test_fatal_failure_remains_unresolved_after_later_success(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "fatal-failure")
        await _record_failure(
            repository,
            run_id,
            tool_call_id="call-denied",
            tool_name="get_workload",
            error_code="permission_denied",
            retryable=False,
        )
        await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-later",
            tool_name="get_workload",
        )

        with pytest.raises(UnresolvedToolFailuresError) as error:
            await validate_diagnosis(
                _insufficient(), run_id, repository, required_evidence=frozenset()
            )

        assert error.value.failures[0].error_code == "permission_denied"
        assert error.value.failures[0].retryable is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error_code", "retryable"),
    [("not_a_kubernetes_code", True), ("permission_denied", True)],
)
async def test_resolved_invalid_tool_failure_contract_fails_consistency(
    tmp_path: Path,
    error_code: str,
    retryable: bool,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"invalid-{error_code}")
        await _record_failure(
            repository,
            run_id,
            tool_call_id="call-invalid",
            tool_name="get_events",
            error_code=error_code,
            retryable=retryable,
        )
        await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-later-success",
            tool_name="get_events",
        )

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(
                _insufficient(), run_id, repository, required_evidence=frozenset()
            )


@pytest.mark.asyncio
async def test_sanitized_required_text_and_total_utf8_budget_fail_closed(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "output-budgets")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-events",
            tool_name="get_events",
        )

        with pytest.raises(DiagnosisValidationError) as empty_error:
            await validate_diagnosis(
                _diagnosed(evidence_id, summary="\u202e"),
                run_id,
                repository,
                required_evidence=frozenset(),
            )
        assert empty_error.value.code == "structured_output_invalid"

        large_payload = DiagnosisCandidate.model_validate(
            {
                "outcome": "diagnosed",
                "summary": "界" * 1024,
                "root_causes": [
                    {
                        "code": f"cause_{index}",
                        "statement": "界" * 1024,
                        "confidence": "medium",
                        "evidence_ids": [str(evidence_id)],
                    }
                    for index in range(5)
                ],
                "missing_information": ["界" * 512 for _ in range(10)],
            }
        )
        with pytest.raises(DiagnosisValidationError) as size_error:
            await validate_diagnosis(
                large_payload, run_id, repository, required_evidence=frozenset()
            )
        assert size_error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
async def test_snapshot_rejects_corrupt_evidence_event(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "corrupt-evidence")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-corrupt",
            tool_name="get_pods",
        )
        async with database.session_factory() as session, session.begin():
            event_row = await session.scalar(
                select(RunEventRow).where(
                    RunEventRow.run_id == str(run_id),
                    RunEventRow.event_key == "tool:call-corrupt:evidence",
                )
            )
            assert event_row is not None
            event_row.payload_json = "{}"

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(
                _diagnosed(evidence_id),
                run_id,
                repository,
                required_evidence=frozenset(),
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("started_state", ["missing", "wrong_name", "late"])
async def test_snapshot_requires_matching_earlier_tool_started(
    tmp_path: Path,
    started_state: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"started-{started_state}")
        if started_state == "wrong_name":
            await repository.record_tool_started(run_id, "call-started", "get_workload")
        persisted = await repository.record_evidence(
            _evidence_record(
                run_id,
                tool_call_id="call-started",
                tool_name="get_pods",
            )
        )
        if started_state == "late":
            await repository.record_tool_started(run_id, "call-started", "get_pods")

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(
                _diagnosed(persisted.id),
                run_id,
                repository,
                required_evidence=frozenset(),
            )


@pytest.mark.asyncio
async def test_snapshot_rejects_tool_started_without_an_outcome(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "orphan-started")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-complete",
            tool_name="get_workload",
        )
        await repository.record_tool_started(
            run_id,
            "call-without-outcome",
            "get_events",
        )

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(
                _diagnosed(evidence_id),
                run_id,
                repository,
                required_evidence=frozenset(),
            )


@pytest.mark.asyncio
async def test_snapshot_database_failure_has_static_error(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "database-failure")

        def fail_read(
            _connection: object,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _executemany: bool,
        ) -> None:
            raise OperationalError(
                statement,
                {"token": "must-not-leak"},
                RuntimeError("/private/database/path"),
            )

        event.listen(database.engine.sync_engine, "before_cursor_execute", fail_read)
        try:
            with pytest.raises(PersistenceOperationError) as error:
                await validate_diagnosis(
                    _insufficient(),
                    run_id,
                    repository,
                    required_evidence=frozenset(),
                )
        finally:
            event.remove(
                database.engine.sync_engine, "before_cursor_execute", fail_read
            )

        assert str(error.value) == "Persistence operation failed"
        assert "must-not-leak" not in repr(error.value)
        assert "/private/database/path" not in repr(error.value)


def _repair_intent(evidence_ids: tuple[UUID, ...]) -> SetContainerImageIntent:
    return SetContainerImageIntent(
        action="set_container_image",
        target=_scenario("image-pull-backoff").target,
        container_name="workload",
        replacement_image="registry.k8s.io/e2e-test-images/agnhost:2.53",
        evidence_ids=list(evidence_ids[:2]),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("image", "recorded_tools", "expected"),
    [
        (
            "registry.invalid/k8s-incident-agent/missing:v1",
            ("get_workload", "get_pods", "get_events"),
            "accepted",
        ),
        (
            "registry.example.com/private/workload:v1",
            ("get_workload", "get_pods", "get_events"),
            "denied",
        ),
        (
            "registry.invalid/k8s-incident-agent/missing:v1",
            ("get_workload",),
            "denied",
        ),
    ],
)
async def test_repair_intent_requires_the_proven_invalid_registry_fact(
    tmp_path: Path,
    image: str,
    recorded_tools: tuple[str, ...],
    expected: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "image-pull-backoff")
        payloads = _image_pull_payloads(image)
        evidence_ids = tuple(
            [
                await _record_evidence(
                    repository,
                    run_id,
                    tool_call_id=f"call-{tool_name}",
                    tool_name=tool_name,
                    payload=payloads[tool_name],
                )
                for tool_name in recorded_tools
            ]
            + [
                await _record_evidence(
                    repository,
                    run_id,
                    tool_call_id="call-get_rollout_history",
                    tool_name="get_rollout_history",
                )
            ]
        )
        # The model self-reports the reserved code; only proven facts may back a repair.
        candidate = _diagnosed_with_evidence(
            evidence_ids, code="image_invalid_registry"
        ).model_copy(
            update={
                "repair_intent": _repair_intent((evidence_ids[0], evidence_ids[-1]))
            }
        )

        if expected == "accepted":
            validated = await validate_diagnosis(
                candidate,
                run_id,
                repository,
                required_evidence=frozenset({"workload"}),
            )
            assert validated.repair_intent is not None
            assert validated.root_causes[0].code == "image_invalid_registry"
        else:
            with pytest.raises(RepairIntentUnsupportedError) as error:
                await validate_diagnosis(
                    candidate,
                    run_id,
                    repository,
                    required_evidence=frozenset({"workload"}),
                )
            assert error.value.code == "repair_policy_denied"


@pytest.mark.asyncio
async def test_recommendations_are_sanitized_and_kept_with_the_diagnosis(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "recommendation-run")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-1",
            tool_name="get_workload",
        )
        candidate = _diagnosed(evidence_id).model_copy(
            update={
                "recommendations": [
                    Recommendation.model_validate(
                        _recommendation(
                            evidence_id,
                            action="确认 token=abcdef012345 是否泄露",
                        )
                    )
                ]
            }
        )

        validated = await validate_diagnosis(
            candidate,
            run_id,
            repository,
            required_evidence=frozenset(),
        )

        assert validated.redacted is True
        [recommendation] = validated.recommendations
        assert "abcdef012345" not in recommendation.action
        assert recommendation.evidence_ids == [evidence_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["diagnosed", "insufficient_evidence"])
async def test_recommendations_must_cite_evidence_of_this_run(
    tmp_path: Path,
    outcome: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"foreign-recommendation-{outcome}")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-1",
            tool_name="get_workload",
        )
        other_run = await _running_run(repository, f"other-{outcome}")
        foreign = await _record_evidence(
            repository,
            other_run,
            tool_call_id="call-foreign",
            tool_name="get_pods",
        )
        base = _diagnosed(evidence_id) if outcome == "diagnosed" else _insufficient()
        candidate = base.model_copy(
            update={
                "recommendations": [
                    Recommendation.model_validate(_recommendation(foreign))
                ]
            }
        )

        with pytest.raises(DiagnosisValidationError) as error:
            await validate_diagnosis(
                candidate,
                run_id,
                repository,
                required_evidence=frozenset(),
            )

        assert error.value.code == "structured_output_invalid"
