from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from k8s_incident_agent.domain.contracts import KubernetesTarget


class _ImmutableContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ScenarioTrigger(_ImmutableContract):
    type: Literal["manual"]
    summary: str = Field(min_length=1)

    @field_validator("summary")
    @classmethod
    def require_normalized_summary(cls, value: str) -> str:
        return _normalized_string(value)


ScenarioTarget = KubernetesTarget


class PublicScenario(_ImmutableContract):
    scenario_id: str = Field(min_length=1)
    scenario_version: int = Field(ge=1)
    display_name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    trigger: ScenarioTrigger
    target: ScenarioTarget

    @field_validator("scenario_id", "display_name", "description")
    @classmethod
    def require_normalized_scenario_value(cls, value: str) -> str:
        return _normalized_string(value)


def validate_stage_one_target(target: KubernetesTarget) -> None:
    if (
        target.cluster != "k8s-incident-agent"
        or target.namespace != "k8s-incident-scenarios"
        or target.api_version != "apps/v1"
        or target.kind != "Deployment"
    ):
        raise ValueError("Target is outside the Stage 1 diagnostic scope")


def _normalized_string(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        raise ValueError("Scenario text must be normalized")
    return value
