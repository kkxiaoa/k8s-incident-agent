import base64
import binascii
import json
import re
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from typing import Protocol, cast
from uuid import UUID

from k8s_incident_agent.api_contracts import (
    CreateIncidentRequest,
    CreateIncidentResponse,
    DiagnosisResponse,
    EvidenceResponse,
    IncidentDetailResponse,
    IncidentListItem,
    IncidentListResponse,
    IncidentResponse,
    RootCauseResponse,
    RunBudgetResponse,
    RunErrorResponse,
    RunResponse,
    RunUsageResponse,
    ScenarioListResponse,
    ScenarioResponse,
    ScenarioTargetResponse,
    ScenarioTriggerResponse,
)
from k8s_incident_agent.domain.models import ModelSnapshot, RunBudget
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredentialLease,
    require_credential_window,
)
from k8s_incident_agent.kubernetes.errors import KubernetesBoundaryError
from k8s_incident_agent.persistence.repositories import (
    IncidentDetailRecord,
    IncidentListRecord,
    IncidentRepository,
)
from k8s_incident_agent.scenarios.contracts import PublicScenario, ScenarioTarget

_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+={0,2}$")


class ScenarioNotFoundError(RuntimeError):
    pass


class IncidentNotFoundError(RuntimeError):
    pass


class InvalidCursorError(RuntimeError):
    pass


class RuntimeNotReadyError(RuntimeError):
    pass


class _RunScheduler(Protocol):
    async def schedule(self, run_id: UUID) -> None: ...


class IncidentApplicationService:
    def __init__(
        self,
        *,
        catalog: tuple[PublicScenario, ...],
        repository: IncidentRepository,
        supervisor: _RunScheduler,
        credential: DiagnosticCredentialLease,
        model: ModelSnapshot,
        budget: RunBudget,
        now: Callable[[], datetime],
    ) -> None:
        self._catalog = catalog
        self._scenarios = {scenario.scenario_id: scenario for scenario in catalog}
        if len(self._scenarios) != len(catalog):
            raise ValueError("Scenario catalog contains duplicate identifiers")
        self._repository = repository
        self._supervisor = supervisor
        self._credential = credential
        self._model = model
        self._budget = budget
        self._now = now

    async def list_scenarios(self) -> ScenarioListResponse:
        return ScenarioListResponse(
            items=tuple(_scenario_response(scenario) for scenario in self._catalog)
        )

    async def create_incident(
        self,
        request: CreateIncidentRequest,
    ) -> CreateIncidentResponse:
        scenario = self._scenarios.get(request.scenario_id)
        if scenario is None:
            raise ScenarioNotFoundError
        try:
            require_credential_window(
                self._credential,
                self._budget.timeout_seconds + 60,
                self._now(),
            )
        except KubernetesBoundaryError:
            raise RuntimeNotReadyError from None
        created = await self._repository.create_incident_and_run(
            scenario,
            self._model,
            self._budget,
        )
        # The committed QUEUED run is deliberately left for startup reconciliation.
        with suppress(Exception):
            await self._supervisor.schedule(created.run_id)
        return CreateIncidentResponse(
            incident_id=created.incident_id,
            run_id=created.run_id,
            incident_status=created.incident_status,
            run_status=created.run_status,
        )

    async def list_incidents(
        self,
        *,
        limit: int,
        cursor: str | None,
    ) -> IncidentListResponse:
        decoded_cursor = _decode_cursor(cursor) if cursor is not None else None
        page = await self._repository.list_incident_records(
            limit=limit,
            cursor=decoded_cursor,
        )
        next_cursor = None
        if page.has_more and page.items:
            last = page.items[-1]
            next_cursor = _encode_cursor(last.created_at, last.id)
        return IncidentListResponse(
            items=tuple(_incident_list_item(item) for item in page.items),
            next_cursor=next_cursor,
        )

    async def get_incident(self, incident_id: UUID) -> IncidentDetailResponse:
        detail = await self._repository.get_incident_detail(incident_id)
        if detail is None:
            raise IncidentNotFoundError
        return _incident_detail_response(detail)


def _scenario_response(scenario: PublicScenario) -> ScenarioResponse:
    return ScenarioResponse(
        scenario_id=scenario.scenario_id,
        scenario_version=scenario.scenario_version,
        display_name=scenario.display_name,
        description=scenario.description,
        trigger=ScenarioTriggerResponse(
            type=scenario.trigger.type,
            summary=scenario.trigger.summary,
        ),
        target=_target_response(scenario.target),
    )


def _target_response(target: ScenarioTarget) -> ScenarioTargetResponse:
    return ScenarioTargetResponse(
        cluster=target.cluster,
        namespace=target.namespace,
        api_version=target.api_version,
        kind=target.kind,
        name=target.name,
    )


def _incident_list_item(item: IncidentListRecord) -> IncidentListItem:
    return IncidentListItem(
        id=item.id,
        scenario_id=item.scenario_id,
        scenario_version=item.scenario_version,
        display_name=item.display_name,
        target=_target_response(item.target),
        status=item.status,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _incident_detail_response(detail: IncidentDetailRecord) -> IncidentDetailResponse:
    incident = detail.incident
    run = detail.run
    run_error = None
    if run.error_code is not None and run.error_retryable is not None:
        run_error = RunErrorResponse(
            code=run.error_code,
            retryable=run.error_retryable,
        )
    diagnosis = None
    if detail.diagnosis is not None:
        diagnosis = DiagnosisResponse(
            id=detail.diagnosis.id,
            outcome=detail.diagnosis.outcome,
            summary=detail.diagnosis.summary,
            root_causes=tuple(
                RootCauseResponse(
                    code=root_cause.code,
                    statement=root_cause.statement,
                    confidence=root_cause.confidence,
                    evidence_ids=root_cause.evidence_ids,
                )
                for root_cause in detail.diagnosis.root_causes
            ),
            missing_information=detail.diagnosis.missing_information,
            redacted=detail.diagnosis.redacted,
            created_at=detail.diagnosis.created_at,
        )
    return IncidentDetailResponse(
        incident=IncidentResponse(
            id=incident.id,
            scenario_id=incident.scenario_id,
            scenario_version=incident.scenario_version,
            display_name=incident.display_name,
            trigger_summary=detail.trigger_summary,
            target=_target_response(incident.target),
            status=incident.status,
            created_at=incident.created_at,
            updated_at=incident.updated_at,
        ),
        run=RunResponse(
            id=run.id,
            status=run.status,
            model_provider=run.model.provider,
            model_id=run.model.model_id,
            thinking_mode=run.model.thinking_mode,
            prompt_version=run.model.prompt_version,
            budget=RunBudgetResponse(
                max_model_calls=run.budget.max_model_calls,
                max_tool_calls=run.budget.max_tool_calls,
                timeout_seconds=run.budget.timeout_seconds,
            ),
            usage=RunUsageResponse(
                model_calls=run.model_calls,
                tool_calls=run.tool_calls,
                input_tokens=run.input_tokens,
                output_tokens=run.output_tokens,
            ),
            error=run_error,
            created_at=run.created_at,
            started_at=run.started_at,
            completed_at=run.completed_at,
        ),
        evidence=tuple(
            EvidenceResponse(
                id=evidence.id,
                tool_call_id=evidence.tool_call_id,
                tool_name=evidence.tool_name,
                evidence_kind=evidence.evidence_kind,
                target_ref=evidence.target_ref,
                observed_at=evidence.observed_at,
                payload=evidence.payload,
                truncated=evidence.truncated,
                redacted=evidence.redacted,
            )
            for evidence in detail.evidence
        ),
        diagnosis=diagnosis,
    )


def _encode_cursor(created_at: datetime, incident_id: UUID) -> str:
    document = json.dumps(
        {"createdAt": _rfc3339(created_at), "id": str(incident_id)},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return base64.urlsafe_b64encode(document).rstrip(b"=").decode()


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        if not cursor or not _BASE64URL.fullmatch(cursor):
            raise ValueError
        padding = b"=" * (-len(cursor) % 4)
        document = base64.b64decode(
            cursor.encode() + padding,
            altchars=b"-_",
            validate=True,
        )
        value = cast(object, json.loads(document))
        if not isinstance(value, dict):
            raise ValueError
        untyped = cast(dict[object, object], value)
        created_at_raw = untyped.get("createdAt")
        incident_id_raw = untyped.get("id")
        if not isinstance(created_at_raw, str) or not isinstance(incident_id_raw, str):
            raise ValueError
        created_at = datetime.fromisoformat(created_at_raw)
        utc_offset = created_at.utcoffset()
        if utc_offset is None or utc_offset.total_seconds() != 0:
            raise ValueError
        incident_id = UUID(incident_id_raw)
        return created_at.astimezone(UTC), incident_id
    except (
        binascii.Error,
        UnicodeError,
        json.JSONDecodeError,
        ValueError,
    ):
        raise InvalidCursorError from None


def _rfc3339(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Cursor timestamp must include a UTC offset")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
