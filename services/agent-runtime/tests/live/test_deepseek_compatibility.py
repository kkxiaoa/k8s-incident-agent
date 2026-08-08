import pytest

from k8s_incident_agent.config import ConfigurationInvalidError, Settings
from k8s_incident_agent.model.compatibility import (
    ProbeConfig,
    ThinkingMode,
    run_compatibility_probe,
)


@pytest.mark.live_model
async def test_deepseek_flash_non_thinking_capability_gate() -> None:
    settings = Settings(
        model_provider="deepseek",
        model_name="deepseek-v4-flash",
        model_thinking=False,
    )
    try:
        settings.require_deepseek_api_key()
    except ConfigurationInvalidError:
        pytest.skip("DEEPSEEK_API_KEY is not configured")

    report = await run_compatibility_probe(
        settings,
        ProbeConfig(
            model_name="deepseek-v4-flash",
            thinking=ThinkingMode.DISABLED,
        ),
    )

    assert report.passed, report.model_dump_json(by_alias=True)
