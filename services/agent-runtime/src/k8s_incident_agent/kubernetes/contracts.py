from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from k8s_incident_agent.scenarios.contracts import ScenarioTarget

DeploymentTarget = ScenarioTarget


def _camel_case(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class _EvidenceContract(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel_case,
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        populate_by_name=True,
        strict=True,
    )


class TargetRef(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)


class Selector(_EvidenceContract):
    match_labels: dict[str, str]


class ReplicaSummary(_EvidenceContract):
    desired: int = Field(ge=0)
    updated: int = Field(ge=0)
    ready: int = Field(ge=0)
    available: int = Field(ge=0)


class ConditionSummary(_EvidenceContract):
    type: str = Field(min_length=1)
    status: str = Field(min_length=1)
    reason: str | None


class WorkloadContainer(_EvidenceContract):
    name: str = Field(min_length=1)
    image: str
    image_pull_policy: str = Field(min_length=1)


class WorkloadDetail(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    generation: int | None = Field(ge=0)
    observed_generation: int | None = Field(ge=0)
    replicas: ReplicaSummary
    selector: Selector
    containers: list[WorkloadContainer]
    conditions: list[ConditionSummary]


class WorkloadPayload(_EvidenceContract):
    workload: WorkloadDetail


class SourceWorkload(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    selector: Selector


class OwnerSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)
    controller: bool


class ContainerStateSummary(_EvidenceContract):
    status: Literal["waiting", "running", "terminated", "unknown"]
    reason: str | None
    message: str | None


class PodContainer(_EvidenceContract):
    name: str = Field(min_length=1)
    image: str
    image_id: str | None
    restart_count: int = Field(ge=0)
    state: ContainerStateSummary


class PodSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)
    resource_version: str = Field(min_length=1)
    owner: OwnerSummary
    phase: str | None
    conditions: list[ConditionSummary]
    containers: list[PodContainer]


class PodsPayload(_EvidenceContract):
    source_workload: SourceWorkload
    pods: list[PodSummary]


class RegardingSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)


class EventSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)
    resource_version: str = Field(min_length=1)
    regarding: RegardingSummary
    type: str | None
    reason: str | None
    action: str | None
    note: str | None
    event_time: str | None
    series_count: int = Field(ge=1)
    reporting_controller: str | None


class EventsPayload(_EvidenceContract):
    source_workload: SourceWorkload
    associated_replica_set_count: int = Field(ge=0)
    associated_pod_count: int = Field(ge=0)
    events: list[EventSummary]


class _Observation(_EvidenceContract):
    target_ref: TargetRef
    observed_at: datetime
    truncated: bool
    redacted: bool

    @field_validator("observed_at")
    @classmethod
    def normalize_observed_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Observation time must include a timezone")
        return value.astimezone(UTC)


class WorkloadObservation(_Observation):
    evidence_kind: Literal["workload"]
    payload: WorkloadPayload


class PodsObservation(_Observation):
    evidence_kind: Literal["pods"]
    payload: PodsPayload


class EventsObservation(_Observation):
    evidence_kind: Literal["events"]
    payload: EventsPayload
