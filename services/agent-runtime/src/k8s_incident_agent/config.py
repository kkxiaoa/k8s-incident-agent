import os
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, HttpUrl, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from k8s_incident_agent.model.errors import ModelError, ModelErrorCode
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths


class ConfigurationInvalidError(ModelError):
    def __init__(self, message: str) -> None:
        super().__init__(ModelErrorCode.CONFIGURATION_INVALID, message)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
        validate_default=True,
    )

    model_provider: Literal["deepseek"] = "deepseek"
    model_name: str = "deepseek-v4-flash"
    model_thinking: bool = False
    model_timeout_seconds: float = Field(default=60, gt=0)
    model_max_retries: int = Field(default=2, ge=0)
    runtime_retention_days: int = Field(default=7, ge=1, le=30)
    incident_intake_mode: Literal["manual", "online"] = "manual"
    kubernetes_credential_mode: Literal["kind_kubeconfig", "in_cluster"] = (
        "kind_kubeconfig"
    )
    kubernetes_cluster_id: str = Field(
        default="k8s-incident-agent",
        min_length=1,
    )
    kubernetes_diagnostic_namespace: str = Field(
        default="k8s-incident-scenarios",
        min_length=1,
    )
    kubernetes_timeout_seconds: float = Field(
        default=10,
        gt=0,
        allow_inf_nan=False,
    )
    agent_max_model_calls: int = Field(default=8, ge=1)
    agent_max_tool_calls: int = Field(default=6, ge=1)
    agent_timeout_seconds: int = Field(default=180, ge=1)
    deepseek_api_key: SecretStr | None = Field(default=None, repr=False)
    deepseek_base_url: HttpUrl = HttpUrl("https://api.deepseek.com")
    scenario_catalog_dir: Path = Field(
        default_factory=lambda: REPOSITORY_ROOT / "scenarios",
    )
    runtime_paths: Annotated[RuntimePaths, NoDecode] = Field(
        default_factory=lambda: RuntimePaths.prepare(REPOSITORY_ROOT / ".runtime"),
        validation_alias="RUNTIME_DATA_DIR",
        exclude=True,
        repr=False,
    )

    @field_validator("runtime_paths", mode="before")
    @classmethod
    def prepare_runtime_paths(cls, value: RuntimePaths | Path | str) -> RuntimePaths:
        if isinstance(value, RuntimePaths):
            return value
        return RuntimePaths.prepare(Path(value))

    @field_validator("scenario_catalog_dir", mode="before")
    @classmethod
    def validate_scenario_catalog_dir(cls, value: Path | str) -> Path:
        path = Path(value)
        if not path.is_absolute():
            raise ValueError("SCENARIO_CATALOG_DIR must be absolute")
        normalized = Path(os.path.normpath(path))
        if normalized in {
            Path(normalized.anchor),
            Path(os.path.normpath(Path.home())),
            REPOSITORY_ROOT,
        }:
            raise ValueError("SCENARIO_CATALOG_DIR must be a dedicated directory")
        return normalized

    @field_validator(
        "kubernetes_cluster_id",
        "kubernetes_diagnostic_namespace",
    )
    @classmethod
    def require_normalized_kubernetes_scope(cls, value: str) -> str:
        if value != value.strip() or any(
            ord(character) < 0x20 or ord(character) == 0x7F for character in value
        ):
            raise ValueError("Kubernetes scope must be normalized")
        return value

    @field_validator("deepseek_base_url")
    @classmethod
    def reject_sensitive_url_components(cls, value: HttpUrl) -> HttpUrl:
        if value.username or value.password or value.query or value.fragment:
            raise ValueError(
                "DEEPSEEK_BASE_URL must not contain credentials, query, or fragment"
            )
        return value

    @model_validator(mode="after")
    def validate_certified_runtime_configuration(self) -> Self:
        if self.model_name != "deepseek-v4-flash":
            raise ValueError("configured model is not certified for the Runtime")
        if self.model_thinking:
            raise ValueError("thinking mode is not certified for the Runtime")
        return self

    def require_deepseek_api_key(self) -> SecretStr:
        if self.deepseek_api_key is None:
            raise ConfigurationInvalidError("DEEPSEEK_API_KEY is required")
        if not self.deepseek_api_key.get_secret_value().strip():
            raise ConfigurationInvalidError("DEEPSEEK_API_KEY must not be empty")
        return self.deepseek_api_key
