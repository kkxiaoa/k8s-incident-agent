from collections.abc import Collection
from typing import Final, Literal

type DiagnosticToolName = Literal[
    "get_workload",
    "get_pods",
    "get_events",
    "get_container_logs",
    "get_service_network",
    "get_pvc_storage",
    "query_prometheus",
]
type DiagnosticEvidenceKind = Literal[
    "workload",
    "pods",
    "events",
    "container_logs",
    "service_network",
    "pvc_storage",
    "metrics",
]

KUBERNETES_DIAGNOSTIC_TOOL_NAMES: Final[tuple[DiagnosticToolName, ...]] = (
    "get_workload",
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
DIAGNOSTIC_EVIDENCE_TOOL_NAMES: Final[
    tuple[tuple[DiagnosticEvidenceKind, DiagnosticToolName], ...]
] = (
    ("workload", "get_workload"),
    ("pods", "get_pods"),
    ("events", "get_events"),
    ("container_logs", "get_container_logs"),
    ("service_network", "get_service_network"),
    ("pvc_storage", "get_pvc_storage"),
    ("metrics", "query_prometheus"),
)
DIAGNOSTIC_EVIDENCE_KINDS: Final[frozenset[DiagnosticEvidenceKind]] = frozenset(
    evidence_kind for evidence_kind, _ in DIAGNOSTIC_EVIDENCE_TOOL_NAMES
)


def validate_diagnostic_policy_contract(
    tool_names: Collection[str],
    required_evidence: Collection[str],
) -> None:
    tools = set(tool_names)
    evidence = set(required_evidence)
    if (
        not tools
        or len(tools) != len(tool_names)
        or not tools.issubset(DIAGNOSTIC_TOOL_NAMES)
        or not evidence
        or len(evidence) != len(required_evidence)
        or not evidence.issubset(DIAGNOSTIC_EVIDENCE_KINDS)
        or any(
            required_tool not in tools
            for evidence_kind, required_tool in DIAGNOSTIC_EVIDENCE_TOOL_NAMES
            if evidence_kind in evidence
        )
    ):
        raise ValueError("Diagnostic policy contract is invalid")
