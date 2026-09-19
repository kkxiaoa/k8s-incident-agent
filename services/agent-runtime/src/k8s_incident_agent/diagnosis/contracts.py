from collections.abc import Sequence
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

from k8s_incident_agent.domain.models import RecommendationRecord
from k8s_incident_agent.repair.contracts import SetContainerImageIntent


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


class Recommendation(_StrictDiagnosisContract):
    """One bounded, Evidence-backed next step the reader may take.

    It states what to do and why, what must hold before doing it, what it
    risks and how to tell whether it worked. It never carries a command, a
    manifest or an executable patch: acting on it stays a human decision, and
    the repair path keeps its own eligibility rules.
    """

    action: str = Field(min_length=1, max_length=512)
    purpose: str = Field(min_length=1, max_length=512)
    preconditions: str = Field(min_length=1, max_length=512)
    risk: str = Field(min_length=1, max_length=512)
    verification: str = Field(min_length=1, max_length=512)
    evidence_ids: list[Annotated[UUID, BeforeValidator(_parse_evidence_id)]] = Field(
        min_length=1,
        max_length=5,
    )

    @field_validator("evidence_ids")
    @classmethod
    def require_unique_evidence_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Evidence IDs must be unique within a recommendation")
        return value


class DiagnosisCandidate(_StrictDiagnosisContract):
    outcome: Literal["diagnosed", "insufficient_evidence"]
    summary: str = Field(min_length=1, max_length=1024)
    root_causes: list[RootCause] = Field(max_length=5)
    missing_information: list[Annotated[str, Field(min_length=1, max_length=512)]] = (
        Field(max_length=10)
    )
    recommendations: list[Recommendation] = Field(
        default_factory=lambda: list[Recommendation](),
        max_length=3,
    )
    repair_intent: SetContainerImageIntent | None = None

    @model_validator(mode="after")
    def require_outcome_shape(self) -> Self:
        if self.outcome == "diagnosed":
            if not self.root_causes:
                raise ValueError("A diagnosed outcome requires at least one root cause")
            return self
        if self.root_causes or not self.missing_information or self.repair_intent:
            raise ValueError(
                "An insufficient evidence outcome requires missing information only"
            )
        return self


class ValidatedDiagnosis(DiagnosisCandidate):
    redacted: bool


def recommendation_records(
    recommendations: Sequence[Recommendation],
) -> tuple[RecommendationRecord, ...]:
    """Project validated recommendations into the records the Runtime persists."""
    return tuple(
        RecommendationRecord(
            action=recommendation.action,
            purpose=recommendation.purpose,
            preconditions=recommendation.preconditions,
            risk=recommendation.risk,
            verification=recommendation.verification,
            evidence_ids=tuple(recommendation.evidence_ids),
        )
        for recommendation in recommendations
    )
