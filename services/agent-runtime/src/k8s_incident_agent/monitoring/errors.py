from enum import StrEnum


class AlertAuthenticationError(RuntimeError):
    pass


class AlertPayloadTooLargeError(RuntimeError):
    pass


class AlertPayloadInvalidError(RuntimeError):
    pass


class AlertPayloadTruncatedError(RuntimeError):
    pass


class AlertTargetInvalidError(RuntimeError):
    pass


class MonitoringErrorCode(StrEnum):
    REQUEST_TIMEOUT = "monitoring_request_timeout"
    UNAVAILABLE = "monitoring_unavailable"
    QUERY_FAILED = "prometheus_query_error"
    UPSTREAM_CONTRACT_INVALID = "prometheus_contract_invalid"
    RESULT_BUDGET_EXCEEDED = "prometheus_result_budget_exceeded"
    PANEL_NOT_FOUND = "monitoring_panel_not_found"
    TARGET_UNSUPPORTED = "monitoring_target_unsupported"


_RETRYABLE_MONITORING_CODES = {
    MonitoringErrorCode.REQUEST_TIMEOUT,
    MonitoringErrorCode.UNAVAILABLE,
}

_SAFE_MONITORING_MESSAGES = {
    MonitoringErrorCode.REQUEST_TIMEOUT: "Prometheus request timed out",
    MonitoringErrorCode.UNAVAILABLE: "Prometheus is unavailable",
    MonitoringErrorCode.QUERY_FAILED: "Prometheus query failed",
    MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID: (
        "Prometheus returned an unsupported response"
    ),
    MonitoringErrorCode.RESULT_BUDGET_EXCEEDED: (
        "Prometheus result exceeded the configured budget"
    ),
    MonitoringErrorCode.PANEL_NOT_FOUND: "Monitoring panel is not supported",
    MonitoringErrorCode.TARGET_UNSUPPORTED: "Monitoring target is not supported",
}


class MonitoringBoundaryError(RuntimeError):
    def __init__(self, code: MonitoringErrorCode) -> None:
        self.code = code
        self.retryable = code in _RETRYABLE_MONITORING_CODES
        super().__init__(_SAFE_MONITORING_MESSAGES[code])


def validate_monitoring_failure_contract(
    error_code: str,
    *,
    retryable: bool,
) -> MonitoringErrorCode:
    try:
        code = MonitoringErrorCode(error_code)
    except ValueError:
        raise ValueError(
            "Monitoring failure contract has an invalid error code"
        ) from None
    if (code in _RETRYABLE_MONITORING_CODES) is not retryable:
        raise ValueError("Monitoring failure contract has invalid retryability")
    return code
