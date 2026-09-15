from sqlalchemy import Enum as SqlEnum

from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    IncidentStatus,
    RunStatus,
)
from k8s_incident_agent.persistence.models import (
    DiagnosisRow,
    IncidentRow,
    RunRow,
)


def test_domain_statuses_define_only_the_multi_run_transitions() -> None:
    incident_transitions = {
        (current, target)
        for current in IncidentStatus
        for target in IncidentStatus
        if current.can_transition_to(target)
    }
    run_transitions = {
        (current, target)
        for current in RunStatus
        for target in RunStatus
        if current.can_transition_to(target)
    }

    assert incident_transitions == {
        (IncidentStatus.RECEIVED, IncidentStatus.TRIAGING),
        (IncidentStatus.RECEIVED, IncidentStatus.FAILED),
        (IncidentStatus.TRIAGING, IncidentStatus.DIAGNOSED),
        (IncidentStatus.TRIAGING, IncidentStatus.INSUFFICIENT_EVIDENCE),
        (IncidentStatus.TRIAGING, IncidentStatus.FAILED),
        (IncidentStatus.DIAGNOSED, IncidentStatus.TRIAGING),
        (IncidentStatus.DIAGNOSED, IncidentStatus.PATCH_READY),
        (IncidentStatus.DIAGNOSED, IncidentStatus.FAILED),
        (IncidentStatus.PATCH_READY, IncidentStatus.DRY_RUN_PASSED),
        (IncidentStatus.PATCH_READY, IncidentStatus.STALE_RESOURCE),
        (IncidentStatus.PATCH_READY, IncidentStatus.FAILED),
        (IncidentStatus.DRY_RUN_PASSED, IncidentStatus.WAITING_APPROVAL),
        (IncidentStatus.DRY_RUN_PASSED, IncidentStatus.FAILED),
        (IncidentStatus.WAITING_APPROVAL, IncidentStatus.TRIAGING),
        (IncidentStatus.WAITING_APPROVAL, IncidentStatus.FAILED),
        (IncidentStatus.WAITING_APPROVAL, IncidentStatus.APPLYING),
        (IncidentStatus.WAITING_APPROVAL, IncidentStatus.REJECTED),
        (IncidentStatus.APPLYING, IncidentStatus.VERIFYING),
        (IncidentStatus.APPLYING, IncidentStatus.FAILED),
        (IncidentStatus.APPLYING, IncidentStatus.STALE_RESOURCE),
        (IncidentStatus.VERIFYING, IncidentStatus.FAILED),
        (IncidentStatus.VERIFYING, IncidentStatus.RESOLVED),
        (IncidentStatus.VERIFYING, IncidentStatus.ROLLED_BACK),
        (IncidentStatus.RESOLVED, IncidentStatus.TRIAGING),
        (IncidentStatus.ROLLED_BACK, IncidentStatus.TRIAGING),
        (IncidentStatus.REJECTED, IncidentStatus.TRIAGING),
        (IncidentStatus.INSUFFICIENT_EVIDENCE, IncidentStatus.TRIAGING),
        (IncidentStatus.INSUFFICIENT_EVIDENCE, IncidentStatus.FAILED),
        (IncidentStatus.FAILED, IncidentStatus.TRIAGING),
        (IncidentStatus.FAILED, IncidentStatus.FAILED),
        (IncidentStatus.STALE_RESOURCE, IncidentStatus.TRIAGING),
        (IncidentStatus.STALE_RESOURCE, IncidentStatus.FAILED),
    }
    assert run_transitions == {
        (RunStatus.QUEUED, RunStatus.RUNNING),
        (RunStatus.QUEUED, RunStatus.FAILED),
        (RunStatus.RUNNING, RunStatus.COMPLETED),
        (RunStatus.RUNNING, RunStatus.FAILED),
        (RunStatus.RUNNING, RunStatus.WAITING_APPROVAL),
        (RunStatus.WAITING_APPROVAL, RunStatus.RUNNING),
        (RunStatus.WAITING_APPROVAL, RunStatus.COMPLETED),
        (RunStatus.WAITING_APPROVAL, RunStatus.FAILED),
    }


def test_mapped_status_columns_persist_the_domain_values() -> None:
    incident_type = IncidentRow.__table__.c.status.type
    run_type = RunRow.__table__.c.status.type
    diagnosis_type = DiagnosisRow.__table__.c.outcome.type

    assert isinstance(incident_type, SqlEnum)
    assert isinstance(run_type, SqlEnum)
    assert isinstance(diagnosis_type, SqlEnum)
    assert tuple(incident_type.enums) == tuple(
        status.value for status in IncidentStatus
    )
    assert tuple(run_type.enums) == tuple(status.value for status in RunStatus)
    assert tuple(diagnosis_type.enums) == tuple(
        outcome.value for outcome in DiagnosisOutcome
    )
