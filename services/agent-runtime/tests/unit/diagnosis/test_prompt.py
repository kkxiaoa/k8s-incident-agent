import pytest

from k8s_incident_agent.diagnosis.prompt import build_diagnostic_system_prompt

ALLOWED_TOOLS = ("get_workload", "get_pods", "get_events", "query_prometheus")
REQUIRED_EVIDENCE = ("workload", "pods", "events")


def test_prompt_encodes_evidence_and_untrusted_content_boundaries() -> None:
    prompt = build_diagnostic_system_prompt(
        max_model_calls=8,
        max_tool_calls=6,
        allowed_tool_names=ALLOWED_TOOLS,
        required_evidence=REQUIRED_EVIDENCE,
        prometheus_panel_ids=("image-pull-affected-pods",),
    )
    lowered = prompt.lower()

    assert "evidenceid" in lowered
    assert "untrusted" in lowered
    assert "get_workload" in prompt
    assert "get_pods" in prompt
    assert "get_events" in prompt
    assert "query_prometheus" in prompt
    assert "image-pull-affected-pods" in prompt
    assert "successful query completes that panel's Evidence" in prompt
    assert "do not query the same panel again" in prompt
    assert "read-only" in lowered
    assert "insufficient_evidence" in prompt
    assert "8" in prompt
    assert "6" in prompt
    assert "structured response" in lowered


@pytest.mark.parametrize(
    "forbidden",
    [
        "private-scenario",
        "image_pull_failure",
        "expected_root_causes",
        "required_evidence",
        "allowed_tools",
        "forbidden_tools",
        "deterministic_verifier",
        "apply_patch",
        "execute_shell",
    ],
)
def test_prompt_does_not_leak_private_expectations_or_write_capabilities(
    forbidden: str,
) -> None:
    prompt = build_diagnostic_system_prompt(
        max_model_calls=8,
        max_tool_calls=6,
        allowed_tool_names=ALLOWED_TOOLS,
        required_evidence=REQUIRED_EVIDENCE,
        prometheus_panel_ids=("image-pull-affected-pods",),
    )

    assert forbidden.casefold() not in prompt.casefold()


@pytest.mark.parametrize(
    ("max_model_calls", "max_tool_calls"),
    [(0, 6), (8, 0), (-1, 6), (8, -1), (True, 6), (8, False)],
)
def test_prompt_rejects_invalid_runtime_budgets(
    max_model_calls: int,
    max_tool_calls: int,
) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        build_diagnostic_system_prompt(
            max_model_calls=max_model_calls,
            max_tool_calls=max_tool_calls,
            allowed_tool_names=ALLOWED_TOOLS,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panel_ids=("image-pull-affected-pods",),
        )


@pytest.mark.parametrize(
    ("panel_ids", "message"),
    [
        ((), "match the allowed tool set"),
        (("duplicate", "duplicate"), "must be unique"),
    ],
)
def test_prompt_rejects_empty_or_duplicate_panel_identifiers(
    panel_ids: tuple[str, ...],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        build_diagnostic_system_prompt(
            max_model_calls=8,
            max_tool_calls=6,
            allowed_tool_names=ALLOWED_TOOLS,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panel_ids=panel_ids,
        )
