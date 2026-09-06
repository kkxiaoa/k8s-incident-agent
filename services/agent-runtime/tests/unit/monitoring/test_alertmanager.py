import json
from collections.abc import Callable
from typing import cast

import pytest

from k8s_incident_agent.domain.models import AlertSignalStatus
from k8s_incident_agent.monitoring.alertmanager import (
    ParsedAlertmanagerWebhook,
    parse_alertmanager_webhook,
)
from k8s_incident_agent.monitoring.catalog import AlertCatalog, load_alert_catalog
from k8s_incident_agent.monitoring.errors import (
    AlertPayloadInvalidError,
    AlertPayloadTooLargeError,
    AlertPayloadTruncatedError,
    AlertTargetInvalidError,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT


def _catalog() -> AlertCatalog:
    return load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")


def _alert(
    *,
    status: str = "firing",
    alert_name: str = "K8sIncidentImagePullBackOff",
    fingerprint: str = "0123456789abcdef",
    starts_at: str = "2026-09-02T08:00:00.123Z",
    ends_at: str = "0001-01-01T00:00:00Z",
    deployment: str = "image-pull-backoff",
) -> dict[str, object]:
    return {
        "status": status,
        "labels": {
            "alertname": alert_name,
            "cluster": "k8s-incident-agent",
            "namespace": "k8s-incident-scenarios",
            "deployment": deployment,
            "unconsumed": "must-not-be-persisted",
        },
        "annotations": {"description": "ignore this untrusted text"},
        "startsAt": starts_at,
        "endsAt": ends_at,
        "generatorURL": "http://prometheus.example/graph?g0.expr=ignored",
        "fingerprint": fingerprint,
    }


def _payload(*alerts: dict[str, object], truncated: int = 0) -> bytes:
    return json.dumps(
        {
            "version": "4",
            "groupKey": '{}:{alertname="example"}',
            "truncatedAlerts": truncated,
            "status": "firing",
            "receiver": "k8s-incident-agent",
            "groupLabels": {"alertname": "example"},
            "commonLabels": {},
            "commonAnnotations": {},
            "routeLabels": {},
            "externalURL": "http://alertmanager.example",
            "notification_reason": "",
            "alerts": list(alerts),
        }
    ).encode()


def _parse(payload: bytes) -> ParsedAlertmanagerWebhook:
    return parse_alertmanager_webhook(
        payload,
        catalog=_catalog(),
        cluster_id="k8s-incident-agent",
        diagnostic_namespace="k8s-incident-scenarios",
    )


def _occurrences(payload: bytes):
    return _parse(payload).occurrences


def _set_version_three(document: dict[str, object]) -> None:
    document["version"] = "3"


def _add_unknown_webhook_field(document: dict[str, object]) -> None:
    document["custom"] = "unsupported"


def _rename_generator_url(document: dict[str, object]) -> None:
    alert = _first_alert(document)
    alert["generatorUrl"] = alert.pop("generatorURL")


def _rename_starts_at_to_python_field(document: dict[str, object]) -> None:
    alert = _first_alert(document)
    alert["starts_at"] = alert.pop("startsAt")


def _invalidate_fingerprint(document: dict[str, object]) -> None:
    _first_alert(document)["fingerprint"] = "not-a-fingerprint"


def _use_non_utc_start(document: dict[str, object]) -> None:
    _first_alert(document)["startsAt"] = "2026-09-02T08:00:00+08:00"


def _exceed_alert_budget(document: dict[str, object]) -> None:
    document["alerts"] = [_alert(fingerprint=f"{index:016x}") for index in range(51)]


def _exceed_map_entry_budget(document: dict[str, object]) -> None:
    _first_alert(document)["labels"] = {
        f"label_{index}": "value" for index in range(65)
    }


def _exceed_map_value_budget(document: dict[str, object]) -> None:
    labels = _first_alert(document)["labels"]
    assert isinstance(labels, dict)
    labels["unconsumed"] = "x" * 4097


def _exceed_map_key_budget(document: dict[str, object]) -> None:
    labels = _first_alert(document)["labels"]
    assert isinstance(labels, dict)
    labels["x" * 129] = "value"


def _exceed_string_budget(document: dict[str, object]) -> None:
    document["groupKey"] = "x" * 4097


def _add_envelope_control_character(document: dict[str, object]) -> None:
    document["groupKey"] = "unsafe\nvalue"


def _add_annotation_control_character(document: dict[str, object]) -> None:
    annotations = _first_alert(document)["annotations"]
    assert isinstance(annotations, dict)
    annotations["description"] = "unsafe\x7fvalue"


def _add_label_key_control_character(document: dict[str, object]) -> None:
    labels = _first_alert(document)["labels"]
    assert isinstance(labels, dict)
    labels["unsafe\x00key"] = "value"


def _first_alert(document: dict[str, object]) -> dict[str, object]:
    alerts = document["alerts"]
    assert isinstance(alerts, list)
    return cast(dict[str, object], alerts[0])


def test_default_v4_firing_projects_only_the_catalog_contract() -> None:
    parsed = _parse(_payload(_alert()))
    occurrences = parsed.occurrences

    assert parsed.watchdog_firing is False
    assert len(occurrences) == 1
    occurrence = occurrences[0]
    assert occurrence.status is AlertSignalStatus.FIRING
    assert occurrence.ends_at is None
    assert occurrence.fingerprint == "0123456789abcdef"
    assert occurrence.starts_at == "2026-09-02T08:00:00.123000000Z"
    assert occurrence.trigger.source.type == "alertmanager"
    assert occurrence.trigger.source.ref == "K8sIncidentImagePullBackOff"
    assert occurrence.trigger.source.revision == "2026-09-06.1"
    assert occurrence.trigger.target.name == "image-pull-backoff"
    serialized = repr(occurrence)
    assert "must-not-be-persisted" not in serialized
    assert "ignore this untrusted text" not in serialized
    assert "prometheus.example" not in serialized


def test_crash_loop_firing_uses_its_catalog_target_and_summary() -> None:
    parsed = _parse(
        _payload(
            _alert(
                alert_name="K8sIncidentCrashLoopBackOff",
                deployment="crash-loop-backoff",
            )
        )
    )

    occurrence = parsed.occurrences[0]
    assert occurrence.trigger.source.ref == "K8sIncidentCrashLoopBackOff"
    assert occurrence.trigger.target.name == "crash-loop-backoff"
    assert occurrence.trigger.trigger_summary == (
        "A Deployment container repeatedly exits and is waiting in CrashLoopBackOff."
    )


def test_deployment_replica_deficit_is_a_supported_symptom_trigger() -> None:
    occurrence = _parse(
        _payload(
            _alert(
                alert_name="K8sIncidentDeploymentReplicasUnavailable",
                deployment="checkout-api",
            )
        )
    ).occurrences[0]

    assert occurrence.trigger.source.ref == ("K8sIncidentDeploymentReplicasUnavailable")
    assert occurrence.trigger.target.name == "checkout-api"
    assert occurrence.trigger.trigger_summary == (
        "A Deployment has fewer available replicas than desired."
    )


def test_service_endpoint_alert_maps_the_exact_service_target() -> None:
    alert = _alert(alert_name="K8sIncidentServiceEndpointsUnavailable")
    labels = cast(dict[str, str], alert["labels"])
    labels.pop("deployment")
    labels["service"] = "catalog-api"

    occurrence = _parse(_payload(alert)).occurrences[0]

    assert occurrence.trigger.target.api_version == "v1"
    assert occurrence.trigger.target.kind == "Service"
    assert occurrence.trigger.target.name == "catalog-api"
    assert occurrence.trigger.trigger_summary == (
        "A monitored selector-based Service has candidate Pods but no ready "
        "EndpointSlice endpoints."
    )


@pytest.mark.parametrize(
    ("alert_name", "deployment", "summary"),
    [
        (
            "K8sIncidentReadinessProbeFailure",
            "readiness-probe-misconfigured",
            "A monitored Deployment container remains running but is not ready.",
        ),
        (
            "K8sIncidentLivenessProbeRestart",
            "liveness-probe-misconfigured",
            "A Deployment container selected for liveness monitoring restarted.",
        ),
    ],
)
def test_probe_alerts_map_the_exact_deployment_without_claiming_root_cause(
    alert_name: str,
    deployment: str,
    summary: str,
) -> None:
    occurrence = _parse(
        _payload(_alert(alert_name=alert_name, deployment=deployment))
    ).occurrences[0]

    assert occurrence.trigger.target.kind == "Deployment"
    assert occurrence.trigger.target.name == deployment
    assert occurrence.trigger.trigger_summary == summary


def test_pvc_pending_alert_maps_the_exact_claim_target() -> None:
    alert = _alert(alert_name="K8sIncidentPersistentVolumeClaimPending")
    labels = cast(dict[str, str], alert["labels"])
    labels.pop("deployment")
    labels["persistentvolumeclaim"] = "pvc-storage-class-missing"

    occurrence = _parse(_payload(alert)).occurrences[0]

    assert occurrence.trigger.target.api_version == "v1"
    assert occurrence.trigger.target.kind == "PersistentVolumeClaim"
    assert occurrence.trigger.target.name == "pvc-storage-class-missing"
    assert occurrence.trigger.trigger_summary == (
        "An explicitly monitored PersistentVolumeClaim has remained Pending beyond "
        "its immediate-binding policy."
    )


def test_unknown_alert_is_acknowledgeable_without_an_occurrence() -> None:
    alert = _alert(alert_name="UnknownAlert")
    alert["labels"] = {"alertname": "UnknownAlert"}

    parsed = _parse(_payload(alert))

    assert parsed.occurrences == ()
    assert parsed.watchdog_firing is False


def test_same_occurrence_resolved_dominates_firing_within_one_batch() -> None:
    occurrences = _occurrences(
        _payload(
            _alert(),
            _alert(
                status="resolved",
                ends_at="2026-09-02T08:05:00Z",
            ),
        )
    )

    assert len(occurrences) == 1
    assert occurrences[0].status is AlertSignalStatus.RESOLVED
    assert occurrences[0].ends_at is not None
    assert occurrences[0].ends_at == "2026-09-02T08:05:00.000000000Z"


def test_nanosecond_occurrence_identity_is_preserved() -> None:
    occurrences = _occurrences(
        _payload(
            _alert(starts_at="2026-09-02T08:00:00.1234567Z"),
            _alert(starts_at="2026-09-02T08:00:00.1234568Z"),
        )
    )

    assert [occurrence.starts_at for occurrence in occurrences] == [
        "2026-09-02T08:00:00.123456700Z",
        "2026-09-02T08:00:00.123456800Z",
    ]


def test_firing_watchdog_is_projected_as_health_without_an_occurrence() -> None:
    watchdog = _alert(alert_name="Watchdog")
    watchdog["labels"] = {
        "alertname": "Watchdog",
        "cluster": "k8s-incident-agent",
        "severity": "none",
    }

    parsed = _parse(_payload(watchdog))

    assert parsed.occurrences == ()
    assert parsed.watchdog_firing is True


def test_resolved_watchdog_does_not_refresh_health() -> None:
    watchdog = _alert(
        alert_name="Watchdog",
        status="resolved",
        ends_at="2026-09-02T08:05:00Z",
    )
    watchdog["labels"] = {
        "alertname": "Watchdog",
        "cluster": "k8s-incident-agent",
        "severity": "none",
    }

    parsed = _parse(_payload(watchdog))

    assert parsed.occurrences == ()
    assert parsed.watchdog_firing is False


@pytest.mark.parametrize(
    "mutation",
    [
        _set_version_three,
        _add_unknown_webhook_field,
        _rename_generator_url,
        _rename_starts_at_to_python_field,
        _invalidate_fingerprint,
        _use_non_utc_start,
    ],
)
def test_contract_drift_is_rejected(
    mutation: Callable[[dict[str, object]], None],
) -> None:
    document: dict[str, object] = json.loads(_payload(_alert()))
    mutation(document)

    with pytest.raises(AlertPayloadInvalidError):
        _parse(json.dumps(document).encode())


@pytest.mark.parametrize(
    "mutation",
    [
        _exceed_alert_budget,
        _exceed_map_entry_budget,
        _exceed_map_key_budget,
        _exceed_map_value_budget,
        _exceed_string_budget,
    ],
)
def test_collection_and_string_budgets_are_enforced(
    mutation: Callable[[dict[str, object]], None],
) -> None:
    document: dict[str, object] = json.loads(_payload(_alert()))
    mutation(document)

    with pytest.raises(AlertPayloadTooLargeError):
        _parse(json.dumps(document).encode())


@pytest.mark.parametrize(
    "mutation",
    [
        _add_envelope_control_character,
        _add_annotation_control_character,
        _add_label_key_control_character,
    ],
)
def test_control_characters_are_rejected(
    mutation: Callable[[dict[str, object]], None],
) -> None:
    document: dict[str, object] = json.loads(_payload(_alert()))
    mutation(document)

    with pytest.raises(AlertPayloadInvalidError):
        _parse(json.dumps(document).encode())


def test_duplicate_json_keys_are_rejected() -> None:
    payload = _payload(_alert()).replace(
        b'"version": "4"',
        b'"version": "4", "version": "4"',
        1,
    )

    with pytest.raises(AlertPayloadInvalidError):
        _parse(payload)


def test_truncated_payload_has_a_distinct_failure() -> None:
    with pytest.raises(AlertPayloadTruncatedError):
        _parse(_payload(_alert(), truncated=1))


@pytest.mark.parametrize(
    ("label", "value"),
    [
        ("cluster", "another-cluster"),
        ("namespace", "another-namespace"),
        ("deployment", ""),
    ],
)
def test_supported_alert_requires_a_complete_in_scope_target(
    label: str,
    value: str,
) -> None:
    alert = _alert()
    labels = alert["labels"]
    assert isinstance(labels, dict)
    labels[label] = value

    with pytest.raises(AlertTargetInvalidError):
        _parse(_payload(alert))


def test_resolved_timestamp_must_not_precede_starts_at() -> None:
    with pytest.raises(AlertPayloadInvalidError):
        _parse(
            _payload(
                _alert(
                    status="resolved",
                    ends_at="2026-09-02T07:59:59Z",
                )
            )
        )
