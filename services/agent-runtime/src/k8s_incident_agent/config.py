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
    deepseek_api_key: SecretStr | None = Field(default=None, repr=False)
    deepseek_base_url: HttpUrl = HttpUrl("https://api.deepseek.com")
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
