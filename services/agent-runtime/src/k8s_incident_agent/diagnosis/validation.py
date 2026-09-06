from __future__ import annotations

from typing import Final, cast
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import ValidationError

from k8s_incident_agent.diagnosis.contracts import (
    DiagnosisCandidate,
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
from k8s_incident_agent.kubernetes.contracts import (
    ContainerLogsPayload,
    EventsPayload,
    PodsPayload,
    WorkloadPayload,
)
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.security.sanitizer import sanitize_untrusted_text

_MAX_DIAGNOSIS_BYTES: Final = 16 * 1024
_INVALID_REGISTRY_ROOT_CAUSE: Final = "image_invalid_registry"
_IMAGE_PULL_WAITING_REASONS: Final = frozenset({"ErrImagePull", "ImagePullBackOff"})


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
        validated = _canonicalize_evidence_backed_root_causes(
            validated,
            snapshot.evidence_by_id,
        )

    return validated


def _canonicalize_evidence_backed_root_causes(
    diagnosis: ValidatedDiagnosis,
    evidence_by_id: dict[UUID, PersistedEvidence],
) -> ValidatedDiagnosis:
    root_causes = [
        root_cause.model_copy(
            update={
                "code": (
                    _INVALID_REGISTRY_ROOT_CAUSE
                    if "image" in root_cause.code.split("_")
                    and _proves_reserved_invalid_registry(
                        tuple(
                            evidence_by_id[value] for value in root_cause.evidence_ids
                        )
                    )
                    else root_cause.code
                )
            }
        )
        for root_cause in diagnosis.root_causes
    ]
    return diagnosis.model_copy(update={"root_causes": root_causes})


def _proves_reserved_invalid_registry(
    evidence: tuple[PersistedEvidence, ...],
) -> bool:
    by_kind = {item.evidence_kind: item for item in evidence}
    if not {"workload", "pods", "events"}.issubset(by_kind):
        return False
    try:
        workload = WorkloadPayload.model_validate(by_kind["workload"].payload)
        pods = PodsPayload.model_validate(by_kind["pods"].payload)
        events = EventsPayload.model_validate(by_kind["events"].payload)
    except ValidationError:
        raise RecoveryConsistencyError from None

    invalid_images = {
        container.image
        for container in workload.workload.containers
        if _uses_reserved_invalid_registry(container.image)
    }
    failed_pods = {
        (pod.namespace, pod.name, pod.uid)
        for pod in pods.pods
        if any(
            container.image in invalid_images
            and container.state.status == "waiting"
            and container.state.reason in _IMAGE_PULL_WAITING_REASONS
            for container in pod.containers
        )
    }
    return bool(invalid_images and failed_pods) and any(
        event.type == "Warning"
        and event.reason == "Failed"
        and event.reporting_controller == "kubelet"
        and (
            event.regarding.namespace,
            event.regarding.name,
            event.regarding.uid,
        )
        in failed_pods
        for event in events.events
    )


def _uses_reserved_invalid_registry(image: str) -> bool:
    if "://" in image:
        hostname = urlsplit(image).hostname
    else:
        authority, separator, _ = image.partition("/")
        if not separator:
            return False
        if (
            "." not in authority
            and ":" not in authority
            and authority.casefold() != "localhost"
        ):
            return False
        hostname = authority.rsplit(":", 1)[0]
    if hostname is None:
        return False
    normalized = hostname.rstrip(".").casefold()
    return normalized == "invalid" or normalized.endswith(".invalid")


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
