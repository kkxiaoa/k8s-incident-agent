import pytest
from pydantic import SecretStr, ValidationError

from k8s_incident_agent.config import (
    ConfigurationInvalidError,
    Settings,
)

MODEL_ENVIRONMENT_VARIABLES = (
    "MODEL_PROVIDER",
    "MODEL_NAME",
    "MODEL_THINKING",
    "MODEL_TIMEOUT_SECONDS",
    "MODEL_MAX_RETRIES",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
)


def settings_without_dotenv() -> Settings:
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


@pytest.fixture(autouse=True)
def clear_model_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable in MODEL_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(variable, raising=False)


def test_settings_use_certified_runtime_defaults() -> None:
    settings = settings_without_dotenv()

    assert settings.model_provider == "deepseek"
    assert settings.model_name == "deepseek-v4-flash"
    assert settings.model_thinking is False
    assert settings.model_timeout_seconds == 60
    assert settings.model_max_retries == 2
    assert settings.deepseek_api_key is None
    assert str(settings.deepseek_base_url) == "https://api.deepseek.com/"


def test_thinking_true_is_parsed_then_rejected_as_uncertified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_THINKING", "true")

    with pytest.raises(ValidationError, match="not certified"):
        settings_without_dotenv()


def test_invalid_thinking_boolean_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_THINKING", "sometimes")

    with pytest.raises(ValidationError) as error:
        settings_without_dotenv()

    assert error.value.error_count() == 1
    assert "not certified" not in str(error.value)


def test_uncertified_pro_model_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_NAME", "deepseek-v4-pro")

    with pytest.raises(ValidationError, match="not certified"):
        settings_without_dotenv()


def test_non_deepseek_provider_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai")

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize("value", ["0", "-0.1"])
def test_non_positive_timeout_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("MODEL_TIMEOUT_SECONDS", value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


def test_negative_retry_count_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_MAX_RETRIES", "-1")

    with pytest.raises(ValidationError):
        settings_without_dotenv()


def test_invalid_base_url_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "not-a-url")

    with pytest.raises(ValidationError):
        settings_without_dotenv()


def test_api_key_uses_secret_type_and_is_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_key = "test-secret-value-that-must-not-leak"
    monkeypatch.setenv("DEEPSEEK_API_KEY", raw_key)

    settings = settings_without_dotenv()

    assert isinstance(settings.deepseek_api_key, SecretStr)
    assert settings.require_deepseek_api_key().get_secret_value() == raw_key
    assert raw_key not in repr(settings)
    assert raw_key not in repr(settings.model_dump())
    assert raw_key not in str(settings.model_dump(mode="json"))

    monkeypatch.setenv("MODEL_NAME", "deepseek-v4-pro")
    with pytest.raises(ValidationError) as error:
        settings_without_dotenv()
    assert raw_key not in str(error.value)


@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_or_empty_api_key_fails_at_production_credential_boundary(
    monkeypatch: pytest.MonkeyPatch,
    value: str | None,
) -> None:
    if value is not None:
        monkeypatch.setenv("DEEPSEEK_API_KEY", value)
    settings = settings_without_dotenv()

    with pytest.raises(ConfigurationInvalidError) as error:
        settings.require_deepseek_api_key()

    assert error.value.code == "configuration_invalid"
    assert "DEEPSEEK_API_KEY" in str(error.value)
