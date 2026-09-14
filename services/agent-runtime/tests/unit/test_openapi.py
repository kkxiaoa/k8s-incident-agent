import json
import sys
from pathlib import Path
from typing import NoReturn, cast

import pytest

from k8s_incident_agent import api
from k8s_incident_agent import openapi as openapi_exporter

EXPECTED_OPERATIONS = {
    ("POST", "/api/v1/incidents/{incident_id}/approvals"),
    ("POST", "/api/v1/operator/login"),
    ("POST", "/api/v1/operator/logout"),
    ("GET", "/api/v1/operator/session"),
    ("POST", "/api/v1/operator/session"),
    ("POST", "/api/v1/alerts/alertmanager"),
    ("GET", "/healthz"),
    ("GET", "/api/v1/scenarios"),
    ("POST", "/api/v1/incidents"),
    ("GET", "/api/v1/incidents"),
    ("GET", "/api/v1/incidents/{incident_id}"),
    ("GET", "/api/v1/incidents/{incident_id}/events"),
    ("GET", "/api/v1/incidents/{incident_id}/monitoring/panels"),
    (
        "GET",
        "/api/v1/incidents/{incident_id}/monitoring/panels/{panel_id}",
    ),
    ("GET", "/api/v1/incidents/{incident_id}/runs"),
    ("POST", "/api/v1/incidents/{incident_id}/runs"),
    ("POST", "/api/v1/incidents/{incident_id}/repair-runs"),
    ("GET", "/api/v1/incidents/{incident_id}/runs/{run_id}/events"),
    ("GET", "/api/v1/monitoring/health"),
    ("GET", "/api/v1/monitoring/overview"),
}

HTTP_METHODS = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)

EXPECTED_ERROR_STATUSES = {
    ("POST", "/api/v1/alerts/alertmanager"): {
        "401",
        "413",
        "422",
        "500",
        "503",
    },
    ("GET", "/healthz"): {"500"},
    ("GET", "/api/v1/scenarios"): {"500", "503"},
    ("POST", "/api/v1/incidents"): {"404", "422", "500", "503"},
    ("GET", "/api/v1/incidents"): {"400", "422", "500", "503"},
    ("GET", "/api/v1/incidents/{incident_id}"): {"404", "422", "500", "503"},
    ("GET", "/api/v1/incidents/{incident_id}/events"): {
        "400",
        "404",
        "422",
        "500",
        "503",
    },
    ("GET", "/api/v1/incidents/{incident_id}/monitoring/panels"): {
        "404",
        "422",
        "500",
        "503",
    },
    (
        "GET",
        "/api/v1/incidents/{incident_id}/monitoring/panels/{panel_id}",
    ): {"404", "422", "500", "503"},
    ("GET", "/api/v1/incidents/{incident_id}/runs"): {
        "400",
        "404",
        "422",
        "500",
        "503",
    },
    ("POST", "/api/v1/incidents/{incident_id}/runs"): {
        "404",
        "409",
        "422",
        "500",
        "503",
    },
    ("POST", "/api/v1/incidents/{incident_id}/repair-runs"): {
        "404",
        "409",
        "422",
        "500",
        "503",
    },
    ("GET", "/api/v1/incidents/{incident_id}/runs/{run_id}/events"): {
        "400",
        "404",
        "422",
        "500",
        "503",
    },
    ("GET", "/api/v1/monitoring/health"): {"500", "503"},
    ("GET", "/api/v1/monitoring/overview"): {"500", "503"},
}

EXPECTED_EVENT_COMPONENTS = {
    "repair.approval_decided": (
        "ApprovalDecidedStreamEvent",
        "ApprovalDecidedEventPayload",
    ),
    "repair.execution_updated": (
        "ExecutionUpdatedStreamEvent",
        "ExecutionUpdatedEventPayload",
    ),
    "incident.created": (
        "IncidentCreatedStreamEvent",
        "IncidentCreatedEventPayload",
    ),
    "run.queued": ("RunQueuedStreamEvent", "RunQueuedEventPayload"),
    "run.started": ("RunStartedStreamEvent", "RunStartedEventPayload"),
    "tool.started": ("ToolStartedStreamEvent", "ToolStartedEventPayload"),
    "evidence.recorded": (
        "EvidenceRecordedStreamEvent",
        "EvidenceRecordedEventPayload",
    ),
    "tool.failed": ("ToolFailedStreamEvent", "ToolFailedEventPayload"),
    "diagnosis.completed": (
        "DiagnosisCompletedStreamEvent",
        "DiagnosisCompletedEventPayload",
    ),
    "diagnosis.insufficient": (
        "DiagnosisInsufficientStreamEvent",
        "DiagnosisInsufficientEventPayload",
    ),
    "run.failed": ("RunFailedStreamEvent", "RunFailedEventPayload"),
    "repair.patch_ready": (
        "RepairPatchReadyStreamEvent",
        "RepairPatchReadyEventPayload",
    ),
    "repair.dry_run_passed": (
        "RepairDryRunPassedStreamEvent",
        "RepairDryRunPassedEventPayload",
    ),
    "repair.waiting_approval": (
        "RepairWaitingApprovalStreamEvent",
        "RepairWaitingApprovalEventPayload",
    ),
    "repair.wait_ended": (
        "RepairWaitEndedStreamEvent",
        "RepairWaitEndedEventPayload",
    ),
    "alert.resolved": (
        "AlertResolvedStreamEvent",
        "AlertResolvedEventPayload",
    ),
}


def _fail_if_runtime_settings_are_loaded() -> NoReturn:
    raise AssertionError("OpenAPI export must not enter the Runtime lifespan")


def _schema_field_names(value: object) -> set[str]:
    if isinstance(value, dict):
        mapping = cast(dict[str, object], value)
        properties = mapping.get("properties")
        names = (
            set(cast(dict[str, object], properties))
            if isinstance(properties, dict)
            else set()
        )
        for child in mapping.values():
            names.update(_schema_field_names(child))
        return names
    if isinstance(value, list):
        names: set[str] = set()
        for child in cast(list[object], value):
            names.update(_schema_field_names(child))
        return names
    return set()


def _export(
    output: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> bytes:
    monkeypatch.setattr(
        sys,
        "argv",
        ["agent-runtime-openapi", "export", "--output", str(output)],
    )
    openapi_exporter.main()
    return output.read_bytes()


def test_export_is_stable_and_does_not_enter_runtime_lifespan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(api, "Settings", _fail_if_runtime_settings_are_loaded)

    first = _export(tmp_path / "first.json", monkeypatch)
    second = _export(tmp_path / "second.json", monkeypatch)

    assert first == second
    schema = json.loads(first)
    assert (
        first
        == (
            json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode()
    )


def test_schema_exposes_only_the_current_runtime_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema = json.loads(_export(tmp_path / "openapi.json", monkeypatch))
    operations = {
        (method.upper(), path)
        for path, path_item in schema["paths"].items()
        for method in path_item
        if method in HTTP_METHODS
    }

    assert operations == EXPECTED_OPERATIONS
    assert schema["info"]["title"] == "K8s Incident Agent Runtime"
    assert schema["info"]["version"] == "0.1.0"
    assert schema["components"]["securitySchemes"] == {
        "APIKeyCookie": {
            "type": "apiKey",
            "in": "cookie",
            "name": "__Host-k8s-incident-session",
        },
        "AlertmanagerBearer": {
            "description": (
                "Shared bearer credential mounted in Alertmanager and Runtime."
            ),
            "scheme": "bearer",
            "type": "http",
        },
    }
    components = schema["components"]["schemas"]
    assert "JsonScalar" not in components
    assert "JsonValue" not in components
    evidence_properties = components["EvidenceResponse"]["properties"]
    for opaque_field in ("targetRef", "payload"):
        assert evidence_properties[opaque_field]["type"] == "object"
        assert evidence_properties[opaque_field]["additionalProperties"] is True
    contract_names = set(components) | _schema_field_names(components)
    normalized_contract_names = {
        name.replace("_", "").lower() for name in contract_names
    }
    for forbidden in (
        "credential",
        "checkpoint",
        "expected_root_causes",
        "fixture_manifests",
        "kubeconfig",
        "run_events",
    ):
        assert forbidden.replace("_", "").lower() not in normalized_contract_names


def test_operations_reference_their_success_and_error_models(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema = json.loads(_export(tmp_path / "openapi.json", monkeypatch))

    success_models = {
        ("GET", "/healthz", "200"): "RuntimeHealthResponse",
        ("GET", "/api/v1/scenarios", "200"): "ScenarioListResponse",
        (
            "GET",
            "/api/v1/monitoring/health",
            "200",
        ): "MonitoringHealthSnapshot",
        (
            "GET",
            "/api/v1/monitoring/overview",
            "200",
        ): "MonitoringOverviewSnapshot",
        ("POST", "/api/v1/incidents", "202"): "CreateIncidentResponse",
        ("GET", "/api/v1/incidents", "200"): "IncidentListResponse",
        (
            "GET",
            "/api/v1/incidents/{incident_id}",
            "200",
        ): "IncidentDetailResponse",
        (
            "GET",
            "/api/v1/incidents/{incident_id}/monitoring/panels",
            "200",
        ): "IncidentMonitoringPanels",
        (
            "GET",
            "/api/v1/incidents/{incident_id}/monitoring/panels/{panel_id}",
            "200",
        ): "IncidentMetricPanel",
        (
            "GET",
            "/api/v1/incidents/{incident_id}/runs",
            "200",
        ): "RunHistoryResponse",
        (
            "POST",
            "/api/v1/incidents/{incident_id}/runs",
            "202",
        ): "CreateRunResponse",
        (
            "GET",
            "/api/v1/incidents/{incident_id}/runs/{run_id}/events",
            "200",
        ): "RunEventHistoryResponse",
    }
    for (method, path, status), model in success_models.items():
        response = schema["paths"][path][method.lower()]["responses"][status]
        assert response["content"]["application/json"]["schema"] == {
            "$ref": f"#/components/schemas/{model}"
        }

    for (method, path), statuses in EXPECTED_ERROR_STATUSES.items():
        responses = schema["paths"][path][method.lower()]["responses"]
        assert statuses <= responses.keys()
        for status in statuses:
            assert responses[status]["content"]["application/json"]["schema"] == {
                "$ref": "#/components/schemas/ErrorResponse"
            }


def test_sse_response_references_all_discriminated_event_payloads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema = json.loads(_export(tmp_path / "openapi.json", monkeypatch))
    components = schema["components"]["schemas"]
    response = schema["paths"]["/api/v1/incidents/{incident_id}/events"]["get"][
        "responses"
    ]["200"]

    assert set(response["content"]) == {"text/event-stream"}
    assert response["content"]["text/event-stream"]["schema"] == {
        "$ref": "#/components/schemas/RunEventStreamItem"
    }
    event_union = components["RunEventStreamItem"]
    assert event_union["discriminator"] == {
        "propertyName": "event",
        "mapping": {
            event_type: f"#/components/schemas/{event_model}"
            for event_type, (
                event_model,
                _payload_model,
            ) in EXPECTED_EVENT_COMPONENTS.items()
        },
    }
    assert {item["$ref"] for item in event_union["oneOf"]} == {
        f"#/components/schemas/{event_model}"
        for event_model, _payload_model in EXPECTED_EVENT_COMPONENTS.values()
    }

    for event_type, (event_model, payload_model) in EXPECTED_EVENT_COMPONENTS.items():
        properties = components[event_model]["properties"]
        assert properties["event"]["const"] == event_type
        assert properties["data"] == {"$ref": f"#/components/schemas/{payload_model}"}
