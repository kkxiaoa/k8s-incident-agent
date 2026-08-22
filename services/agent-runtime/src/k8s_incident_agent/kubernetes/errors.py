from enum import StrEnum
from typing import Protocol, cast

import aiohttp
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
)


class KubernetesErrorCode(StrEnum):
    AUTHENTICATION_FAILED = "authentication_failed"
    PERMISSION_DENIED = "permission_denied"
    RESOURCE_NOT_FOUND = "resource_not_found"
    REQUEST_TIMEOUT = "request_timeout"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    UPSTREAM_CONTRACT_INVALID = "upstream_contract_invalid"
    RESULT_BUDGET_EXCEEDED = "result_budget_exceeded"
    RECOVERY_CONSISTENCY_ERROR = "recovery_consistency_error"


_RETRYABLE_CODES = {
    KubernetesErrorCode.REQUEST_TIMEOUT,
    KubernetesErrorCode.UPSTREAM_UNAVAILABLE,
}

_SAFE_MESSAGES = {
    KubernetesErrorCode.AUTHENTICATION_FAILED: "Kubernetes authentication failed",
    KubernetesErrorCode.PERMISSION_DENIED: "Kubernetes access was denied",
    KubernetesErrorCode.RESOURCE_NOT_FOUND: "Kubernetes resource was not found",
    KubernetesErrorCode.REQUEST_TIMEOUT: "Kubernetes request timed out",
    KubernetesErrorCode.UPSTREAM_UNAVAILABLE: "Kubernetes API is unavailable",
    KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID: (
        "Kubernetes API returned an unsupported response"
    ),
    KubernetesErrorCode.RESULT_BUDGET_EXCEEDED: (
        "Kubernetes result exceeded the configured budget"
    ),
    KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR: (
        "Persisted tool state is inconsistent"
    ),
}


class _ApiExceptionView(Protocol):
    status: object


class KubernetesBoundaryError(RuntimeError):
    def __init__(self, code: KubernetesErrorCode) -> None:
        self.code = code
        self.retryable = code in _RETRYABLE_CODES
        super().__init__(_SAFE_MESSAGES[code])


def map_kubernetes_exception(
    error: Exception,
    *,
    resource_not_found: bool = False,
) -> KubernetesBoundaryError:
    if isinstance(error, KubernetesBoundaryError):
        return error
    if isinstance(error, TimeoutError):
        return KubernetesBoundaryError(KubernetesErrorCode.REQUEST_TIMEOUT)
    if isinstance(error, ApiException):
        status = cast(_ApiExceptionView, error).status
        if status == 401:
            code = KubernetesErrorCode.AUTHENTICATION_FAILED
        elif status == 403:
            code = KubernetesErrorCode.PERMISSION_DENIED
        elif status == 404 and resource_not_found:
            code = KubernetesErrorCode.RESOURCE_NOT_FOUND
        elif (
            status == 0
            or status == 429
            or (isinstance(status, int) and 500 <= status <= 599)
        ):
            code = KubernetesErrorCode.UPSTREAM_UNAVAILABLE
        else:
            code = KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
        return KubernetesBoundaryError(code)
    if isinstance(error, (aiohttp.ClientError, OSError)):
        return KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_UNAVAILABLE)
    return KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID)
