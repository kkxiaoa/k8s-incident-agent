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
