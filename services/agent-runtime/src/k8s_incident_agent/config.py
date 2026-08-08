from typing import ClassVar, Literal, Self

from pydantic import Field, HttpUrl, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigurationInvalidError(RuntimeError):
    code: ClassVar[Literal["configuration_invalid"]] = "configuration_invalid"


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
    deepseek_api_key: SecretStr | None = Field(default=None, repr=False)
    deepseek_base_url: HttpUrl = HttpUrl("https://api.deepseek.com")

    @model_validator(mode="after")
    def validate_certified_runtime_configuration(self) -> Self:
        if self.model_name != "deepseek-v4-flash":
            raise ValueError(
                f"model {self.model_name!r} is not certified for the Runtime"
            )
        if self.model_thinking:
            raise ValueError("thinking mode is not certified for the Runtime")
        return self

    def require_deepseek_api_key(self) -> SecretStr:
        if self.deepseek_api_key is None:
            raise ConfigurationInvalidError("DEEPSEEK_API_KEY is required")
        if not self.deepseek_api_key.get_secret_value().strip():
            raise ConfigurationInvalidError("DEEPSEEK_API_KEY must not be empty")
        return self.deepseek_api_key
