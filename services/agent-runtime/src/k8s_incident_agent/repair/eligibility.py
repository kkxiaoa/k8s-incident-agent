"""One deterministic judgement for the image replacement action.

Eligibility follows from the observed facts, never from how the model named the
root cause, so the repair policy gate and a fresh preparation call this module
instead of each deriving the rule.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import ValidationError

from k8s_incident_agent.domain.models import PersistedEvidence
from k8s_incident_agent.kubernetes.contracts import (
    EventsPayload,
    PodsPayload,
    RolloutHistoryPayload,
    TargetRef,
    WorkloadPayload,
)
from k8s_incident_agent.repair.contracts import SetContainerImageIntent

_IMAGE_PULL_WAITING_REASONS: Final = frozenset({"ErrImagePull", "ImagePullBackOff"})


@dataclass(frozen=True, slots=True)
class IntentEvidence:
    """The workload and rollout-history pair an intent cites, already parsed."""

    workload_ref: TargetRef
    rollout_ref: TargetRef
    workload: WorkloadPayload
    rollout: RolloutHistoryPayload


def load_intent_evidence(
    intent: SetContainerImageIntent,
    evidence_by_id: Mapping[UUID, PersistedEvidence],
    *,
    run_id: UUID,
) -> IntentEvidence | None:
    """Parse the pair an intent cites, or report that it is not usable."""

    try:
        evidence = tuple(evidence_by_id[value] for value in intent.evidence_ids)
    except KeyError:
        return None
    if (
        len(evidence) != 2
        or {item.evidence_kind for item in evidence} != {"workload", "rollout_history"}
        or any(
            item.run_id != run_id or item.truncated or item.redacted
            for item in evidence
        )
    ):
        return None
    by_kind = {item.evidence_kind: item for item in evidence}
    try:
        return IntentEvidence(
            workload_ref=TargetRef.model_validate(by_kind["workload"].target_ref),
            rollout_ref=TargetRef.model_validate(by_kind["rollout_history"].target_ref),
            workload=WorkloadPayload.model_validate(by_kind["workload"].payload),
            rollout=RolloutHistoryPayload.model_validate(
                by_kind["rollout_history"].payload
            ),
        )
    except ValidationError:
        return None


def fault_observations(
    evidence_by_id: Mapping[UUID, PersistedEvidence],
    *,
    run_id: UUID,
) -> tuple[tuple[PodsPayload, ...], tuple[EventsPayload, ...]]:
    """Collect this Run's usable Pod and Event observations.

    An intent cites only the workload and rollout history, so the pull failure
    itself is proven from the other Evidence the same Run already holds. What
    binds an observation to the revision under repair is decided in
    `proves_invalid_image_reference`; a Run's observations are not filtered by
    the workload's resourceVersion, which any status write moves.
    """

    pods: list[PodsPayload] = []
    events: list[EventsPayload] = []
    for evidence in evidence_by_id.values():
        if (
            evidence.run_id != run_id
            or evidence.truncated
            or evidence.redacted
            or evidence.evidence_kind not in ("pods", "events")
        ):
            continue
        try:
            if evidence.evidence_kind == "pods":
                pods.append(PodsPayload.model_validate(evidence.payload))
            else:
                events.append(EventsPayload.model_validate(evidence.payload))
        except ValidationError:
            continue
    return tuple(pods), tuple(events)


def proves_invalid_image_reference(
    *,
    workload: WorkloadPayload,
    pods: Sequence[PodsPayload],
    events: Sequence[EventsPayload],
    container_name: str,
    replica_set_uid: str,
) -> bool:
    """Report whether the evidence proves this container's image reference is
    itself invalid.

    A registry that refuses, throttles or cannot be reached produces the same
    waiting reason as an unusable reference, so only a reserved invalid registry
    host proves the reference. The failing Pods must belong to the workload's
    current ReplicaSet and carry the container under repair, otherwise another
    container's pull failure would license replacing this one.
    """

    containers = [
        container
        for container in workload.workload.containers
        if container.name == container_name
    ]
    if len(containers) != 1 or not _uses_reserved_invalid_registry(containers[0].image):
        return False
    image = containers[0].image
    failing = {
        (pod.namespace, pod.name, pod.uid)
        for payload in pods
        for pod in payload.pods
        if pod.owner.uid == replica_set_uid
        and any(
            container.name == container_name
            and container.image == image
            and container.state.status == "waiting"
            and container.state.reason in _IMAGE_PULL_WAITING_REASONS
            for container in pod.containers
        )
    }
    return bool(failing) and any(
        event.type == "Warning"
        and event.reason == "Failed"
        and event.reporting_controller == "kubelet"
        and event.regarding.kind == "Pod"
        and (
            event.regarding.namespace,
            event.regarding.name,
            event.regarding.uid,
        )
        in failing
        for payload in events
        for event in payload.events
    )


def _uses_reserved_invalid_registry(image: str) -> bool:
    if "://" in image:
        hostname = urlsplit(image).hostname
    else:
        authority, separator, _ = image.partition("/")
        if not separator:
            return False
        if (
            "." not in authority
            and ":" not in authority
            and authority.casefold() != "localhost"
        ):
            return False
        hostname = authority.rsplit(":", 1)[0]
    if hostname is None:
        return False
    normalized = hostname.rstrip(".").casefold()
    return normalized == "invalid" or normalized.endswith(".invalid")
