from __future__ import annotations

from collections.abc import Sequence
from typing import Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from k8s_incident_agent.domain.contracts import DiagnosisDeferral, IncidentSource
from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.kubernetes.contracts import (
    ContainerProbe,
    CurrentPodFacts,
    CurrentTargetFacts,
    PersistentVolumeClaimDetail,
    PodsPayload,
    PodSummary,
    PvcStoragePayload,
    ServiceNetworkPayload,
    WorkloadDetail,
    WorkloadPayload,
)
from k8s_incident_agent.persistence.canonical import canonical_json


class DiagnosisFacts(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    target_uid: str
    complete: bool
    values: dict[str, JsonValue]


class RecordedDiagnosisChange(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
    )

    source: IncidentSource
    summary: str
    fingerprint: str
    starts_at: str
    reason: Literal["first_observation", "new_symptom", "facts_changed"]
    facts: DiagnosisFacts


class PendingDiagnosisChange(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    first_event_id: int = Field(ge=1)
    event_id: int = Field(ge=1)


class PendingDiagnosis(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    changes: dict[str, PendingDiagnosisChange] = Field(
        default_factory=dict, max_length=3
    )
    deferral: DiagnosisDeferral | None = None


def has_new_diagnosis_facts(previous: DiagnosisFacts, current: DiagnosisFacts) -> bool:
    """Missing observations cannot turn a repeated read failure into new work."""
    if previous.target_uid != current.target_uid:
        return False
    for key, value in current.values.items():
        if key == "pods.containers":
            before = cast(list[dict[str, JsonValue]], previous.values.get(key, []))
            observed = cast(list[dict[str, JsonValue]], value)
            if any(
                not any(
                    all(
                        field in old and old[field] == known
                        for field, known in record.items()
                    )
                    for old in before
                )
                for record in observed
            ):
                return True
        elif key not in previous.values or value != previous.values[key]:
            return True
    return False


def diagnosis_facts(facts: CurrentTargetFacts) -> DiagnosisFacts:
    """Compare known safe semantics independently from sampling stability.

    Pod identities and owner bindings are checked by the current-target adapter.
    Sets below ignore replacement/count churn while keeping template and actual
    containers separate, including their actual image identities.
    """
    values: dict[str, JsonValue] = {}
    complete = False
    if facts.workload is not None:
        values, template_complete = _workload_values(facts.workload)
        actual_values, actual_complete = _pod_values(facts.pods)
        values.update(actual_values)
        complete = template_complete and actual_complete
    elif facts.service is not None:
        values, complete = _service_values(facts.service)
    elif facts.claim is not None:
        values = _claim_values(facts.claim)
        complete = True
        if facts.pending_policy is not None:
            values["claim.pendingPolicy"] = facts.pending_policy
    return DiagnosisFacts(
        target_uid=facts.target_ref.uid, complete=complete, values=values
    )


def cited_diagnosis_values(
    kind: str, payload: str, previous: dict[str, JsonValue]
) -> dict[str, JsonValue]:
    """Only cited, typed tool observations may refine an attempted fact baseline."""
    try:
        if kind == "workload":
            return _workload_values(
                WorkloadPayload.model_validate_json(payload).workload
            )[0]
        if kind == "pods":
            projected, _ = _pod_values(PodsPayload.model_validate_json(payload).pods)
            before = cast(list[dict[str, JsonValue]], previous["pods.containers"])
            observed = cast(list[dict[str, JsonValue]], projected["pods.containers"])
            fields = ("name", "image", "imageId", "resources")
            refined: list[JsonValue] = []
            for record in before:
                matches = [
                    item
                    for item in observed
                    if all(
                        field in item and item[field] == record.get(field)
                        for field in fields
                    )
                ]
                # Tool Pod evidence has no container Ready/probe configuration.
                # Keep those facts only when the same image/configuration is unambiguous.
                if (
                    len(matches) == 1
                    and sum(
                        all(item.get(field) == record.get(field) for field in fields)
                        for item in before
                    )
                    == 1
                ):
                    refined.append({**record, **matches[0]})
                else:
                    refined.append(record)
            return {"pods.containers": _unique_values(refined)}
        if kind == "service_network":
            return _service_values(ServiceNetworkPayload.model_validate_json(payload))[
                0
            ]
        if kind == "pvc_storage":
            return _claim_values(
                PvcStoragePayload.model_validate_json(payload).persistent_volume_claim
            )
    except ValidationError:
        pass
    return {}


def _workload_values(workload: WorkloadDetail) -> tuple[dict[str, JsonValue], bool]:
    values: dict[str, JsonValue] = {
        "template.containers": [
            name for name in sorted(container.name for container in workload.containers)
        ]
    }
    complete = True
    for container in workload.containers:
        prefix = f"template.{container.name}"
        values[f"{prefix}.image"] = container.image
        values[f"{prefix}.imagePullPolicy"] = container.image_pull_policy
        values[f"{prefix}.probes"] = _probe_values(container.probes)
        if any(probe.handler.type == "exec" for probe in container.probes):
            complete = False
        if container.resources is None:
            complete = False
        else:
            values[f"{prefix}.resources"] = container.resources.model_dump(mode="json")
    values["workload.conditions"] = _unique_values(
        [
            {
                "type": condition.type,
                "status": condition.status,
                "reason": condition.reason,
            }
            for condition in workload.conditions
        ]
    )
    return values, complete


def _pod_values(
    pods: Sequence[PodSummary | CurrentPodFacts],
) -> tuple[dict[str, JsonValue], bool]:
    records: list[JsonValue] = []
    complete = bool(pods)
    for observed in pods:
        pod = observed.pod if isinstance(observed, CurrentPodFacts) else observed
        for container in pod.containers:
            record: dict[str, JsonValue] = {
                "name": container.name,
                "image": container.image,
            }
            fields: tuple[tuple[str, JsonValue], ...] = (
                ("imageId", container.image_id),
                (
                    "resources",
                    container.configured_resources.model_dump(mode="json")
                    if container.configured_resources is not None
                    else None,
                ),
                (
                    "state",
                    {
                        "status": container.state.status,
                        "reason": container.state.reason,
                        "exitCode": container.state.exit_code,
                    }
                    if container.state.status != "unknown"
                    else None,
                ),
            )
            for field, value in fields:
                if value is None:
                    complete = False
                else:
                    record[field] = value
            # Kubernetes legitimately omits lastState before any previous termination.
            # Losing that optional history is not a newly observed abnormal condition.
            previous = container.last_state
            if previous is not None:
                if previous.status == "unknown":
                    complete = False
                else:
                    record["lastState"] = {
                        "status": previous.status,
                        "reason": previous.reason,
                        "exitCode": previous.exit_code,
                    }
            if isinstance(observed, CurrentPodFacts):
                ready = observed.container_ready.get(container.name)
                if ready is None:
                    complete = False
                else:
                    record["ready"] = ready
                probes = observed.container_probes.get(container.name)
                if probes is None:
                    complete = False
                else:
                    record["probes"] = _probe_values(probes)
                    if any(probe.handler.type == "exec" for probe in probes):
                        complete = False
            records.append(record)
    return {"pods.containers": _unique_values(records)}, complete


def _service_values(
    service: ServiceNetworkPayload,
) -> tuple[dict[str, JsonValue], bool]:
    return {
        "service.configuration": service.service.model_dump(
            mode="json", exclude={"resource_version"}
        ),
        "service.state": service.summary.state,
        "service.candidates": _unique_values(
            [
                {"matchesSelector": pod.matches_selector, "ready": pod.ready}
                for pod in service.candidate_pods
            ]
        ),
    }, all(pod.ready is not None for pod in service.candidate_pods)


def _claim_values(claim: PersistentVolumeClaimDetail) -> dict[str, JsonValue]:
    return {
        "claim.phase": claim.phase,
        "claim.storageClass": claim.requested_storage_class.model_dump(mode="json"),
        "claim.conditions": _unique_values(
            [
                {
                    "type": condition.type,
                    "status": condition.status,
                    "reason": condition.reason,
                }
                for condition in claim.conditions
            ]
        ),
    }


def _unique_values(values: Sequence[JsonValue]) -> list[JsonValue]:
    return [
        value
        for _, value in sorted(
            {canonical_json(value): value for value in values}.items()
        )
    ]


def _probe_values(probes: list[ContainerProbe]) -> list[JsonValue]:
    return _unique_values([probe.model_dump(mode="json") for probe in probes])
