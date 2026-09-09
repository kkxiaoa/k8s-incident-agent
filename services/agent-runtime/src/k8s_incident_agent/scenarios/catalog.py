import json
import os
import re
import stat
from pathlib import Path, PurePosixPath
from typing import Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from k8s_incident_agent.diagnosis.policy_contracts import (
    DiagnosticEvidenceKind,
    DiagnosticToolName,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT
from k8s_incident_agent.scenarios.contracts import (
    PublicScenario,
    ScenarioTarget,
    ScenarioTrigger,
    validate_supported_target,
)

_MAX_FILE_BYTES = 1024 * 1024
_SCENARIO_ID = re.compile(r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$")


class _StrictContract(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        hide_input_in_errors=True,
    )


class _Verifier(_StrictContract):
    kind: Literal[
        "image_pull_backoff",
        "crash_loop_backoff",
        "service_selector_mismatch",
        "readiness_probe_failure",
        "liveness_probe_failure",
        "pvc_pending",
    ]
    timeout_seconds: Literal[120, 300]
    poll_interval_seconds: Literal[2]

    @model_validator(mode="after")
    def validate_timeout(self) -> Self:
        expected = 300 if self.kind == "crash_loop_backoff" else 120
        if self.timeout_seconds != expected:
            raise ValueError("Verifier timeout does not match its kind")
        return self


class _ExpectedPatchConstraints(_StrictContract):
    action: Literal["set_container_image"]
    container_index: Literal[0]
    container_name: str = Field(min_length=1, max_length=253)
    current_image: str = Field(min_length=1, max_length=2048)
    replacement_image: str = Field(min_length=1, max_length=2048)

    @field_validator("container_name", "current_image", "replacement_image")
    @classmethod
    def normalize_value(cls, value: str) -> str:
        return _normalized_string(value)


class _ScenarioDefinition(_StrictContract):
    schema_version: Literal[3]
    scenario_id: str = Field(min_length=1)
    scenario_version: Literal[1, 3]
    monitoring_alert_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    trigger: ScenarioTrigger
    target: ScenarioTarget
    fixture_manifests: tuple[str, ...] = Field(min_length=1)
    expected_root_causes: tuple[str, ...] = Field(min_length=1)
    required_evidence: tuple[DiagnosticEvidenceKind, ...] = Field(min_length=1)
    allowed_tools: tuple[DiagnosticToolName, ...] = Field(min_length=1)
    forbidden_tools: tuple[str, ...] = Field(min_length=1)
    deterministic_verifier: _Verifier
    expected_patch_constraints: _ExpectedPatchConstraints | None = None

    @field_validator(
        "scenario_id", "monitoring_alert_id", "display_name", "description"
    )
    @classmethod
    def normalize_scalar_text(cls, value: str) -> str:
        return _normalized_string(value)

    @field_validator(
        "fixture_manifests",
        "expected_root_causes",
        "required_evidence",
        "allowed_tools",
        "forbidden_tools",
    )
    @classmethod
    def normalize_unique_values(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(_normalized_string(value) for value in values)
        if len(set(normalized)) != len(normalized):
            raise ValueError("Scenario arrays must contain unique values")
        return normalized

    def validate_relationships(self, directory_name: str) -> Self:
        expected_version = 3 if self.scenario_id == "image-pull-backoff" else 1
        if (
            not _SCENARIO_ID.fullmatch(self.scenario_id)
            or self.scenario_id != directory_name
            or self.scenario_version != expected_version
            or self.target.name != self.scenario_id
            or set(self.allowed_tools).intersection(self.forbidden_tools)
            or (self.expected_patch_constraints is not None)
            != (self.scenario_id == "image-pull-backoff")
        ):
            raise ValueError("Scenario definition relationships are invalid")
        return self

    def public_projection(self) -> PublicScenario:
        validate_supported_target(self.target)
        return PublicScenario(
            scenario_id=self.scenario_id,
            scenario_version=self.scenario_version,
            monitoring_alert_id=self.monitoring_alert_id,
            display_name=self.display_name,
            description=self.description,
            trigger=self.trigger,
            target=self.target,
            allowed_tools=self.allowed_tools,
            required_evidence=self.required_evidence,
        )


def load_scenario_catalog(path: Path) -> tuple[PublicScenario, ...]:
    try:
        catalog = _validated_catalog_path(path)
        scenarios: list[PublicScenario] = []
        for entry in sorted(catalog.iterdir(), key=lambda item: item.name):
            entry_stat = entry.lstat()
            if not stat.S_ISDIR(entry_stat.st_mode):
                continue
            definition = _load_definition(entry)
            scenarios.append(definition.public_projection())
        return tuple(scenarios)
    except (OSError, UnicodeError, ValueError, ValidationError, json.JSONDecodeError):
        raise RuntimeError(
            "Scenario catalog does not satisfy the supported contract"
        ) from None


def _validated_catalog_path(path: Path) -> Path:
    if not path.is_absolute():
        raise ValueError
    normalized = Path(os.path.normpath(path))
    if normalized in {
        Path(normalized.anchor),
        Path(os.path.normpath(Path.home())),
        REPOSITORY_ROOT,
    }:
        raise ValueError
    _reject_symlink_components(normalized)
    path_stat = normalized.lstat()
    if not stat.S_ISDIR(path_stat.st_mode):
        raise ValueError
    return normalized


def _load_definition(directory: Path) -> _ScenarioDefinition:
    definition = _ScenarioDefinition.model_validate_json(
        _read_bounded_regular_file(directory / "scenario.json")
    ).validate_relationships(directory.name)
    for relative_path in definition.fixture_manifests:
        _validate_manifest_reference(directory, relative_path)
    return definition


def _validate_manifest_reference(directory: Path, relative_path: str) -> None:
    pure_path = PurePosixPath(relative_path)
    if (
        pure_path.is_absolute()
        or "\\" in relative_path
        or pure_path.suffix not in {".yaml", ".yml"}
        or any(part in {"", ".", ".."} for part in pure_path.parts)
    ):
        raise ValueError
    current = directory
    for index, component in enumerate(pure_path.parts):
        current /= component
        current_stat = current.lstat()
        is_final = index == len(pure_path.parts) - 1
        if stat.S_ISLNK(current_stat.st_mode):
            raise ValueError
        if is_final:
            if (
                not stat.S_ISREG(current_stat.st_mode)
                or current_stat.st_size > _MAX_FILE_BYTES
            ):
                raise ValueError
        elif not stat.S_ISDIR(current_stat.st_mode):
            raise ValueError


def _read_bounded_regular_file(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_size > _MAX_FILE_BYTES:
            raise ValueError
        with os.fdopen(descriptor, "rb") as file:
            descriptor = -1
            content = file.read(_MAX_FILE_BYTES + 1)
            if len(content) > _MAX_FILE_BYTES:
                raise ValueError
            return content
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            current_stat = current.lstat()
        except FileNotFoundError:
            raise ValueError from None
        if stat.S_ISLNK(current_stat.st_mode):
            raise ValueError


def _normalized_string(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        raise ValueError("Scenario text must be normalized")
    return value
