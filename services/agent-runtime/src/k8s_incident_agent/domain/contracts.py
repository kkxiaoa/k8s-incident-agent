from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


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


def _normalized_string(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        raise ValueError("Contract text must be normalized")
    return value
