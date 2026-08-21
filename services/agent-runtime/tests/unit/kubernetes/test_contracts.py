from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from k8s_incident_agent.kubernetes.contracts import (
    PodsObservation,
    ReplicaSummary,
    Selector,
    TargetRef,
    WorkloadDetail,
    WorkloadObservation,
    WorkloadPayload,
)


def _workload_observation() -> WorkloadObservation:
    return WorkloadObservation(
        evidence_kind="workload",
        target_ref=TargetRef(
            api_version="apps/v1",
            kind="Deployment",
            namespace="k8s-incident-scenarios",
            name="image-pull-backoff",
            uid="deployment-uid",
        ),
        observed_at=datetime(2026, 8, 21, 8, 30, tzinfo=UTC),
        payload=WorkloadPayload(
            workload=WorkloadDetail(
                resource_version="42",
                generation=3,
                observed_generation=3,
                replicas=ReplicaSummary(
                    desired=1,
                    updated=1,
                    ready=0,
                    available=0,
                ),
                selector=Selector(match_labels={"app": "broken-image"}),
                containers=[],
                conditions=[],
            )
        ),
        truncated=False,
        redacted=False,
    )


def test_observation_serializes_the_strict_camel_case_contract() -> None:
    payload = _workload_observation().model_dump(mode="json", by_alias=True)

    assert payload == {
        "evidenceKind": "workload",
        "targetRef": {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "namespace": "k8s-incident-scenarios",
            "name": "image-pull-backoff",
            "uid": "deployment-uid",
        },
        "observedAt": "2026-08-21T08:30:00Z",
        "payload": {
            "workload": {
                "resourceVersion": "42",
                "generation": 3,
                "observedGeneration": 3,
                "replicas": {
                    "desired": 1,
                    "updated": 1,
                    "ready": 0,
                    "available": 0,
                },
                "selector": {"matchLabels": {"app": "broken-image"}},
                "containers": [],
                "conditions": [],
            }
        },
        "truncated": False,
        "redacted": False,
    }


def test_observation_rejects_a_payload_for_another_evidence_kind() -> None:
    value = _workload_observation().model_dump(mode="python")
    value["evidence_kind"] = "pods"

    with pytest.raises(ValidationError):
        PodsObservation.model_validate(value)


def test_contracts_forbid_unknown_extensions() -> None:
    value = _workload_observation().model_dump(mode="python")
    value["raw_sdk_body"] = {"token": "must-not-be-retained"}

    with pytest.raises(ValidationError) as error:
        WorkloadObservation.model_validate(value)

    assert "must-not-be-retained" not in str(error.value)


def test_contracts_reject_top_level_field_assignment() -> None:
    observation = _workload_observation()

    with pytest.raises(ValidationError):
        observation.redacted = True  # type: ignore[misc]
