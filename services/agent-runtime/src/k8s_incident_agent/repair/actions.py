from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

type ActionUnavailableReason = Literal[
    "not_applicable",
    "active_run",
    "execution_held",
    "target_occupied",
    "execution_disabled",
    "outside_scope",
    "proposal_expired",
    "no_history_candidates",
    "diagnosis_unavailable",
    "authentication_required",
    "not_owner",
]


class _ActionProjection(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        frozen=True,
        strict=True,
        extra="forbid",
    )


class RepairPreparationSource(_ActionProjection):
    source_run_id: UUID
    source_execution_id: UUID | None


class RepairHistoryCandidate(_ActionProjection):
    revision: str = Field(pattern=r"^[1-9][0-9]*$")
    replica_set_uid: str
    image: str


class IncidentActions(_ActionProjection):
    # Null means available in this snapshot, never authorization to execute.
    prepare: ActionUnavailableReason | None
    refresh: ActionUnavailableReason | None
    edit: ActionUnavailableReason | None
    approve: ActionUnavailableReason | None
    reject: ActionUnavailableReason | None
    rerun: ActionUnavailableReason | None
    rollback: ActionUnavailableReason | None
    withdraw: ActionUnavailableReason | None = "not_applicable"
    preparation_source: RepairPreparationSource | None
    history_candidates: tuple[RepairHistoryCandidate, ...]
