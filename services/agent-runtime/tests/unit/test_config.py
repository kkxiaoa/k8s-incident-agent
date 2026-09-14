from pathlib import Path

import pytest
from pydantic import SecretStr, ValidationError

import k8s_incident_agent.config as config_module
from k8s_incident_agent.config import (
    ConfigurationInvalidError,
    PatchValidatorSettings,
    Settings,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

MODEL_ENVIRONMENT_VARIABLES = (
    "MODEL_PROVIDER",
    "MODEL_NAME",
    "MODEL_THINKING",
    "MODEL_TIMEOUT_SECONDS",
    "MODEL_MAX_RETRIES",
    "RUNTIME_RETENTION_DAYS",
    "INCIDENT_INTAKE_MODE",
    "SANDBOX_EXECUTION_ENABLED",
    "EXECUTOR_HMAC_KEY_FILE",
    "KUBERNETES_CREDENTIAL_MODE",
    "KUBERNETES_CLUSTER_ID",
    "KUBERNETES_DIAGNOSTIC_NAMESPACE",
    "KUBERNETES_TIMEOUT_SECONDS",
    "AGENT_MAX_MODEL_CALLS",
    "AGENT_MAX_TOOL_CALLS",
    "AGENT_TIMEOUT_SECONDS",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "RUNTIME_DATA_DIR",
    "SCENARIO_CATALOG_DIR",
    "ALERT_CATALOG_DIR",
    "ALERTMANAGER_WEBHOOK_TOKEN_FILE",
    "PROMETHEUS_BASE_URL",
    "PATCH_VALIDATOR_BASE_URL",
    "PATCH_VALIDATOR_HMAC_KEY_FILE",
    "PATCH_VALIDATOR_TIMEOUT_SECONDS",
    "PATCH_VALIDATOR_AUTH_FRESHNESS_SECONDS",
    "PATCH_VALIDATOR_REPLAY_CAPACITY",
)


def settings_without_dotenv() -> Settings:
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


@pytest.fixture(autouse=True)
def isolate_settings_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    for variable in MODEL_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setattr(config_module, "REPOSITORY_ROOT", tmp_path)


def test_settings_use_certified_runtime_defaults(tmp_path: Path) -> None:
    settings = settings_without_dotenv()

    assert settings.model_provider == "deepseek"
    assert settings.model_name == "deepseek-flash"
    assert settings.model_thinking is False
    assert settings.sandbox_execution_enabled is False
    assert settings.executor_hmac_key_file is None
    assert settings.model_timeout_seconds == 60
    assert settings.model_max_retries == 2
    assert settings.runtime_retention_days == 7
    assert settings.incident_intake_mode == "manual"
    assert settings.kubernetes_credential_mode == "kind_kubeconfig"
    assert settings.kubernetes_cluster_id == "k8s-incident-agent"
    assert settings.kubernetes_diagnostic_namespace == "k8s-incident-scenarios"
    assert settings.kubernetes_timeout_seconds == 10
    assert settings.agent_max_model_calls == 8
    assert settings.agent_max_tool_calls == 6
    assert settings.agent_timeout_seconds == 180
    assert settings.deepseek_api_key is None
    assert str(settings.deepseek_base_url) == "https://api.deepseek.com/"
    assert settings.runtime_paths.root == tmp_path / ".runtime"
    assert settings.scenario_catalog_dir == tmp_path / "scenarios"
    assert settings.alert_catalog_dir == tmp_path / "monitoring" / "catalog"
    assert settings.alertmanager_webhook_token_file is None
    assert str(settings.prometheus_base_url) == (
        "http://prometheus.k8s-incident-monitoring.svc.cluster.local:9090/"
    )
    assert str(settings.patch_validator_base_url) == (
        "http://patch-validator.k8s-incident-agent.svc.cluster.local:8081/"
    )
    assert settings.patch_validator_hmac_key_file == Path(
        "/var/run/secrets/k8s-incident-agent/patch-validator/hmac-key"
    )
    assert settings.patch_validator_timeout_seconds == 10


def test_runtime_data_dir_is_projected_once_to_runtime_paths(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runtime_root = tmp_path / "runtime"
    monkeypatch.setenv("RUNTIME_DATA_DIR", str(runtime_root))

    settings = settings_without_dotenv()

    assert settings.runtime_paths == RuntimePaths(
        root=runtime_root,
        business_database=runtime_root / "incidents.sqlite3",
        checkpoint_database=runtime_root / "checkpoints.sqlite3",
        diagnostic_kubeconfig=runtime_root / "diagnostic.kubeconfig",
        runtime_lock=runtime_root / "runtime.lock",
        run_artifacts=runtime_root / "runs",
    )


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


@pytest.mark.parametrize("model_name", ["deepseek-v4-flash", "deepseek-v4-pro"])
def test_uncertified_model_id_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    model_name: str,
) -> None:
    monkeypatch.setenv("MODEL_NAME", model_name)

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


@pytest.mark.parametrize("value", ["0", "31"])
def test_retention_days_outside_safe_range_are_rejected(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("RUNTIME_RETENTION_DAYS", value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("KUBERNETES_TIMEOUT_SECONDS", "0"),
        ("AGENT_MAX_MODEL_CALLS", "0"),
        ("AGENT_MAX_TOOL_CALLS", "0"),
        ("AGENT_TIMEOUT_SECONDS", "0"),
        ("PATCH_VALIDATOR_TIMEOUT_SECONDS", "0"),
    ],
)
def test_task_11_budgets_must_be_positive(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
) -> None:
    monkeypatch.setenv(name, value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("INCIDENT_INTAKE_MODE", "development"),
        ("KUBERNETES_CREDENTIAL_MODE", "auto"),
    ],
)
def test_runtime_modes_reject_unknown_values(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
) -> None:
    monkeypatch.setenv(name, value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("KUBERNETES_CLUSTER_ID", " cluster"),
        ("KUBERNETES_DIAGNOSTIC_NAMESPACE", "namespace\nvalue"),
    ],
)
def test_kubernetes_scope_must_be_normalized(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
) -> None:
    monkeypatch.setenv(name, value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize("value", ["relative/scenarios", "/"])
def test_scenario_catalog_dir_must_be_absolute_and_dedicated(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("SCENARIO_CATALOG_DIR", value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("ALERT_CATALOG_DIR", "relative/catalog"),
        ("ALERT_CATALOG_DIR", "/"),
        ("ALERTMANAGER_WEBHOOK_TOKEN_FILE", "relative/credential"),
        ("ALERTMANAGER_WEBHOOK_TOKEN_FILE", "/"),
    ],
)
def test_alertmanager_paths_must_be_absolute_and_dedicated(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
) -> None:
    monkeypatch.setenv(name, value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


def test_invalid_base_url_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "not-a-url")

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize(
    "value",
    [
        "https://user:password@provider.example",
        "https://provider.example?api_key=test-value",
        "https://provider.example#fragment",
    ],
)
def test_base_url_rejects_embedded_credentials_query_or_fragment(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("DEEPSEEK_BASE_URL", value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


@pytest.mark.parametrize(
    "value",
    [
        "https://prometheus.k8s-incident-monitoring.svc.cluster.local:9090",
        "http://prometheus.example:9090",
        "http://prometheus.k8s-incident-monitoring.svc.cluster.local:9091",
        "http://user:password@localhost:9090",
        "http://localhost:9090/api/v1",
        "http://localhost:9090?token=value",
    ],
)
def test_prometheus_url_rejects_unmanaged_or_sensitive_locations(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("PROMETHEUS_BASE_URL", value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


def test_prometheus_url_allows_loopback_for_local_development(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PROMETHEUS_BASE_URL", "http://127.0.0.1:9090")

    settings = settings_without_dotenv()

    assert str(settings.prometheus_base_url) == "http://127.0.0.1:9090/"


@pytest.mark.parametrize(
    "value",
    [
        "https://patch-validator.k8s-incident-agent.svc.cluster.local:8081",
        "http://patch-validator.example:8081",
        "http://patch-validator.k8s-incident-agent.svc.cluster.local:8082",
        "http://user:password@localhost:8081",
        "http://localhost:8081/internal",
        "http://localhost:8081?token=value",
    ],
)
def test_patch_validator_url_rejects_unmanaged_or_sensitive_locations(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("PATCH_VALIDATOR_BASE_URL", value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


def test_patch_validator_url_allows_loopback_for_local_testing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PATCH_VALIDATOR_BASE_URL", "http://127.0.0.1:8081")

    settings = settings_without_dotenv()

    assert str(settings.patch_validator_base_url) == "http://127.0.0.1:8081/"


@pytest.mark.parametrize(
    "value",
    ["relative/key", "/"],
)
def test_patch_validator_key_path_must_be_absolute_and_dedicated(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("PATCH_VALIDATOR_HMAC_KEY_FILE", value)

    with pytest.raises(ValidationError):
        settings_without_dotenv()


def test_patch_validator_process_settings_have_only_narrow_dependencies() -> None:
    settings = PatchValidatorSettings(_env_file=None)  # pyright: ignore[reportCallIssue]

    assert set(type(settings).model_fields) == {
        "kubernetes_cluster_id",
        "kubernetes_diagnostic_namespace",
        "kubernetes_timeout_seconds",
        "patch_validator_hmac_key_file",
        "patch_validator_auth_freshness_seconds",
        "patch_validator_replay_capacity",
    }
    assert settings.patch_validator_auth_freshness_seconds == 30
    assert settings.patch_validator_replay_capacity == 4096


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
