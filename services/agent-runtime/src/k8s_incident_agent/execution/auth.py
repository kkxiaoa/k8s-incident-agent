from typing import Final

from k8s_incident_agent.internal_auth import HmacChannel

CLAIM_CHANNEL: Final = HmacChannel(
    "k8s-incident-agent.executor.claim.request.v1",
    "k8s-incident-agent.executor.claim.response.v1",
    "/internal/v1/executions/claim",
)
REPORT_CHANNEL: Final = HmacChannel(
    "k8s-incident-agent.executor.report.request.v1",
    "k8s-incident-agent.executor.report.response.v1",
    "/internal/v1/executions/report",
)
TIMESTAMP_HEADER: Final = "X-K8s-Incident-Timestamp"
NONCE_HEADER: Final = "X-K8s-Incident-Nonce"
SIGNATURE_HEADER: Final = "X-K8s-Incident-Signature"
RESPONSE_SIGNATURE_HEADER: Final = "X-K8s-Incident-Response-Signature"
BODY_LIMIT: Final = 16 * 1024
HTTP_TIMEOUT_SECONDS: Final = 10
