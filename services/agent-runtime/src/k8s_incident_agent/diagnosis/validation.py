from __future__ import annotations

from typing import Final, cast
from uuid import UUID

from pydantic import ValidationError

from k8s_incident_agent.diagnosis.contracts import (
    DiagnosisCandidate,
    Recommendation,
    RootCause,
    ValidatedDiagnosis,
)
from k8s_incident_agent.diagnosis.tool_execution import (
    validate_diagnostic_tool_failure_contract,
)
from k8s_incident_agent.domain.models import (
    JsonValue,
    PersistedEvidence,
    ToolFailureRecord,
)
from k8s_incident_agent.kubernetes.contracts import ContainerLogsPayload
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.security.sanitizer import sanitize_untrusted_text

# A size guard on one serialized diagnosis, deliberately below the sum of the
# field limits: those admit ~62 KB of CJK text, which no useful diagnosis needs.
# Raised with DC-5 so a result carrying recommendations keeps the headroom the
# earlier fields had. Exceeding it fails the Run closed as structured_output_invalid.
_MAX_DIAGNOSIS_BYTES: Final = 24 * 1024


class DiagnosisValidationError(RuntimeError):
    code = "structured_output_invalid"

    def __init__(self) -> None:
        super().__init__("The structured diagnosis is invalid")


class UnresolvedToolFailuresError(RuntimeError):
    def __init__(self, failures: tuple[ToolFailureRecord, ...]) -> None:
        self.failures = failures
        super().__init__("The diagnosis has unresolved tool failures")


async def validate_diagnosis(
    candidate: DiagnosisCandidate,
    run_id: UUID,
    repository: IncidentRepository,
    *,
    required_evidence: frozenset[str],
) -> ValidatedDiagnosis:
    validated = _sanitize_candidate(candidate)
    serialized = canonical_json(
        cast(dict[str, JsonValue], validated.model_dump(mode="json"))
    )
    if len(serialized.encode("utf-8")) > _MAX_DIAGNOSIS_BYTES:
        raise DiagnosisValidationError

    snapshot = await repository.get_diagnosis_validation_snapshot(run_id)
    _require_valid_failure_contracts(snapshot.tool_failures)
    fatal_failures = tuple(
        failure
        for failure in snapshot.unresolved_tool_failures
        if not failure.retryable
    )
    if fatal_failures:
        raise UnresolvedToolFailuresError(snapshot.unresolved_tool_failures)
    if (
        validated.outcome == "insufficient_evidence"
        and snapshot.unresolved_tool_failures
    ):
        raise UnresolvedToolFailuresError(snapshot.unresolved_tool_failures)
    evidence_ids = snapshot.evidence_by_id.keys()
    if not evidence_ids:
        raise DiagnosisValidationError

    # A recommendation is only readable next to what it was drawn from, so its
    # references must belong to this Run whatever the outcome is.
    recommended_ids = {
        evidence_id
        for recommendation in validated.recommendations
        for evidence_id in recommendation.evidence_ids
    }
    if not recommended_ids.issubset(evidence_ids):
        raise DiagnosisValidationError

    if validated.outcome == "diagnosed":
        cited_ids = {
            evidence_id
            for root_cause in validated.root_causes
            for evidence_id in root_cause.evidence_ids
        }
        if any(root_cause.code == "unknown" for root_cause in validated.root_causes):
            raise DiagnosisValidationError
        if not cited_ids.issubset(evidence_ids):
            raise DiagnosisValidationError
        cited_kinds = {
            evidence_kind
            for evidence_id in cited_ids
            if (
                evidence_kind := _usable_evidence_kind(
                    snapshot.evidence_by_id[evidence_id]
                )
            )
            is not None
        }
        if not required_evidence.issubset(cited_kinds):
            raise DiagnosisValidationError

    return validated


def _usable_evidence_kind(evidence: PersistedEvidence) -> str | None:
    if evidence.evidence_kind != "container_logs":
        return evidence.evidence_kind
    try:
        payload = ContainerLogsPayload.model_validate_json(
            canonical_json(evidence.payload)
        )
    except ValidationError:
        raise RecoveryConsistencyError from None
    if any(
        snapshot.status == "available"
        and any(line.message.strip() for line in snapshot.lines)
        for container in payload.containers
        for snapshot in container.snapshots
    ):
        return evidence.evidence_kind
    return None


def _sanitize_candidate(candidate: DiagnosisCandidate) -> ValidatedDiagnosis:
    summary = sanitize_untrusted_text(candidate.summary, max_code_points=1024)
    redacted = summary.redacted
    if summary.truncated or not summary.value:
        raise DiagnosisValidationError

    root_causes: list[RootCause] = []
    for root_cause in candidate.root_causes:
        statement = sanitize_untrusted_text(
            root_cause.statement,
            max_code_points=1024,
        )
        if statement.truncated or not statement.value:
            raise DiagnosisValidationError
        redacted = redacted or statement.redacted
        root_causes.append(
            RootCause(
                code=root_cause.code,
                statement=statement.value,
                confidence=root_cause.confidence,
                evidence_ids=root_cause.evidence_ids,
            )
        )

    recommendations: list[Recommendation] = []
    for recommendation in candidate.recommendations:
        fields: dict[str, str] = {}
        for name in ("action", "purpose", "preconditions", "risk", "verification"):
            sanitized = sanitize_untrusted_text(
                getattr(recommendation, name),
                max_code_points=512,
            )
            if sanitized.truncated or not sanitized.value:
                raise DiagnosisValidationError
            redacted = redacted or sanitized.redacted
            fields[name] = sanitized.value
        recommendations.append(
            Recommendation(**fields, evidence_ids=recommendation.evidence_ids)
        )

    missing_information: list[str] = []
    for value in candidate.missing_information:
        sanitized = sanitize_untrusted_text(value, max_code_points=512)
        if sanitized.truncated or not sanitized.value:
            raise DiagnosisValidationError
        redacted = redacted or sanitized.redacted
        missing_information.append(sanitized.value)

    try:
        return ValidatedDiagnosis(
            outcome=candidate.outcome,
            summary=summary.value,
            root_causes=root_causes,
            missing_information=missing_information,
            recommendations=recommendations,
            repair_intent=candidate.repair_intent,
            redacted=redacted,
        )
    except ValidationError:
        raise DiagnosisValidationError from None


def _require_valid_failure_contracts(
    failures: tuple[ToolFailureRecord, ...],
) -> None:
    for failure in failures:
        try:
            validate_diagnostic_tool_failure_contract(
                failure.tool_name,
                failure.error_code,
                retryable=failure.retryable,
            )
        except ValueError:
            raise RecoveryConsistencyError from None
