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


class _StrictDiagnosisContract(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class RootCause(_StrictDiagnosisContract):
    code: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]{0,63}$",
    )
    statement: str = Field(min_length=1, max_length=1024)
    confidence: Literal["low", "medium", "high"]
    evidence_ids: list[Annotated[UUID, BeforeValidator(_parse_evidence_id)]] = Field(
        min_length=1,
        max_length=10,
    )

    @field_validator("evidence_ids")
    @classmethod
    def require_unique_evidence_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Evidence IDs must be unique within a root cause")
        return value


class DiagnosisCandidate(_StrictDiagnosisContract):
    outcome: Literal["diagnosed", "insufficient_evidence"]
    summary: str = Field(min_length=1, max_length=1024)
    root_causes: list[RootCause] = Field(max_length=5)
    missing_information: list[Annotated[str, Field(min_length=1, max_length=512)]] = (
        Field(max_length=10)
    )

    @model_validator(mode="after")
    def require_outcome_shape(self) -> Self:
        if self.outcome == "diagnosed":
            if not self.root_causes:
                raise ValueError("A diagnosed outcome requires at least one root cause")
            return self
        if self.root_causes or not self.missing_information:
            raise ValueError(
                "An insufficient evidence outcome requires missing information only"
            )
        return self


class ValidatedDiagnosis(DiagnosisCandidate):
    redacted: bool
