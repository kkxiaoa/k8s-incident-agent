from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from k8s_incident_agent.domain.contracts import KubernetesTarget

type RepairAction = Literal["set_container_image"]
type PatchValidationErrorCode = Literal[
    "stale_resource",
    "patch_validator_authentication_failed",
    "patch_validator_replay_rejected",
    "patch_validator_permission_denied",
    "patch_validator_admission_denied",
    "patch_validator_timeout",
    "patch_validator_upstream_failed",
    "patch_validator_contract_invalid",
]


def _parse_evidence_id(value: object) -> UUID:
    if isinstance(value, UUID):
        return value
    if not isinstance(value, str):
        raise ValueError("Evidence ID must be a canonical UUID string")
    try:
        parsed = UUID(value)
    except ValueError:
        raise ValueError("Evidence ID must be a canonical UUID string") from None
    if str(parsed) != value:
        raise ValueError("Evidence ID must be a canonical UUID string")
    return parsed


def _normalized(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        raise ValueError("Repair value must be normalized")
    return value


class _RepairContract(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class SetContainerImageIntent(_RepairContract):
    action: Literal["set_container_image"]
    target: KubernetesTarget
    container_name: str = Field(min_length=1, max_length=253)
    replacement_image: str = Field(min_length=1, max_length=2048)
    evidence_ids: list[Annotated[UUID, BeforeValidator(_parse_evidence_id)]] = Field(
        min_length=2,
        max_length=2,
    )

    @field_validator("container_name", "replacement_image")
    @classmethod
    def require_normalized_value(cls, value: str) -> str:
        return _normalized(value)

    @field_validator("evidence_ids")
    @classmethod
    def require_unique_evidence_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Repair Evidence IDs must be unique")
        return value


class EvidenceBoundImageChange(_RepairContract):
    schema_version: Literal[1] = 1
    run_id: UUID
    action: Literal["set_container_image"]
    target: KubernetesTarget
    target_uid: str = Field(min_length=1, max_length=253)
    target_resource_version: str = Field(min_length=1, max_length=253)
    container_index: int = Field(ge=0, le=255)
    container_name: str = Field(min_length=1, max_length=253)
    current_image: str = Field(min_length=1, max_length=2048)
    replacement_image: str = Field(min_length=1, max_length=2048)
    evidence_ids: list[UUID] = Field(min_length=1, max_length=2)
    # Omit absent provenance so retained apply proposal digests stay unchanged.
    source_execution_id: UUID | None = Field(
        default=None, exclude_if=lambda v: v is None
    )

    @field_validator(
        "target_uid",
        "target_resource_version",
        "container_name",
        "current_image",
        "replacement_image",
    )
    @classmethod
    def require_normalized_value(cls, value: str) -> str:
        return _normalized(value)

    @model_validator(mode="after")
    def require_fixed_change_shape(self) -> Self:
        if (
            self.target.namespace is None
            or self.target.api_version != "apps/v1"
            or self.target.kind != "Deployment"
            or self.current_image == self.replacement_image
            or len(self.evidence_ids) != (1 if self.source_execution_id else 2)
            or len(set(self.evidence_ids)) != len(self.evidence_ids)
            or self.evidence_ids != sorted(self.evidence_ids, key=str)
        ):
            raise ValueError("Evidence-bound image change is invalid")
        return self


class JsonPatchOperation(_RepairContract):
    op: Literal["test", "replace"]
    path: str = Field(min_length=1, max_length=512, pattern=r"^/")
    value: str = Field(max_length=2048)


class RepairDiff(_RepairContract):
    path: str = Field(min_length=1, max_length=512, pattern=r"^/")
    before: str = Field(min_length=1, max_length=2048)
    after: str = Field(min_length=1, max_length=2048)

    @model_validator(mode="after")
    def require_material_change(self) -> Self:
        if self.before == self.after:
            raise ValueError("Repair Diff must contain a material change")
        return self


class RepairProposal(_RepairContract):
    schema_version: Literal[1] = 1
    id: UUID
    change: EvidenceBoundImageChange
    patch: list[JsonPatchOperation] = Field(min_length=5, max_length=5)
    digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    diff: RepairDiff
    schema_checked_at: datetime
    policy_checked_at: datetime
    diff_checked_at: datetime

    @field_validator(
        "schema_checked_at",
        "policy_checked_at",
        "diff_checked_at",
    )
    @classmethod
    def require_utc_timestamp(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Repair gate timestamps must use UTC")
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def require_gate_order(self) -> Self:
        if not (
            self.schema_checked_at <= self.policy_checked_at <= self.diff_checked_at
        ):
            raise ValueError("Repair gates must be ordered")
        return self

    @property
    def run_id(self) -> UUID:
        return self.change.run_id

    @property
    def action(self) -> RepairAction:
        return self.change.action

    @property
    def target(self) -> KubernetesTarget:
        return self.change.target

    @property
    def target_uid(self) -> str:
        return self.change.target_uid

    @property
    def target_resource_version(self) -> str:
        return self.change.target_resource_version

    @property
    def container_index(self) -> int:
        return self.change.container_index

    @property
    def container_name(self) -> str:
        return self.change.container_name

    @property
    def current_image(self) -> str:
        return self.change.current_image

    @property
    def replacement_image(self) -> str:
        return self.change.replacement_image

    @property
    def evidence_ids(self) -> tuple[UUID, ...]:
        return tuple(self.change.evidence_ids)


class PatchValidationChange(_RepairContract):
    """Evidence-bound intent sent across the validator trust boundary.

    The array index is deliberately absent. The validator derives it from the
    Deployment it reads immediately before compiling the JSON Patch.
    """

    schema_version: Literal[1] = 1
    run_id: UUID
    action: Literal["set_container_image"]
    target: KubernetesTarget
    target_uid: str = Field(min_length=1, max_length=253)
    target_resource_version: str = Field(min_length=1, max_length=253)
    container_name: str = Field(min_length=1, max_length=253)
    current_image: str = Field(min_length=1, max_length=2048)
    replacement_image: str = Field(min_length=1, max_length=2048)
    evidence_ids: list[UUID] = Field(min_length=1, max_length=2)
    source_execution_id: UUID | None = Field(
        default=None, exclude_if=lambda v: v is None
    )

    @field_validator(
        "target_uid",
        "target_resource_version",
        "container_name",
        "current_image",
        "replacement_image",
    )
    @classmethod
    def require_normalized_value(cls, value: str) -> str:
        return _normalized(value)

    @model_validator(mode="after")
    def require_fixed_change_shape(self) -> Self:
        if (
            self.target.namespace is None
            or self.target.api_version != "apps/v1"
            or self.target.kind != "Deployment"
            or self.current_image == self.replacement_image
            or len(self.evidence_ids) != (1 if self.source_execution_id else 2)
            or len(set(self.evidence_ids)) != len(self.evidence_ids)
            or self.evidence_ids != sorted(self.evidence_ids, key=str)
        ):
            raise ValueError("Patch validation change is invalid")
        return self

    @classmethod
    def from_proposal(cls, proposal: RepairProposal) -> Self:
        change = proposal.change
        return cls(
            run_id=change.run_id,
            action=change.action,
            target=change.target,
            target_uid=change.target_uid,
            target_resource_version=change.target_resource_version,
            container_name=change.container_name,
            current_image=change.current_image,
            replacement_image=change.replacement_image,
            evidence_ids=change.evidence_ids,
            source_execution_id=change.source_execution_id,
        )


class PatchValidationRequest(_RepairContract):
    schema_version: Literal[1] = 1
    proposal_id: UUID
    change: PatchValidationChange
    proposal_digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    deadline: datetime

    @field_validator("deadline")
    @classmethod
    def require_utc_deadline(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Patch validation deadline must use UTC")
        return value.astimezone(UTC)


class PatchValidationFailure(_RepairContract):
    code: PatchValidationErrorCode
    retryable: bool


class PatchValidatorBoundaryError(_RepairContract):
    schema_version: Literal[1] = 1
    error: PatchValidationFailure


class PatchValidationResponse(_RepairContract):
    schema_version: Literal[1] = 1
    proposal_id: UUID
    run_id: UUID
    proposal_digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    outcome: Literal["passed", "failed"]
    checked_at: datetime
    error: PatchValidationFailure | None

    @field_validator("checked_at")
    @classmethod
    def require_utc_checked_at(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Patch validation timestamp must use UTC")
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def require_outcome_shape(self) -> Self:
        if (self.outcome == "passed") is not (self.error is None):
            raise ValueError("Patch validation outcome is inconsistent")
        return self
