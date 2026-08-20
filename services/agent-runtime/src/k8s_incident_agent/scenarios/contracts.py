from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _ImmutableContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ScenarioTrigger(_ImmutableContract):
    type: Literal["manual"]
    summary: str = Field(min_length=1)


class ScenarioTarget(_ImmutableContract):
    cluster: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    name: str = Field(min_length=1)


class PublicScenario(_ImmutableContract):
    scenario_id: str = Field(min_length=1)
    scenario_version: int = Field(ge=1)
    display_name: str = Field(min_length=1)
    trigger: ScenarioTrigger
    target: ScenarioTarget
