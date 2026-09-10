from collections.abc import Callable

import httpx
import pytest

from k8s_incident_agent.config import Settings
from k8s_incident_agent.model.discovery import discover_models
from k8s_incident_agent.model.errors import ModelError, ModelErrorCode

Handler = Callable[[httpx.Request], httpx.Response]

INVALID_MODEL_PAYLOADS: list[object] = [
    {},
    {"data": None},
    {"data": {}},
    {"data": []},
    {"data": ["deepseek-flash"]},
    {"data": [{}]},
    {"data": [{"id": 1}]},
    {"data": [{"id": ""}]},
    {"data": [{"id": "   "}]},
    {"data": [{"id": " deepseek-flash"}]},
]


def make_settings(
    monkeypatch: pytest.MonkeyPatch,
    *,
    max_retries: int = 2,
) -> Settings:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-discovery-key")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://provider.example/api")
    monkeypatch.setenv("MODEL_MAX_RETRIES", str(max_retries))
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


async def call_discovery(settings: Settings, handler: Handler) -> tuple[str, ...]:
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        return await discover_models(settings, client=client)


def assert_sanitized(error: ModelError, *forbidden_values: str) -> None:
    rendered = repr(error)
    for value in forbidden_values:
        assert value not in rendered

    traceback = error.__traceback__
    while traceback is not None:
        module_name = traceback.tb_frame.f_globals.get("__name__")
        if isinstance(module_name, str) and module_name.startswith(
            "k8s_incident_agent"
        ):
            frame_locals = repr(traceback.tb_frame.f_locals)
            for value in forbidden_values:
                assert value not in frame_locals
        traceback = traceback.tb_next


async def test_discover_models_projects_official_ids_and_request_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "object": "list",
                "data": [
                    {
                        "id": "deepseek-flash",
                        "object": "model",
                        "owned_by": "deepseek",
                        "ignored": "upstream metadata",
                    },
                    {
                        "id": "deepseek-v4-pro",
                        "object": "model",
                        "owned_by": "deepseek",
                    },
                ],
                "ignored": "top-level metadata",
            },
        )

    model_ids = await call_discovery(settings, handler)

    assert model_ids == ("deepseek-flash", "deepseek-v4-pro")
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "GET"
    assert str(request.url) == "https://provider.example/api/models"
    assert request.headers["Authorization"] == "Bearer test-discovery-key"
    assert request.extensions["timeout"] == {
        "connect": 60.0,
        "read": 60.0,
        "write": 60.0,
        "pool": 60.0,
    }


async def test_missing_configured_model_is_not_retried_and_is_sanitized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            200,
            json={
                "data": [{"id": "deepseek-v4-pro"}],
                "debug": "sensitive upstream response body",
            },
        )

    with pytest.raises(ModelError) as error:
        await call_discovery(settings, handler)

    assert attempts == 1
    assert error.value.code is ModelErrorCode.MODEL_NOT_FOUND
    assert_sanitized(
        error.value,
        "test-discovery-key",
        "Bearer",
        "sensitive upstream response body",
    )


async def test_explicit_probe_model_can_be_checked_without_changing_runtime_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "deepseek-v4-pro"}]})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        model_ids = await discover_models(
            settings,
            expected_model="deepseek-v4-pro",
            client=client,
        )

    assert model_ids == ("deepseek-v4-pro",)
    assert settings.model_name == "deepseek-flash"


@pytest.mark.parametrize(
    "payload",
    INVALID_MODEL_PAYLOADS,
    ids=[
        "missing-data",
        "null-data",
        "object-data",
        "empty-data",
        "non-object-model",
        "missing-id",
        "non-string-id",
        "empty-id",
        "whitespace-id",
        "unnormalized-id",
    ],
)
async def test_invalid_model_payload_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    payload: object,
) -> None:
    settings = make_settings(monkeypatch)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with pytest.raises(ModelError) as error:
        await call_discovery(settings, handler)

    assert error.value.code is ModelErrorCode.PROVIDER_CONTRACT_INVALID


@pytest.mark.parametrize("status_code", [401, 403])
async def test_authentication_failure_is_not_retried_or_leaked(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
) -> None:
    settings = make_settings(monkeypatch)
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            status_code,
            text="sensitive authentication response body",
        )

    with pytest.raises(ModelError) as error:
        await call_discovery(settings, handler)

    assert attempts == 1
    assert error.value.code is ModelErrorCode.AUTHENTICATION_FAILED
    assert_sanitized(
        error.value,
        "test-discovery-key",
        "Bearer",
        "sensitive authentication response body",
    )


@pytest.mark.parametrize(
    ("status_code", "expected_code"),
    [
        (429, ModelErrorCode.PROVIDER_RATE_LIMITED),
        (500, ModelErrorCode.PROVIDER_UNAVAILABLE),
        (503, ModelErrorCode.PROVIDER_UNAVAILABLE),
    ],
)
async def test_recoverable_status_is_retried_with_the_last_error_preserved(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    expected_code: ModelErrorCode,
) -> None:
    settings = make_settings(monkeypatch, max_retries=2)
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(status_code, text="sensitive retry response body")

    with pytest.raises(ModelError) as error:
        await call_discovery(settings, handler)

    assert attempts == 3
    assert error.value.code is expected_code
    assert_sanitized(error.value, "test-discovery-key", "sensitive retry response body")


async def test_transport_failure_is_bounded_and_sanitized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch, max_retries=1)
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ReadTimeout(
            "transport detail with test-discovery-key",
            request=request,
        )

    with pytest.raises(ModelError) as error:
        await call_discovery(settings, handler)

    assert attempts == 2
    assert error.value.code is ModelErrorCode.PROVIDER_UNAVAILABLE
    assert error.value.__context__ is None
    assert_sanitized(error.value, "test-discovery-key", "transport detail")


@pytest.mark.parametrize("status_code", [204, 400, 404])
async def test_other_http_status_is_a_non_retryable_contract_error(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
) -> None:
    settings = make_settings(monkeypatch)
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(status_code)

    with pytest.raises(ModelError) as error:
        await call_discovery(settings, handler)

    assert attempts == 1
    assert error.value.code is ModelErrorCode.PROVIDER_CONTRACT_INVALID


async def test_invalid_json_body_is_not_exposed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"sensitive invalid json response")

    with pytest.raises(ModelError) as error:
        await call_discovery(settings, handler)

    assert error.value.code is ModelErrorCode.PROVIDER_CONTRACT_INVALID
    assert error.value.__context__ is None
    assert_sanitized(error.value, "sensitive invalid json response")
