from k8s_incident_agent.kubernetes.contracts import (
    RolloutHistoryPayload,
    RolloutRevision,
)


def image_history_candidates(
    history: RolloutHistoryPayload, container_name: str, current_image: str
) -> tuple[tuple[RolloutRevision, str], ...]:
    return tuple(
        (revision, container.image)
        for revision in history.revisions[1:]
        for container in revision.containers
        if container.name == container_name and container.image != current_image
    )
