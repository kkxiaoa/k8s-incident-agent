from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from k8s_incident_agent.diagnosis.policy_contracts import (
    DiagnosticEvidenceKind,
    DiagnosticToolName,
    validate_diagnostic_policy_contract,
)
from k8s_incident_agent.monitoring.json import load_unique_json
from k8s_incident_agent.repair.contracts import RepairAction

_MAX_CATALOG_BYTES = 64 * 1024


class _CatalogContract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        frozen=True,
        strict=True,
    )


class AlertTargetMapping(_CatalogContract):
    api_version: str = Field(min_length=1, max_length=32)
    kind: str = Field(min_length=1, max_length=64)
    cluster_label: str = Field(
        max_length=128,
        pattern=r"^[A-Za-z_][A-Za-z0-9_]*$",
    )
    namespace_label: str = Field(
        max_length=128,
        pattern=r"^[A-Za-z_][A-Za-z0-9_]*$",
    )
    name_label: str = Field(
        max_length=128,
        pattern=r"^[A-Za-z_][A-Za-z0-9_]*$",
    )

    @field_validator("api_version", "kind")
    @classmethod
    def require_normalized_value(cls, value: str) -> str:
        return _require_normalized(value)


class AlertRuleContract(_CatalogContract):
    expression: str = Field(min_length=1, max_length=4096)
    for_duration: str = Field(alias="for", pattern=r"^[1-9][0-9]*(?:ms|s|m|h)$")
    keep_firing_for: str | None = Field(
        default=None,
        pattern=r"^[1-9][0-9]*(?:ms|s|m|h)$",
    )

    @field_validator("expression")
    @classmethod
    def require_normalized_expression(cls, value: str) -> str:
        return _require_normalized(value)


class MetricPanelContract(_CatalogContract):
    panel_id: str = Field(
        pattern=r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
        max_length=128,
    )
    title: str = Field(min_length=1, max_length=160)
    unit: Literal[
        "pods",
        "containers",
        "replicas",
        "restarts",
        "endpoints",
        "claims",
        "seconds",
    ]
    threshold: float | None = Field(allow_inf_nan=False)
    risk_direction: Literal["higher_is_worse", "lower_is_worse"]
    threshold_duration: str | None = Field(
        pattern=r"^[1-9][0-9]*(?:ms|s|m|h)$",
    )
    signal_role: Literal["trigger", "context"]
    recommended_window: Literal["15m", "1h", "6h", "7d", "15d"]
    stale_after_seconds: int = Field(ge=15, le=300)
    query_template: str = Field(min_length=1, max_length=16 * 1024)

    @field_validator("title", "query_template")
    @classmethod
    def require_normalized_panel_text(cls, value: str) -> str:
        return _require_normalized(value)

    @field_validator("query_template")
    @classmethod
    def require_exact_target_placeholders(cls, value: str) -> str:
        for placeholder in ("{{namespace}}", "{{name}}"):
            if placeholder not in value:
                raise ValueError(
                    "Metric query template is missing a target placeholder"
                )
        without_supported = value.replace("{{namespace}}", "").replace("{{name}}", "")
        if "{{" in without_supported or "}}" in without_supported:
            raise ValueError("Metric query template contains an unknown placeholder")
        return value

    @model_validator(mode="after")
    def require_threshold_for_higher_risk(self) -> Self:
        if self.risk_direction == "higher_is_worse" and self.threshold is None:
            raise ValueError("Higher-is-worse panels require a static threshold")
        return self


class AlertCatalogEntry(_CatalogContract):
    alert_id: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=128)
    display_name: str = Field(min_length=1, max_length=160)
    trigger_summary: str = Field(min_length=1, max_length=512)
    rule: AlertRuleContract
    target: AlertTargetMapping
    allowed_tools: list[DiagnosticToolName] = Field(min_length=1, max_length=5)
    required_evidence: list[DiagnosticEvidenceKind] = Field(min_length=1, max_length=5)
    repair_action: RepairAction | None = None
    panels: list[MetricPanelContract] = Field(min_length=1, max_length=8)

    @field_validator("display_name", "trigger_summary")
    @classmethod
    def require_normalized_text(cls, value: str) -> str:
        return _require_normalized(value)

    @model_validator(mode="after")
    def require_diagnostic_policy_consistency(self) -> Self:
        validate_diagnostic_policy_contract(
            self.allowed_tools,
            self.required_evidence,
        )
        trigger_panels = [
            panel for panel in self.panels if panel.signal_role == "trigger"
        ]
        if len(trigger_panels) != 1:
            raise ValueError("Alert entries require exactly one trigger panel")
        if trigger_panels[0].threshold_duration != self.rule.for_duration:
            raise ValueError("Trigger panel duration must match the alert rule")
        if self.repair_action is not None and (
            self.target.api_version != "apps/v1"
            or self.target.kind != "Deployment"
            or not {"workload", "rollout_history"}.issubset(self.required_evidence)
            or "get_rollout_history" not in self.allowed_tools
        ):
            raise ValueError("Repair action requires Deployment rollout Evidence")
        return self


class _AlertCatalogDocument(_CatalogContract):
    schema_version: Literal[8]
    catalog_version: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    )
    alerts: list[AlertCatalogEntry] = Field(min_length=1, max_length=64)


@dataclass(frozen=True, slots=True)
class AlertCatalog:
    version: str
    entries: tuple[AlertCatalogEntry, ...]

    def find(self, alert_id: str) -> AlertCatalogEntry | None:
        return next(
            (entry for entry in self.entries if entry.alert_id == alert_id), None
        )

    def find_panel(
        self,
        panel_id: str,
    ) -> tuple[AlertCatalogEntry, MetricPanelContract] | None:
        for entry in self.entries:
            for panel in entry.panels:
                if panel.panel_id == panel_id:
                    return entry, panel
        return None

    @property
    def panel_ids(self) -> tuple[str, ...]:
        return tuple(panel.panel_id for entry in self.entries for panel in entry.panels)


def load_alert_catalog(directory: Path) -> AlertCatalog:
    path = directory / "catalog.json"
    try:
        with path.open("rb") as catalog_file:
            payload = catalog_file.read(_MAX_CATALOG_BYTES + 1)
    except OSError:
        raise ValueError("Alert catalog could not be read") from None
    if not payload or len(payload) > _MAX_CATALOG_BYTES:
        raise ValueError("Alert catalog size is invalid")
    try:
        document = _AlertCatalogDocument.model_validate(load_unique_json(payload))
    except (ValidationError, ValueError):
        raise ValueError("Alert catalog contract is invalid") from None
    alert_ids = [entry.alert_id for entry in document.alerts]
    if len(set(alert_ids)) != len(alert_ids):
        raise ValueError("Alert catalog contains duplicate alert identifiers")
    for entry in document.alerts:
        labels = {
            entry.target.cluster_label,
            entry.target.namespace_label,
            entry.target.name_label,
        }
        if len(labels) != 3:
            raise ValueError("Alert catalog target labels must be distinct")
    panel_ids = [panel.panel_id for entry in document.alerts for panel in entry.panels]
    if len(set(panel_ids)) != len(panel_ids):
        raise ValueError("Alert catalog contains duplicate panel identifiers")
    return AlertCatalog(
        version=document.catalog_version, entries=tuple(document.alerts)
    )


def _require_normalized(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        raise ValueError("Catalog text must be normalized")
    return value
