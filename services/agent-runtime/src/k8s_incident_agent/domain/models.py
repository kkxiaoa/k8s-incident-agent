from __future__ import annotations

from enum import StrEnum
from typing import Final


class IncidentStatus(StrEnum):
    RECEIVED = "RECEIVED"
    TRIAGING = "TRIAGING"
    DIAGNOSED = "DIAGNOSED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    FAILED = "FAILED"

    def can_transition_to(self, target: IncidentStatus) -> bool:
        return target in _INCIDENT_TRANSITIONS[self]


class RunStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"

    def can_transition_to(self, target: RunStatus) -> bool:
        return target in _RUN_TRANSITIONS[self]


class DiagnosisOutcome(StrEnum):
    DIAGNOSED = "diagnosed"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


_INCIDENT_TRANSITIONS: Final[dict[IncidentStatus, frozenset[IncidentStatus]]] = {
    IncidentStatus.RECEIVED: frozenset(
        {IncidentStatus.TRIAGING, IncidentStatus.FAILED}
    ),
    IncidentStatus.TRIAGING: frozenset(
        {
            IncidentStatus.DIAGNOSED,
            IncidentStatus.INSUFFICIENT_EVIDENCE,
            IncidentStatus.FAILED,
        }
    ),
    IncidentStatus.DIAGNOSED: frozenset(),
    IncidentStatus.INSUFFICIENT_EVIDENCE: frozenset(),
    IncidentStatus.FAILED: frozenset(),
}

_RUN_TRANSITIONS: Final[dict[RunStatus, frozenset[RunStatus]]] = {
    RunStatus.QUEUED: frozenset({RunStatus.RUNNING, RunStatus.FAILED}),
    RunStatus.RUNNING: frozenset({RunStatus.COMPLETED, RunStatus.FAILED}),
    RunStatus.COMPLETED: frozenset(),
    RunStatus.FAILED: frozenset(),
}
