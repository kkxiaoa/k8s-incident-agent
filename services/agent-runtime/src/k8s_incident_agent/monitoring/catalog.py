import re
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

from k8s_incident_agent.monitoring.json import load_unique_json
from k8s_incident_agent.repair.contracts import RepairAction

_MAX_CATALOG_BYTES = 64 * 1024
_MAX_DEFAULT_PANELS = 8
# `{{range:5m}}` is a rolling interval that widens to the query step, so each
# sampled point summarises its whole step instead of the last few minutes of it.
RANGE_PLACEHOLDER = re.compile(r"\{\{range:([1-9][0-9]*)(s|m)\}\}")

type MetricSeriesBindingLiteral = Literal["target", "pod", "pod_container"]


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
        "cores",
        "bytes",
        "ratio",
        "probes",
    ]
    purpose: str = Field(min_length=1, max_length=320)
    producer: Literal[
        "kube-state-metrics",
        "kubelet-resource",
        "kubelet-cadvisor",
        "kubelet-probes",
    ]
    series_binding: MetricSeriesBindingLiteral
    threshold: float | None = Field(allow_inf_nan=False)
    risk_direction: Literal["higher_is_worse", "lower_is_worse", "neutral"]
    threshold_duration: str | None = Field(
        pattern=r"^[1-9][0-9]*(?:ms|s|m|h)$",
    )
    signal_role: Literal["trigger", "context"]
    recommended_window: Literal["15m", "1h", "6h", "7d", "15d"]
    stale_after_seconds: int = Field(ge=15, le=300)
    query_template: str = Field(min_length=1, max_length=16 * 1024)

    @field_validator("title", "purpose", "query_template")
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
        without_supported = RANGE_PLACEHOLDER.sub(
            "", value.replace("{{namespace}}", "").replace("{{name}}", "")
        )
        if "{{" in without_supported or "}}" in without_supported:
            raise ValueError("Metric query template contains an unknown placeholder")
        return value

    @model_validator(mode="after")
    def require_threshold_shape(self) -> Self:
        if self.risk_direction == "higher_is_worse" and self.threshold is None:
            raise ValueError("Higher-is-worse panels require a static threshold")
        if self.risk_direction == "neutral" and self.threshold is not None:
            raise ValueError("Neutral panels cannot carry a risk threshold")
        return self


class AlertCatalogEntry(_CatalogContract):
    alert_id: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=128)
    display_name: str = Field(min_length=1, max_length=160)
    trigger_summary: str = Field(min_length=1, max_length=512)
    rule: AlertRuleContract
    target: AlertTargetMapping
    repair_action: RepairAction | None = None
    panels: list[MetricPanelContract] = Field(
        min_length=1, max_length=_MAX_DEFAULT_PANELS
    )

    @field_validator("display_name", "trigger_summary")
    @classmethod
    def require_normalized_text(cls, value: str) -> str:
        return _require_normalized(value)

    @model_validator(mode="after")
    def require_trigger_and_repair_consistency(self) -> Self:
        trigger_panels = [
            panel for panel in self.panels if panel.signal_role == "trigger"
        ]
        if len(trigger_panels) != 1:
            raise ValueError("Alert entries require exactly one trigger panel")
        if trigger_panels[0].threshold_duration != self.rule.for_duration:
            raise ValueError("Trigger panel duration must match the alert rule")
        if trigger_panels[0].series_binding != "target":
            raise ValueError("Trigger panels must aggregate over the alert target")
        if self.repair_action is not None and (
            self.target.api_version != "apps/v1" or self.target.kind != "Deployment"
        ):
            raise ValueError("Repair action requires a Deployment target")
        return self


class ContextPanelTarget(_CatalogContract):
    api_version: str = Field(min_length=1, max_length=32)
    kind: str = Field(min_length=1, max_length=64)

    @field_validator("api_version", "kind")
    @classmethod
    def require_normalized_value(cls, value: str) -> str:
        return _require_normalized(value)


class ContextPanelGroup(_CatalogContract):
    """Context panels admitted for every Incident of one target kind.

    They describe the target's resources and lifecycle rather than one alert's
    condition, so they never carry an alert duration and never act as trigger.
    """

    target: ContextPanelTarget
    panels: list[MetricPanelContract] = Field(
        min_length=1, max_length=_MAX_DEFAULT_PANELS
    )

    @model_validator(mode="after")
    def require_context_panels(self) -> Self:
        if any(
            panel.signal_role != "context" or panel.threshold_duration is not None
            for panel in self.panels
        ):
            raise ValueError("Context panel groups admit only duration-free context")
        return self


class _AlertCatalogDocument(_CatalogContract):
    schema_version: Literal[10]
    catalog_version: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    )
    alerts: list[AlertCatalogEntry] = Field(min_length=1, max_length=64)
    context_panels: list[ContextPanelGroup] = Field(max_length=8)


@dataclass(frozen=True, slots=True)
class AlertCatalog:
    version: str
    entries: tuple[AlertCatalogEntry, ...]
    context_groups: tuple[ContextPanelGroup, ...]

    def find(self, alert_id: str) -> AlertCatalogEntry | None:
        return next(
            (entry for entry in self.entries if entry.alert_id == alert_id), None
        )

    def find_panel(self, panel_id: str) -> MetricPanelContract | None:
        return next(
            (panel for panel in self._all_panels() if panel.panel_id == panel_id),
            None,
        )

    @property
    def panel_ids(self) -> tuple[str, ...]:
        return tuple(panel.panel_id for panel in self._all_panels())

    def context_panels(
        self,
        api_version: str,
        kind: str,
    ) -> tuple[MetricPanelContract, ...]:
        return tuple(
            panel
            for group in self.context_groups
            if group.target.api_version == api_version and group.target.kind == kind
            for panel in group.panels
        )

    def panels_for_target(
        self,
        api_version: str,
        kind: str,
    ) -> tuple[MetricPanelContract, ...]:
        """Registered panels the Runtime admits for one target kind.

        Diagnostic policy and the Prometheus query boundary must share this set so
        the Prompt never lists a panel the server would refuse, and vice versa.
        """
        return (
            *(
                panel
                for entry in self.entries
                if entry.target.api_version == api_version and entry.target.kind == kind
                for panel in entry.panels
            ),
            *self.context_panels(api_version, kind),
        )

    def default_panels(
        self,
        entry: AlertCatalogEntry,
    ) -> tuple[MetricPanelContract, ...]:
        """Panels the Console lists for an Incident that entered through ``entry``.

        The alert's own trigger/context panels come first, then the target kind's
        context panels; ``load_alert_catalog`` bounds the union to eight.
        """
        return (
            *entry.panels,
            *self.context_panels(entry.target.api_version, entry.target.kind),
        )

    def _all_panels(self) -> tuple[MetricPanelContract, ...]:
        return (
            *(panel for entry in self.entries for panel in entry.panels),
            *(panel for group in self.context_groups for panel in group.panels),
        )


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
    entry_kinds = set[tuple[str, str]]()
    for entry in document.alerts:
        labels = {
            entry.target.cluster_label,
            entry.target.namespace_label,
            entry.target.name_label,
        }
        if len(labels) != 3:
            raise ValueError("Alert catalog target labels must be distinct")
        entry_kinds.add((entry.target.api_version, entry.target.kind))
    context_kinds = [
        (group.target.api_version, group.target.kind)
        for group in document.context_panels
    ]
    if len(set(context_kinds)) != len(context_kinds):
        raise ValueError("Alert catalog repeats a context panel target kind")
    if any(kind not in entry_kinds for kind in context_kinds):
        raise ValueError("Alert catalog context panels need an alert for their kind")
    catalog = AlertCatalog(
        version=document.catalog_version,
        entries=tuple(document.alerts),
        context_groups=tuple(document.context_panels),
    )
    panel_ids = catalog.panel_ids
    if len(set(panel_ids)) != len(panel_ids):
        raise ValueError("Alert catalog contains duplicate panel identifiers")
    if any(
        len(catalog.default_panels(entry)) > _MAX_DEFAULT_PANELS
        for entry in catalog.entries
    ):
        raise ValueError("Alert catalog default panels exceed the bounded set")
    return catalog


def _require_normalized(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        raise ValueError("Catalog text must be normalized")
    return value
