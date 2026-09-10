from typing import Final

from k8s_incident_agent.diagnosis.tool_execution import (
    validate_diagnostic_failure_contract,
)
from k8s_incident_agent.persistence.repositories import RecoveryConsistencyError

_WORKFLOW_FAILURE_RETRYABILITY: Final = {
    "agent_timeout": True,
    "model_call_limit_exceeded": False,
    "tool_call_limit_exceeded": False,
    "structured_output_invalid": False,
    "model_upstream_failed": True,
    "diagnosis_unavailable": True,
    "repair_schema_invalid": False,
    "repair_policy_denied": False,
    "repair_diff_invalid": False,
    "stale_resource": False,
    "patch_validator_authentication_failed": False,
    "patch_validator_replay_rejected": False,
    "patch_validator_permission_denied": False,
    "patch_validator_admission_denied": False,
    "patch_validator_timeout": True,
    "patch_validator_upstream_failed": True,
    "patch_validator_contract_invalid": False,
}


def require_terminal_error_contract(code: str, retryable: bool) -> None:
    try:
        validate_diagnostic_failure_contract(code, retryable=retryable)
        return
    except ValueError:
        pass
    if (
        code not in _WORKFLOW_FAILURE_RETRYABILITY
        or _WORKFLOW_FAILURE_RETRYABILITY[code] is not retryable
    ):
        raise RecoveryConsistencyError
