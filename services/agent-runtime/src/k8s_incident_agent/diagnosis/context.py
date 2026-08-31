from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from k8s_incident_agent.domain.models import AgentRunSnapshot
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import DeploymentTarget
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredentialLease
from k8s_incident_agent.persistence.repositories import IncidentRepository


@dataclass(frozen=True, slots=True)
class DiagnosticToolContext:
    run: AgentRunSnapshot
    target: DeploymentTarget
    credential: DiagnosticCredentialLease
    adapter: KubernetesEvidenceAdapter
    repository: IncidentRepository
    now: Callable[[], datetime]
