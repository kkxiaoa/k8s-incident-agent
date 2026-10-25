from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


class _ImmutableContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class KubernetesTarget(_ImmutableContract):
    cluster: str = Field(min_length=1)
    namespace: str | None
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    name: str = Field(min_length=1)

    @field_validator("cluster", "api_version", "kind", "name")
    @classmethod
    def require_normalized_target_value(cls, value: str) -> str:
        return _normalized_string(value)

    @field_validator("namespace")
    @classmethod
    def require_normalized_namespace(cls, value: str | None) -> str | None:
        return None if value is None else _normalized_string(value)


class IncidentSource(_ImmutableContract):
    type: Literal["scenario", "alertmanager"]
    ref: str = Field(min_length=1)
    revision: str = Field(min_length=1)

    @field_validator("ref", "revision")
    @classmethod
    def require_normalized_source_value(cls, value: str) -> str:
        return _normalized_string(value)


class RepairHistorySelection(_ImmutableContract):
    revision: int = Field(ge=1, le=(1 << 63) - 1)
    replica_set_uid: str = Field(min_length=1, max_length=253)

    @field_validator("replica_set_uid")
    @classmethod
    def require_normalized_uid(cls, value: str) -> str:
        return _normalized_string(value)


class NormalizedIncidentTrigger(_ImmutableContract):
    source: IncidentSource
    display_name: str = Field(min_length=1)
    trigger_summary: str = Field(min_length=1)
    target: KubernetesTarget

    @field_validator("display_name", "trigger_summary")
    @classmethod
    def require_normalized_text(cls, value: str) -> str:
        return _normalized_string(value)


class DiagnosisChangeReference(_ImmutableContract):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True
    )

    source: IncidentSource
    fingerprint: str = Field(pattern=r"^[0-9a-f]{16}$")
    starts_at: str
    event_id: str = Field(pattern=r"^[1-9][0-9]*$")


class DiagnosisTrigger(_ImmutableContract):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True
    )

    source: IncidentSource
    summary: str = Field(min_length=1)
    occurred_at: AwareDatetime
    reason: Literal["first_observation", "new_symptom", "facts_changed", "manual"]
    changes: tuple[DiagnosisChangeReference, ...] = Field(max_length=3)


class DiagnosisDeferral(_ImmutableContract):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True
    )

    reason: Literal[
        "busy", "cooldown", "unavailable", "budget_exhausted", "awaiting_observation"
    ]
    review_after: AwareDatetime | None


def _normalized_string(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        raise ValueError("Contract text must be normalized")
    return value


class IncidentClosure(_ImmutableContract):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True
    )

    closed_at: AwareDatetime
    basis: Literal["observed_stable", "recovery_verified"]
