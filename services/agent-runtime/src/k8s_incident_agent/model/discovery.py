from contextlib import suppress

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from k8s_incident_agent.config import Settings
from k8s_incident_agent.model.errors import ModelError, ModelErrorCode


class _ModelEntry(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True, strict=True)

    id: str = Field(min_length=1)

    @field_validator("id")
    @classmethod
    def reject_unnormalized_id(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("model id must not contain surrounding whitespace")
        return value


class _ModelsResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True, strict=True)

    data: list[_ModelEntry] = Field(min_length=1)


def _models_url(settings: Settings) -> httpx.URL:
    base_url = httpx.URL(str(settings.deepseek_base_url))
    path = f"{base_url.path.rstrip('/')}/models"
    return base_url.copy_with(path=path)


def _error(code: ModelErrorCode) -> ModelError:
    messages = {
        ModelErrorCode.AUTHENTICATION_FAILED: "DeepSeek authentication failed",
        ModelErrorCode.MODEL_NOT_FOUND: "Configured DeepSeek model is unavailable",
        ModelErrorCode.PROVIDER_RATE_LIMITED: "DeepSeek model discovery was rate limited",
        ModelErrorCode.PROVIDER_UNAVAILABLE: "DeepSeek model discovery is unavailable",
        ModelErrorCode.PROVIDER_CONTRACT_INVALID: (
            "DeepSeek model discovery returned an invalid response"
        ),
    }
    return ModelError(code, messages[code])


def _parse_model_ids(response: httpx.Response) -> tuple[str, ...] | None:
    document: _ModelsResponse | None = None
    with suppress(ValidationError):
        document = _ModelsResponse.model_validate_json(response.content)
    if document is None:
        return None
    return tuple(model.id for model in document.data)


async def _request_models(
    settings: Settings,
    client: httpx.AsyncClient,
    url: httpx.URL,
) -> httpx.Response | None:
    response: httpx.Response | None = None
    api_key = settings.require_deepseek_api_key().get_secret_value()
    with suppress(httpx.TransportError):
        response = await client.get(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=settings.model_timeout_seconds,
        )
    return response


async def _discover_models(
    settings: Settings,
    client: httpx.AsyncClient,
) -> tuple[str, ...]:
    url = _models_url(settings)
    attempt = 0

    while True:
        response = await _request_models(settings, client, url)
        if response is None:
            if attempt < settings.model_max_retries:
                attempt += 1
                continue
            raise _error(ModelErrorCode.PROVIDER_UNAVAILABLE)

        status_code = response.status_code
        if status_code in (401, 403):
            del response
            raise _error(ModelErrorCode.AUTHENTICATION_FAILED)
        if status_code == 429:
            del response
            if attempt < settings.model_max_retries:
                attempt += 1
                continue
            raise _error(ModelErrorCode.PROVIDER_RATE_LIMITED)
        if 500 <= status_code <= 599:
            del response
            if attempt < settings.model_max_retries:
                attempt += 1
                continue
            raise _error(ModelErrorCode.PROVIDER_UNAVAILABLE)
        if status_code != 200:
            del response
            raise _error(ModelErrorCode.PROVIDER_CONTRACT_INVALID)

        model_ids = _parse_model_ids(response)
        del response
        if model_ids is None:
            raise _error(ModelErrorCode.PROVIDER_CONTRACT_INVALID)
        if settings.model_name not in model_ids:
            raise _error(ModelErrorCode.MODEL_NOT_FOUND)
        return model_ids


async def discover_models(
    settings: Settings,
    *,
    client: httpx.AsyncClient | None = None,
) -> tuple[str, ...]:
    if client is not None:
        return await _discover_models(settings, client)

    async with httpx.AsyncClient() as owned_client:
        return await _discover_models(settings, owned_client)
