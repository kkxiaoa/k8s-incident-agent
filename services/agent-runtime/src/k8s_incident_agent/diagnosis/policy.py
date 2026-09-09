from dataclasses import dataclass
from typing import Protocol

from k8s_incident_agent.diagnosis.policy_contracts import (
    DIAGNOSTIC_TOOL_NAMES,
    validate_diagnostic_policy_contract,
)
from k8s_incident_agent.domain.contracts import IncidentSource
from k8s_incident_agent.monitoring.catalog import AlertCatalog
from k8s_incident_agent.repair.contracts import RepairAction
from k8s_incident_agent.scenarios.contracts import PublicScenario


@dataclass(frozen=True, slots=True)
class DiagnosticPolicy:
    tool_names: tuple[str, ...]
    required_evidence: frozenset[str]
    prometheus_panel_ids: tuple[str, ...]
    repair_action: RepairAction | None = None


class DiagnosticPolicyResolver(Protocol):
    def resolve(self, source: IncidentSource) -> DiagnosticPolicy: ...


class DiagnosticPolicyCatalog:
    def __init__(
        self,
        *,
        scenarios: tuple[PublicScenario, ...],
        alerts: AlertCatalog,
    ) -> None:
        self._alert_revision = alerts.version
        self._alert_policies = {
            entry.alert_id: _policy(
                tuple(entry.allowed_tools),
                frozenset(entry.required_evidence),
                tuple(
                    panel.panel_id
                    for panel in entry.panels
                    if panel.signal_role == "trigger"
                ),
                entry.repair_action,
            )
            for entry in alerts.entries
        }
        self._scenario_policies: dict[tuple[str, str], DiagnosticPolicy] = {}
        for scenario in scenarios:
            identity = (scenario.scenario_id, str(scenario.scenario_version))
            alert_policy = self._alert_policies.get(scenario.monitoring_alert_id)
            if alert_policy is None:
                raise ValueError("Scenario monitoring policy is unavailable")
            scenario_policy = _policy(
                scenario.allowed_tools,
                frozenset(scenario.required_evidence),
                alert_policy.prometheus_panel_ids,
                alert_policy.repair_action,
            )
            if scenario_policy != alert_policy:
                raise ValueError("Scenario diagnostic policy does not match its alert")
            self._scenario_policies[identity] = scenario_policy
        if len(self._scenario_policies) != len(scenarios):
            raise ValueError("Scenario diagnostic policy identities are duplicated")

    def resolve(self, source: IncidentSource) -> DiagnosticPolicy:
        if source.type == "alertmanager":
            if source.revision != self._alert_revision:
                raise ValueError("Alert diagnostic policy revision is unavailable")
            policy = self._alert_policies.get(source.ref)
            if policy is None:
                raise ValueError("Alert diagnostic policy is unavailable")
            return policy

        policy = self._scenario_policies.get((source.ref, source.revision))
        if policy is None:
            raise ValueError("Scenario diagnostic policy is unavailable")
        return policy


def _policy(
    configured_tools: tuple[str, ...],
    required_evidence: frozenset[str],
    panel_ids: tuple[str, ...],
    repair_action: RepairAction | None,
) -> DiagnosticPolicy:
    validate_diagnostic_policy_contract(configured_tools, required_evidence)
    configured = set(configured_tools)
    ordered_tools = tuple(name for name in DIAGNOSTIC_TOOL_NAMES if name in configured)
    if "query_prometheus" in configured:
        if not panel_ids:
            raise ValueError("Prometheus diagnostic policy requires panels")
    else:
        panel_ids = ()
    return DiagnosticPolicy(
        tool_names=ordered_tools,
        required_evidence=required_evidence,
        prometheus_panel_ids=panel_ids,
        repair_action=repair_action,
    )
