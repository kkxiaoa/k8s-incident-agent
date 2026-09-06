from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from k8s_incident_agent.kubernetes.contracts import (
    PodsObservation,
    ReplicaSummary,
    RolloutContainer,
    RolloutHistoryObservation,
    RolloutHistoryPayload,
    RolloutRevision,
    Selector,
    SourceWorkload,
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


def test_rollout_history_serializes_only_normalized_revision_evidence() -> None:
    observation = RolloutHistoryObservation(
        evidence_kind="rollout_history",
        target_ref=_workload_observation().target_ref,
        observed_at=datetime(2026, 9, 6, 9, 30, tzinfo=UTC),
        payload=RolloutHistoryPayload(
            source_workload=SourceWorkload(
                resource_version="42",
                selector=Selector(match_labels={"app": "broken-image"}),
            ),
            revisions=[
                RolloutRevision(
                    revision=2,
                    replica_set_ref=TargetRef(
                        api_version="apps/v1",
                        kind="ReplicaSet",
                        namespace="k8s-incident-scenarios",
                        name="image-pull-backoff-new",
                        uid="replica-set-uid",
                    ),
                    containers=[
                        RolloutContainer(
                            name="workload",
                            image="registry.invalid/workload:v2",
                        )
                    ],
                )
            ],
        ),
        truncated=False,
        redacted=False,
    )

    assert observation.model_dump(mode="json", by_alias=True)["payload"] == {
        "sourceWorkload": {
            "resourceVersion": "42",
            "selector": {"matchLabels": {"app": "broken-image"}},
        },
        "revisions": [
            {
                "revision": 2,
                "replicaSetRef": {
                    "apiVersion": "apps/v1",
                    "kind": "ReplicaSet",
                    "namespace": "k8s-incident-scenarios",
                    "name": "image-pull-backoff-new",
                    "uid": "replica-set-uid",
                },
                "containers": [
                    {
                        "name": "workload",
                        "image": "registry.invalid/workload:v2",
                    }
                ],
            }
        ],
    }


@pytest.mark.parametrize(
    "mutation",
    [
        "ascending",
        "duplicate_revision",
        "duplicate_replica_set",
        "revision_overflow",
        "wrong_scope",
    ],
)
def test_rollout_history_rejects_ambiguous_replay_shapes(mutation: str) -> None:
    value = RolloutHistoryObservation(
        evidence_kind="rollout_history",
        target_ref=_workload_observation().target_ref,
        observed_at=datetime(2026, 9, 6, 9, 30, tzinfo=UTC),
        payload=RolloutHistoryPayload(
            source_workload=SourceWorkload(
                resource_version="42",
                selector=Selector(match_labels={"app": "broken-image"}),
            ),
            revisions=[
                RolloutRevision(
                    revision=2,
                    replica_set_ref=TargetRef(
                        api_version="apps/v1",
                        kind="ReplicaSet",
                        namespace="k8s-incident-scenarios",
                        name="new",
                        uid="new-uid",
                    ),
                    containers=[RolloutContainer(name="workload", image="bad:v2")],
                ),
                RolloutRevision(
                    revision=1,
                    replica_set_ref=TargetRef(
                        api_version="apps/v1",
                        kind="ReplicaSet",
                        namespace="k8s-incident-scenarios",
                        name="old",
                        uid="old-uid",
                    ),
                    containers=[RolloutContainer(name="workload", image="good:v1")],
                ),
            ],
        ),
        truncated=False,
        redacted=False,
    ).model_dump(mode="python")
    revisions = value["payload"]["revisions"]
    if mutation == "ascending":
        revisions.reverse()
    elif mutation == "duplicate_revision":
        revisions[1]["revision"] = 2
    elif mutation == "duplicate_replica_set":
        revisions[1]["replica_set_ref"]["uid"] = "new-uid"
    elif mutation == "revision_overflow":
        revisions[0]["revision"] = 9223372036854775808
    else:
        revisions[1]["replica_set_ref"]["namespace"] = "another-namespace"

    with pytest.raises(ValidationError):
        RolloutHistoryObservation.model_validate(value)
