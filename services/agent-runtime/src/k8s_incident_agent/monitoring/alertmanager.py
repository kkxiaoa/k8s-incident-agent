from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from pydantic.alias_generators import to_camel

from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
)
from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    CanonicalAlertTimestamp,
    NormalizedAlertOccurrence,
)
from k8s_incident_agent.monitoring.catalog import AlertCatalog, AlertCatalogEntry
from k8s_incident_agent.monitoring.errors import (
    AlertPayloadInvalidError,
    AlertPayloadTooLargeError,
    AlertPayloadTruncatedError,
    AlertTargetInvalidError,
)
from k8s_incident_agent.monitoring.json import load_unique_json

MAX_WEBHOOK_BODY_BYTES = 256 * 1024
MAX_WEBHOOK_ALERTS = 50

_MAX_MAP_ENTRIES = 64
_MAX_MAP_KEY_LENGTH = 128
_MAX_MAP_VALUE_LENGTH = 4096
_MAX_STRING_LENGTH = 4096
_FINGERPRINT = re.compile(r"^[0-9a-f]{16}$")
_RFC3339_UTC = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(?P<fraction>\d{1,9}))?Z$"
)


class _WebhookContract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        frozen=True,
        strict=True,
    )


class AlertmanagerAlert(_WebhookContract):
    status: Literal["firing", "resolved"]
    labels: dict[str, str] = Field(max_length=_MAX_MAP_ENTRIES)
    annotations: dict[str, str] = Field(max_length=_MAX_MAP_ENTRIES)
    starts_at: CanonicalAlertTimestamp
    ends_at: CanonicalAlertTimestamp
    generator_url: str = Field(
        alias="generatorURL",
        max_length=_MAX_STRING_LENGTH,
    )
    fingerprint: str

    @field_validator("starts_at", "ends_at")
    @classmethod
    def normalize_rfc3339_timestamp(cls, value: str) -> CanonicalAlertTimestamp:
        return _normalize_rfc3339_utc(value)

    @field_validator("fingerprint")
    @classmethod
    def require_fingerprint(cls, value: str) -> str:
        if _FINGERPRINT.fullmatch(value) is None:
            raise ValueError("fingerprint is invalid")
        return value


class AlertmanagerWebhook(_WebhookContract):
    version: Literal["4"]
    group_key: str = Field(max_length=_MAX_STRING_LENGTH)
    truncated_alerts: int = Field(ge=0)
    status: Literal["firing", "resolved"]
    receiver: str = Field(max_length=_MAX_STRING_LENGTH)
    group_labels: dict[str, str] = Field(max_length=_MAX_MAP_ENTRIES)
    common_labels: dict[str, str] = Field(max_length=_MAX_MAP_ENTRIES)
    common_annotations: dict[str, str] = Field(max_length=_MAX_MAP_ENTRIES)
    route_labels: dict[str, str] = Field(max_length=_MAX_MAP_ENTRIES)
    external_url: str = Field(alias="externalURL", max_length=_MAX_STRING_LENGTH)
    notification_reason: str = Field(
        alias="notification_reason",
        max_length=_MAX_STRING_LENGTH,
    )
    alerts: list[AlertmanagerAlert] = Field(
        min_length=1,
        max_length=MAX_WEBHOOK_ALERTS,
    )


@dataclass(frozen=True, slots=True)
class ParsedAlertmanagerWebhook:
    occurrences: tuple[NormalizedAlertOccurrence, ...]
    watchdog_firing: bool


def parse_alertmanager_webhook(
    payload: bytes,
    *,
    catalog: AlertCatalog,
    cluster_id: str,
    diagnostic_namespace: str,
) -> ParsedAlertmanagerWebhook:
    try:
        raw_document = load_unique_json(payload)
        _require_json_budget(raw_document)
        document = AlertmanagerWebhook.model_validate(raw_document)
    except AlertPayloadTooLargeError:
        raise
    except (AlertPayloadInvalidError, ValidationError, ValueError):
        raise AlertPayloadInvalidError from None
    if document.truncated_alerts > 0:
        raise AlertPayloadTruncatedError

    occurrences: dict[
        tuple[str, CanonicalAlertTimestamp], NormalizedAlertOccurrence
    ] = {}
    watchdog_firing = False
    for alert in document.alerts:
        alert_name = alert.labels.get("alertname", "")
        if alert_name == "Watchdog":
            _require_managed_watchdog(alert, cluster_id=cluster_id)
            watchdog_firing = watchdog_firing or alert.status == "firing"
            continue
        entry = catalog.find(alert_name)
        if entry is None:
            continue
        occurrence = _normalize_supported_alert(
            alert,
            entry=entry,
            catalog_version=catalog.version,
            cluster_id=cluster_id,
            diagnostic_namespace=diagnostic_namespace,
        )
        key = (occurrence.fingerprint, occurrence.starts_at)
        previous = occurrences.get(key)
        occurrences[key] = (
            occurrence if previous is None else _merge_occurrence(previous, occurrence)
        )
    return ParsedAlertmanagerWebhook(
        occurrences=tuple(occurrences.values()),
        watchdog_firing=watchdog_firing,
    )


def _require_managed_watchdog(
    alert: AlertmanagerAlert,
    *,
    cluster_id: str,
) -> None:
    if (
        alert.labels.get("cluster") != cluster_id
        or alert.labels.get("severity") != "none"
    ):
        raise AlertTargetInvalidError


def _normalize_supported_alert(
    alert: AlertmanagerAlert,
    *,
    entry: AlertCatalogEntry,
    catalog_version: str,
    cluster_id: str,
    diagnostic_namespace: str,
) -> NormalizedAlertOccurrence:
    mapping = entry.target
    try:
        target = KubernetesTarget(
            cluster=alert.labels[mapping.cluster_label],
            namespace=alert.labels[mapping.namespace_label],
            api_version=mapping.api_version,
            kind=mapping.kind,
            name=alert.labels[mapping.name_label],
        )
    except (KeyError, ValidationError):
        raise AlertTargetInvalidError from None
    if target.cluster != cluster_id or target.namespace != diagnostic_namespace:
        raise AlertTargetInvalidError

    starts_at = alert.starts_at
    status = AlertSignalStatus(alert.status.upper())
    ends_at = None
    if status is AlertSignalStatus.RESOLVED:
        ends_at = alert.ends_at
        if ends_at < starts_at:
            raise AlertPayloadInvalidError
    return NormalizedAlertOccurrence(
        trigger=NormalizedIncidentTrigger(
            source=IncidentSource(
                type="alertmanager",
                ref=entry.alert_id,
                revision=catalog_version,
            ),
            display_name=entry.display_name,
            trigger_summary=entry.trigger_summary,
            target=target,
        ),
        fingerprint=alert.fingerprint,
        starts_at=starts_at,
        status=status,
        ends_at=ends_at,
    )


def _merge_occurrence(
    previous: NormalizedAlertOccurrence,
    current: NormalizedAlertOccurrence,
) -> NormalizedAlertOccurrence:
    if previous.trigger != current.trigger:
        raise AlertTargetInvalidError
    if previous.status is AlertSignalStatus.RESOLVED:
        if current.status is AlertSignalStatus.FIRING:
            return previous
        return _resolved_with_latest_end(previous, current)
    if current.status is AlertSignalStatus.FIRING:
        return previous
    return current


def _resolved_with_latest_end(
    previous: NormalizedAlertOccurrence,
    current: NormalizedAlertOccurrence,
) -> NormalizedAlertOccurrence:
    if previous.ends_at is None or current.ends_at is None:
        raise AlertPayloadInvalidError
    return previous if previous.ends_at >= current.ends_at else current


def _require_json_budget(value: object) -> None:
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            mapping = cast(dict[object, object], current)
            if len(mapping) > _MAX_MAP_ENTRIES:
                raise AlertPayloadTooLargeError
            for key, item in mapping.items():
                if not isinstance(key, str):
                    raise AlertPayloadInvalidError
                _require_external_string(key, maximum=_MAX_MAP_KEY_LENGTH, key=True)
                pending.append(item)
        elif isinstance(current, list):
            sequence = cast(list[object], current)
            if len(sequence) > MAX_WEBHOOK_ALERTS:
                raise AlertPayloadTooLargeError
            pending.extend(sequence)
        elif isinstance(current, str):
            _require_external_string(current, maximum=_MAX_MAP_VALUE_LENGTH)


def _require_external_string(value: str, *, maximum: int, key: bool = False) -> None:
    if len(value) > maximum:
        raise AlertPayloadTooLargeError
    if (key and not value) or any(_is_control_character(char) for char in value):
        raise AlertPayloadInvalidError


def _is_control_character(value: str) -> bool:
    codepoint = ord(value)
    return codepoint < 0x20 or 0x7F <= codepoint <= 0x9F


def _normalize_rfc3339_utc(value: str) -> CanonicalAlertTimestamp:
    match = _RFC3339_UTC.fullmatch(value)
    if match is None:
        raise ValueError("timestamp is not canonical RFC3339 UTC")
    try:
        datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        raise ValueError("timestamp is invalid") from None
    fraction = match.group("fraction") or ""
    return CanonicalAlertTimestamp(f"{value[:19]}.{fraction.ljust(9, '0')}Z")
