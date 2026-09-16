from enum import StrEnum
from typing import Final, cast

from k8s_incident_agent.diagnosis.policy_contracts import (
    KUBERNETES_DIAGNOSTIC_TOOL_NAMES,
    PROMETHEUS_TOOL_NAME,
)
from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.kubernetes.errors import validate_kubernetes_failure_contract
from k8s_incident_agent.monitoring.contracts import MetricWindow
from k8s_incident_agent.monitoring.errors import validate_monitoring_failure_contract

# Bounded successful observations per Kubernetes tool, or per Prometheus panel and
# window, within one diagnosis Run. Shared by the repository gate and the Prompt so
# the model is told exactly what the server enforces.
OBSERVATION_LIMIT: Final = 2


def normalize_diagnostic_tool_call_identity(
    tool_name: str,
    value: object,
) -> dict[str, JsonValue] | None:
    if tool_name in KUBERNETES_DIAGNOSTIC_TOOL_NAMES:
        if value is not None:
            raise ValueError("Kubernetes diagnostic tools do not accept an identity")
        return None
    if tool_name != PROMETHEUS_TOOL_NAME or not isinstance(value, dict):
        raise ValueError("Diagnostic tool call identity is invalid")
    mapping = cast(dict[object, object], value)
    if set(mapping) != {"panelId", "window"}:
        raise ValueError("Prometheus tool call identity is invalid")
    panel_id = mapping.get("panelId")
    window = mapping.get("window")
    if (
        not isinstance(panel_id, str)
        or not 1 <= len(panel_id) <= 128
        or not isinstance(window, str)
    ):
        raise ValueError("Prometheus tool call identity is invalid")
    try:
        normalized_window = MetricWindow(window)
    except ValueError:
        raise ValueError("Prometheus tool call identity is invalid") from None
    return {"panelId": panel_id, "window": normalized_window.value}


def observation_limit_output(tool_name: str) -> dict[str, JsonValue]:
    """Model-facing refusal when a tool already holds its bounded observations.

    Nothing is persisted for the refused call; the attempt still consumes the
    LangChain tool budget, so a replayed Run reaches the same refusal.
    """
    return {
        "code": "observation_limit_reached",
        "retryable": False,
        "message": (
            f"{tool_name} already holds its bounded observations for this Run; "
            "this refusal is not a tool failure. Reason from the persisted Evidence "
            "instead of reading again."
        ),
    }


class DiagnosticToolFatalError(RuntimeError):
    def __init__(self, code: StrEnum | str, message: str) -> None:
        self.code = code
        self.retryable = False
        super().__init__(message)


def validate_diagnostic_tool_failure_contract(
    tool_name: str,
    error_code: str,
    *,
    retryable: bool,
) -> None:
    if tool_name in KUBERNETES_DIAGNOSTIC_TOOL_NAMES:
        validate_kubernetes_failure_contract(error_code, retryable=retryable)
        return
    if tool_name == PROMETHEUS_TOOL_NAME:
        validate_monitoring_failure_contract(error_code, retryable=retryable)
        return
    raise ValueError("Unknown diagnostic tool")


def validate_diagnostic_failure_contract(
    error_code: str,
    *,
    retryable: bool,
) -> None:
    for validator in (
        validate_kubernetes_failure_contract,
        validate_monitoring_failure_contract,
    ):
        try:
            validator(error_code, retryable=retryable)
            return
        except ValueError:
            pass
    raise ValueError("Unknown diagnostic failure")
