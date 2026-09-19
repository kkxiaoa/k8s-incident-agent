import base64
import binascii
import json
import re
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

from k8s_incident_agent.api_contracts import (
    AlertSignalResponse,
    ApprovalRequest,
    ApprovalResponse,
    CreateIncidentRequest,
    CreateIncidentResponse,
    CreateRepairRunRequest,
    CreateRunResponse,
    DiagnosisResponse,
    EventPageResponse,
    EvidenceResponse,
    ExecutionResponse,
    IncidentDetailResponse,
    IncidentListItem,
    IncidentListResponse,
    IncidentResponse,
    IncidentSourceResponse,
    IncidentTargetResponse,
    RecommendationResponse,
    RepairDiffResponse,
    RepairHistorySelectionResponse,
    RepairPatchOperationResponse,
    RepairProposalResponse,
    RepairValidationErrorResponse,
    RepairValidationResponse,
    RootCauseResponse,
    RunErrorResponse,
    RunEventHistoryResponse,
    RunEventStreamItem,
    RunHistoryResponse,
    RunSummaryResponse,
    ScenarioListResponse,
    ScenarioResponse,
    ScenarioTargetResponse,
    ScenarioTriggerResponse,
    SelectedRunResponse,
)
from k8s_incident_agent.application.event_projection import validated_stream_item
from k8s_incident_agent.application.scheduling import (
    RunScheduler,
    schedule_committed_run,
)
from k8s_incident_agent.auth.sessions import OperatorSession
from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
    RepairHistorySelection,
)
from k8s_incident_agent.domain.models import ModelSnapshot, RunBudget, RunEvent
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredentialLease,
    require_credential_window,
)
from k8s_incident_agent.kubernetes.errors import KubernetesBoundaryError
from k8s_incident_agent.model.availability import DiagnosisUnavailableError
from k8s_incident_agent.persistence.repositories import (
    ActiveRunExistsError,
    IncidentDetailRecord,
    IncidentListRecord,
    IncidentRepairDetail,
    IncidentRepository,
    IncidentRunDetail,
    RunNotFoundRepositoryError,
)
from k8s_incident_agent.scenarios.contracts import PublicScenario, ScenarioTarget

_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+={0,2}$")


class ScenarioNotFoundError(RuntimeError):
    pass


class IncidentNotFoundError(RuntimeError):
    pass


class RunNotFoundError(RuntimeError):
    pass


class ActiveRunConflictError(RuntimeError):
    pass


class InvalidCursorError(RuntimeError):
    pass


class RuntimeNotReadyError(RuntimeError):
    pass


class IncidentApplicationService:
    def __init__(
        self,
        *,
        catalog: tuple[PublicScenario, ...],
        repository: IncidentRepository,
        supervisor: RunScheduler,
        credential: DiagnosticCredentialLease,
        model: Callable[[], ModelSnapshot | None],
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
        *,
        operator_ref: str | None = None,
        requester: OperatorSession | None = None,
    ) -> CreateIncidentResponse:
        scenario = self._scenarios.get(request.scenario_id)
        if scenario is None:
            raise ScenarioNotFoundError
        model = self._require_diagnostic_readiness()
        created = await self._repository.create_incident_and_run(
            _normalized_scenario_trigger(scenario),
            model,
            self._budget,
            operator_ref=operator_ref,
            requester=requester,
        )
        await schedule_committed_run(self._supervisor, created.run_id)
        return CreateIncidentResponse(incident_id=created.incident_id)

    async def create_run(
        self,
        incident_id: UUID,
        *,
        replaces_run_id: UUID | None = None,
        operator_ref: str | None = None,
        requester: OperatorSession | None = None,
    ) -> CreateRunResponse:
        model = self._require_diagnostic_readiness()
        try:
            created = await self._repository.create_run(
                incident_id,
                model,
                self._budget,
                replaces_run_id=replaces_run_id,
                operator_ref=operator_ref,
                requester=requester,
            )
        except ActiveRunExistsError:
            raise ActiveRunConflictError from None
        if created is None:
            raise IncidentNotFoundError
        await schedule_committed_run(self._supervisor, created.run_id)
        return CreateRunResponse(run_id=created.run_id)

    async def create_repair_run(
        self,
        incident_id: UUID,
        request: CreateRepairRunRequest,
        *,
        operator_ref: str | None,
        requester: OperatorSession | None = None,
    ) -> CreateRunResponse:
        selection = (
            None
            if request.selection is None
            else RepairHistorySelection(
                revision=int(request.selection.revision),
                replica_set_uid=request.selection.replica_set_uid,
            )
        )
        try:
            created = await self._repository.create_repair_run(
                incident_id,
                request.source_run_id,
                source_execution_id=request.source_execution_id,
                selection=selection,
                replaces_run_id=request.replaces_run_id,
                operator_ref=operator_ref,
                now=self._now(),
                requester=requester,
            )
        except ActiveRunExistsError:
            raise ActiveRunConflictError from None
        if created is None:
            raise IncidentNotFoundError
        await schedule_committed_run(self._supervisor, created.run_id)
        return CreateRunResponse(run_id=created.run_id)

    async def decide_approval(
        self,
        incident_id: UUID,
        request: ApprovalRequest,
        *,
        operator_ref: str,
        operator_token_hash: str,
    ) -> ApprovalResponse:
        repair = await self._repository.decide_approval(
            incident_id,
            request.run_id,
            request.proposal_id,
            request.proposal_digest,
            request.decision,
            operator_ref=operator_ref,
            operator_token_hash=operator_token_hash,
            now=self._now,
        )
        await schedule_committed_run(self._supervisor, request.run_id)
        response = _approval_response(repair)
        if response is None:
            raise RuntimeError("Committed decision is missing")
        return response

    async def list_incidents(
        self,
        *,
        limit: int,
        cursor: str | None,
    ) -> IncidentListResponse:
        decoded_cursor = _decode_incident_cursor(cursor) if cursor is not None else None
        page = await self._repository.list_incident_records(
            limit=limit,
            cursor=decoded_cursor,
        )
        next_cursor = None
        if page.has_more and page.items:
            last = page.items[-1]
            next_cursor = _encode_cursor(
                {"createdAt": _rfc3339(last.created_at), "id": str(last.id)}
            )
        return IncidentListResponse(
            items=tuple(_incident_list_item(item) for item in page.items),
            next_cursor=next_cursor,
        )

    async def get_incident(
        self,
        incident_id: UUID,
        *,
        run_id: UUID | None,
        requester: OperatorSession | None = None,
    ) -> IncidentDetailResponse:
        try:
            detail = await self._repository.get_incident_detail(
                incident_id,
                run_id=run_id,
                event_limit=100,
                now=self._now(),
                requester=requester,
            )
        except RunNotFoundRepositoryError:
            raise RunNotFoundError from None
        if detail is None:
            raise IncidentNotFoundError
        if detail.actions is None:
            raise RuntimeNotReadyError
        try:
            self._require_diagnostic_readiness()
        except (RuntimeNotReadyError, DiagnosisUnavailableError):
            detail = replace(
                detail,
                actions=detail.actions.model_copy(
                    update={
                        "rerun": detail.actions.rerun or "diagnosis_unavailable",
                    }
                ),
            )
        return _incident_detail_response(detail)

    async def list_runs(
        self,
        incident_id: UUID,
        *,
        limit: int,
        cursor: str | None,
        requester: OperatorSession | None = None,
        mine: bool = False,
    ) -> RunHistoryResponse:
        before_attempt = (
            _decode_run_cursor(cursor, incident_id) if cursor is not None else None
        )
        page = await self._repository.list_run_records(
            incident_id,
            limit=limit,
            before_attempt=before_attempt,
            requester=requester,
            mine=mine,
        )
        if page is None:
            raise IncidentNotFoundError
        next_cursor = None
        if page.has_more and page.items:
            next_cursor = _encode_cursor(
                {
                    "incidentId": str(incident_id),
                    "attempt": page.items[-1].attempt,
                }
            )
        return RunHistoryResponse(
            items=tuple(_run_summary(item) for item in page.items),
            next_cursor=next_cursor,
        )

    async def withdraw_run(
        self, incident_id: UUID, run_id: UUID, requester: OperatorSession
    ) -> None:
        try:
            await self._repository.withdraw_run(incident_id, run_id, requester)
        except ActiveRunExistsError:
            raise ActiveRunConflictError from None

    async def list_run_events(
        self,
        incident_id: UUID,
        run_id: UUID,
        *,
        limit: int,
        cursor: str | None,
    ) -> RunEventHistoryResponse:
        before_event_id = (
            _decode_event_cursor(cursor, incident_id, run_id)
            if cursor is not None
            else None
        )
        if not await self._repository.incident_exists(incident_id):
            raise IncidentNotFoundError
        try:
            page = await self._repository.list_run_events(
                incident_id,
                run_id,
                limit=limit,
                before_event_id=before_event_id,
            )
        except RunNotFoundRepositoryError:
            raise RunNotFoundError from None
        next_cursor = None
        if page.has_more and page.items:
            next_cursor = _encode_cursor(
                {
                    "incidentId": str(incident_id),
                    "runId": str(run_id),
                    "eventId": page.items[-1].id,
                }
            )
        return RunEventHistoryResponse(
            items=tuple(_stream_item(event) for event in page.items),
            next_cursor=next_cursor,
        )

    def _require_diagnostic_readiness(self) -> ModelSnapshot:
        try:
            require_credential_window(
                self._credential,
                self._budget.timeout_seconds + 60,
                self._now(),
            )
        except KubernetesBoundaryError:
            raise RuntimeNotReadyError from None
        model = self._model()
        if model is None:
            raise DiagnosisUnavailableError
        return model


def _normalized_scenario_trigger(scenario: PublicScenario) -> NormalizedIncidentTrigger:
    return NormalizedIncidentTrigger(
        source=IncidentSource(
            type="scenario",
            ref=scenario.scenario_id,
            revision=str(scenario.scenario_version),
        ),
        display_name=scenario.display_name,
        trigger_summary=scenario.trigger.summary,
        target=KubernetesTarget.model_validate(scenario.target.model_dump()),
    )


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
        target=_scenario_target_response(scenario.target),
    )


def _scenario_target_response(target: ScenarioTarget) -> ScenarioTargetResponse:
    if target.namespace is None:
        raise ValueError("Scenario target must be namespaced")
    return ScenarioTargetResponse(
        cluster=target.cluster,
        namespace=target.namespace,
        api_version=target.api_version,
        kind=target.kind,
        name=target.name,
    )


def _target_response(target: KubernetesTarget) -> IncidentTargetResponse:
    return IncidentTargetResponse(
        cluster=target.cluster,
        namespace=target.namespace,
        api_version=target.api_version,
        kind=target.kind,
        name=target.name,
    )


def _source_response(source: IncidentSource) -> IncidentSourceResponse:
    return IncidentSourceResponse(
        type=source.type,
        ref=source.ref,
        revision=source.revision,
    )


def _incident_list_item(item: IncidentListRecord) -> IncidentListItem:
    return IncidentListItem(
        id=item.id,
        display_name=item.display_name,
        target=_target_response(item.target),
        status=item.status,
        updated_at=item.updated_at,
    )


def _run_summary(run: IncidentRunDetail) -> RunSummaryResponse:
    return RunSummaryResponse(
        id=run.id,
        kind=run.kind,
        operation=run.operation,
        attempt=run.attempt,
        status=run.status,
        created_at=run.created_at,
        started_at=run.started_at,
        completed_at=run.completed_at,
        request_source=run.request_source,
        initiated_by_you=run.initiated_by_you,
        source_run_id=run.source_run_id,
    )


def _selected_run(run: IncidentRunDetail) -> SelectedRunResponse:
    run_error = None
    if run.error_code is not None and run.error_retryable is not None:
        run_error = RunErrorResponse(
            code=run.error_code,
            retryable=run.error_retryable,
        )
    return SelectedRunResponse(
        **_run_summary(run).model_dump(),
        error=run_error,
        selection=None
        if run.selection is None
        else RepairHistorySelectionResponse(
            revision=str(run.selection.revision),
            replica_set_uid=run.selection.replica_set_uid,
        ),
        waiting_expires_at=run.waiting_expires_at,
        end_reason=run.end_reason,
    )


def _approval_response(repair: IncidentRepairDetail | None) -> ApprovalResponse | None:
    if repair is None or repair.approval is None:
        return None
    execution = repair.execution
    return ApprovalResponse(
        **repair.approval.model_dump(),
        execution=ExecutionResponse.model_validate(
            execution.model_dump(exclude={"approval_id"})
        )
        if execution
        else None,
    )


def _incident_detail_response(detail: IncidentDetailRecord) -> IncidentDetailResponse:
    assert detail.actions is not None
    incident = detail.incident
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
            recommendations=(
                None
                if detail.diagnosis.recommendations is None
                else tuple(
                    RecommendationResponse(
                        action=recommendation.action,
                        purpose=recommendation.purpose,
                        preconditions=recommendation.preconditions,
                        risk=recommendation.risk,
                        verification=recommendation.verification,
                        evidence_ids=recommendation.evidence_ids,
                    )
                    for recommendation in detail.diagnosis.recommendations
                )
            ),
            redacted=detail.diagnosis.redacted,
            created_at=detail.diagnosis.created_at,
        )
    alert_signal = None
    if detail.alert_signal is not None:
        alert_signal = AlertSignalResponse(
            status=detail.alert_signal.status,
            starts_at=detail.alert_signal.starts_at,
            ends_at=detail.alert_signal.ends_at,
        )
    repair = None
    if detail.repair is not None:
        proposal = detail.repair.proposal
        validation = detail.repair.validation
        validation_error = (
            RepairValidationErrorResponse(
                code=validation.error.code,
                retryable=validation.error.retryable,
            )
            if validation.error is not None
            else None
        )
        repair = RepairProposalResponse(
            id=proposal.id,
            action=proposal.action,
            target=_target_response(proposal.target),
            target_uid=proposal.target_uid,
            target_resource_version=proposal.target_resource_version,
            container_index=proposal.container_index,
            container_name=proposal.container_name,
            current_image=proposal.current_image,
            replacement_image=proposal.replacement_image,
            evidence_ids=proposal.evidence_ids,
            source_execution_id=proposal.change.source_execution_id,
            patch=tuple(
                RepairPatchOperationResponse(
                    op=operation.op,
                    path=operation.path,
                    value=operation.value,
                )
                for operation in proposal.patch
            ),
            digest=proposal.digest,
            diff=RepairDiffResponse(
                path=proposal.diff.path,
                before=proposal.diff.before,
                after=proposal.diff.after,
            ),
            schema_checked_at=proposal.schema_checked_at,
            policy_checked_at=proposal.policy_checked_at,
            diff_checked_at=proposal.diff_checked_at,
            validation=RepairValidationResponse(
                outcome=validation.outcome,
                checked_at=validation.checked_at,
                error=validation_error,
            ),
        )
    next_cursor = None
    if detail.has_older_events and detail.events:
        next_cursor = _encode_cursor(
            {
                "incidentId": str(incident.id),
                "runId": str(detail.run.id),
                "eventId": detail.events[-1].id,
            }
        )
    return IncidentDetailResponse(
        incident=IncidentResponse(
            id=incident.id,
            source=_source_response(incident.source),
            display_name=incident.display_name,
            trigger_summary=detail.trigger_summary,
            target=_target_response(incident.target),
            status=incident.status,
            created_at=incident.created_at,
        ),
        selected_run=_selected_run(detail.run),
        event_page=EventPageResponse(
            items=tuple(_stream_item(event) for event in detail.events),
            next_cursor=next_cursor,
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
        repair=repair,
        approval=_approval_response(detail.repair),
        verification=detail.repair.verification if detail.repair is not None else None,
        actions=detail.actions,
        alert_signal=alert_signal,
        event_cursor=str(detail.event_cursor),
    )


def _stream_item(event: RunEvent) -> RunEventStreamItem:
    return validated_stream_item(event)


def _encode_cursor(document: dict[str, str | int]) -> str:
    encoded = json.dumps(
        document,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode()


def _decode_cursor_document(cursor: str) -> dict[object, object]:
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
        return cast(dict[object, object], value)
    except (binascii.Error, UnicodeError, json.JSONDecodeError, ValueError):
        raise InvalidCursorError from None


def _decode_incident_cursor(cursor: str) -> tuple[datetime, UUID]:
    value = _decode_cursor_document(cursor)
    created_at_raw = value.get("createdAt")
    incident_id_raw = value.get("id")
    try:
        if not isinstance(created_at_raw, str) or not isinstance(incident_id_raw, str):
            raise ValueError
        created_at = datetime.fromisoformat(created_at_raw)
        utc_offset = created_at.utcoffset()
        if utc_offset is None or utc_offset.total_seconds() != 0:
            raise ValueError
        return created_at.astimezone(UTC), UUID(incident_id_raw)
    except ValueError:
        raise InvalidCursorError from None


def _decode_run_cursor(cursor: str, incident_id: UUID) -> int:
    value = _decode_cursor_document(cursor)
    owner = value.get("incidentId")
    attempt = value.get("attempt")
    if owner != str(incident_id) or type(attempt) is not int or attempt < 1:
        raise InvalidCursorError
    return attempt


def _decode_event_cursor(cursor: str, incident_id: UUID, run_id: UUID) -> int:
    value = _decode_cursor_document(cursor)
    owner = value.get("incidentId")
    run_owner = value.get("runId")
    event_id = value.get("eventId")
    if (
        owner != str(incident_id)
        or run_owner != str(run_id)
        or type(event_id) is not int
        or event_id <= 0
    ):
        raise InvalidCursorError
    return event_id


def _rfc3339(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Cursor timestamp must include a UTC offset")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
