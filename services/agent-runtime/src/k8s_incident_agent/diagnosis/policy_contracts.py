from dataclasses import dataclass
from typing import Final, Literal

type DiagnosticToolName = Literal[
    "get_workload",
    "get_rollout_history",
    "get_pods",
    "get_events",
    "get_container_logs",
    "get_service_network",
    "get_pvc_storage",
    "query_prometheus",
]
type DiagnosticEvidenceKind = Literal[
    "workload",
    "rollout_history",
    "pods",
    "events",
    "container_logs",
    "service_network",
    "pvc_storage",
    "metrics",
]

KUBERNETES_DIAGNOSTIC_TOOL_NAMES: Final[tuple[DiagnosticToolName, ...]] = (
    "get_workload",
    "get_rollout_history",
    "get_pods",
    "get_events",
    "get_container_logs",
    "get_service_network",
    "get_pvc_storage",
)
PROMETHEUS_TOOL_NAME: Final[DiagnosticToolName] = "query_prometheus"
DIAGNOSTIC_TOOL_NAMES: Final[tuple[DiagnosticToolName, ...]] = (
    *KUBERNETES_DIAGNOSTIC_TOOL_NAMES,
    PROMETHEUS_TOOL_NAME,
)


@dataclass(frozen=True, slots=True)
class DiagnosticPanel:
    """Catalog panel the model may query, with the meaning it needs to choose it."""

    panel_id: str
    title: str
    unit: str


@dataclass(frozen=True, slots=True)
class TargetInvestigationCapability:
    """Read-only capability the Runtime grants to one Incident target kind.

    The alert that discovered the symptom no longer bounds the tool set; the
    target's resource kind and its fixed authorised scope do. ``identity_evidence``
    is the one Evidence kind every diagnosed conclusion must cite so it is anchored
    to the exact target the Run observed.
    """

    tool_names: tuple[DiagnosticToolName, ...]
    identity_evidence: DiagnosticEvidenceKind


_TARGET_CAPABILITIES: Final[dict[tuple[str, str], TargetInvestigationCapability]] = {
    ("apps/v1", "Deployment"): TargetInvestigationCapability(
        tool_names=(
            "get_workload",
            "get_rollout_history",
            "get_pods",
            "get_events",
            "get_container_logs",
            "query_prometheus",
        ),
        identity_evidence="workload",
    ),
    ("v1", "Service"): TargetInvestigationCapability(
        tool_names=("get_service_network", "query_prometheus"),
        identity_evidence="service_network",
    ),
    ("v1", "PersistentVolumeClaim"): TargetInvestigationCapability(
        tool_names=("get_pvc_storage", "query_prometheus"),
        identity_evidence="pvc_storage",
    ),
}


def investigation_capability(
    api_version: str,
    kind: str,
) -> TargetInvestigationCapability:
    capability = _TARGET_CAPABILITIES.get((api_version, kind))
    if capability is None:
        raise ValueError("Target kind has no diagnostic investigation capability")
    return capability
