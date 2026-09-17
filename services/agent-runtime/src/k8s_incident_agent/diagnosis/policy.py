from dataclasses import dataclass
from typing import Protocol

from k8s_incident_agent.diagnosis.policy_contracts import (
    DIAGNOSTIC_TOOL_NAMES,
    PROMETHEUS_TOOL_NAME,
    DiagnosticPanel,
    investigation_capability,
)
from k8s_incident_agent.domain.contracts import IncidentSource, KubernetesTarget
from k8s_incident_agent.monitoring.catalog import AlertCatalog, AlertCatalogEntry
from k8s_incident_agent.repair.contracts import RepairAction
from k8s_incident_agent.scenarios.contracts import PublicScenario


@dataclass(frozen=True, slots=True)
class DiagnosticPolicy:
    tool_names: tuple[str, ...]
    required_evidence: frozenset[str]
    prometheus_panels: tuple[DiagnosticPanel, ...]
    trigger_panel_id: str | None = None
    repair_action: RepairAction | None = None


class DiagnosticPolicyResolver(Protocol):
    def resolve(
        self,
        source: IncidentSource,
        target: KubernetesTarget,
    ) -> DiagnosticPolicy: ...


class DiagnosticPolicyCatalog:
    """Resolve the read-only investigation policy for one Incident.

    The source only proves the Incident entered through a registered alert or
    scenario revision; the investigation capability, identity Evidence and
    admissible panels come from the verified target kind.
    """

    def __init__(
        self,
        *,
        scenarios: tuple[PublicScenario, ...],
        alerts: AlertCatalog,
    ) -> None:
        self._alerts = alerts
        self._scenario_entries: dict[tuple[str, str], AlertCatalogEntry] = {}
        for scenario in scenarios:
            entry = alerts.find(scenario.monitoring_alert_id)
            if entry is None:
                raise ValueError("Scenario monitoring policy is unavailable")
            if (scenario.target.api_version, scenario.target.kind) != (
                entry.target.api_version,
                entry.target.kind,
            ):
                raise ValueError("Scenario target does not match its alert")
            identity = (scenario.scenario_id, str(scenario.scenario_version))
            if identity in self._scenario_entries:
                raise ValueError("Scenario diagnostic policy identities are duplicated")
            self._scenario_entries[identity] = entry

    def resolve(
        self,
        source: IncidentSource,
        target: KubernetesTarget,
    ) -> DiagnosticPolicy:
        if source.type == "alertmanager":
            if source.revision != self._alerts.version:
                raise ValueError("Alert diagnostic policy revision is unavailable")
            entry = self._alerts.find(source.ref)
            if entry is None:
                raise ValueError("Alert diagnostic policy is unavailable")
        else:
            entry = self._scenario_entries.get((source.ref, source.revision))
            if entry is None:
                raise ValueError("Scenario diagnostic policy is unavailable")
        if (target.api_version, target.kind) != (
            entry.target.api_version,
            entry.target.kind,
        ):
            raise ValueError("Incident target does not match its diagnostic policy")
        capability = investigation_capability(target.api_version, target.kind)
        panels = tuple(
            DiagnosticPanel(
                panel_id=panel.panel_id,
                title=panel.title,
                unit=panel.unit,
                purpose=panel.purpose,
                series_binding=panel.series_binding,
                risk_direction=panel.risk_direction,
            )
            for panel in self._alerts.panels_for_target(target.api_version, target.kind)
        )
        trigger_panel_id = next(
            panel.panel_id for panel in entry.panels if panel.signal_role == "trigger"
        )
        return _policy(
            capability.tool_names,
            frozenset({capability.identity_evidence}),
            panels,
            trigger_panel_id,
            entry.repair_action,
        )


def _policy(
    tool_names: tuple[str, ...],
    required_evidence: frozenset[str],
    panels: tuple[DiagnosticPanel, ...],
    trigger_panel_id: str | None,
    repair_action: RepairAction | None,
) -> DiagnosticPolicy:
    ordered_tools = tuple(name for name in DIAGNOSTIC_TOOL_NAMES if name in tool_names)
    if (
        not ordered_tools
        or len(set(tool_names)) != len(tool_names)
        or len(ordered_tools) != len(tool_names)
        or not required_evidence
    ):
        raise ValueError("Diagnostic policy contract is invalid")
    if PROMETHEUS_TOOL_NAME in tool_names:
        if not panels or trigger_panel_id not in {panel.panel_id for panel in panels}:
            raise ValueError("Prometheus diagnostic policy requires panels")
    else:
        panels = ()
        trigger_panel_id = None
    return DiagnosticPolicy(
        tool_names=ordered_tools,
        required_evidence=required_evidence,
        prometheus_panels=panels,
        trigger_panel_id=trigger_panel_id,
        repair_action=repair_action,
    )
