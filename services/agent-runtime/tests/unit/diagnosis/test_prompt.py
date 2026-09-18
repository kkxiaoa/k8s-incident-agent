import pytest

from k8s_incident_agent.diagnosis.policy_contracts import (
    DiagnosticPanel,
    DiagnosticPanelName,
)
from k8s_incident_agent.diagnosis.prompt import build_diagnostic_system_prompt
from k8s_incident_agent.diagnosis.tool_execution import OBSERVATION_LIMIT

ALLOWED_TOOLS = ("get_workload", "get_pods", "get_events", "query_prometheus")
REQUIRED_EVIDENCE = ("workload",)
PANELS = (
    DiagnosticPanel(
        "image-pull-affected-pods",
        "Affected pods",
        "pods",
        "Registered purpose.",
        "target",
        "higher_is_worse",
    ),
    DiagnosticPanel(
        "crash-loop-restarts",
        "Container restarts",
        "restarts",
        "Registered purpose.",
        "target",
        "higher_is_worse",
    ),
)
OTHER_PANELS = (DiagnosticPanelName("oom-killed-containers", "OOM killed containers"),)


def test_prompt_encodes_evidence_and_untrusted_content_boundaries() -> None:
    prompt = build_diagnostic_system_prompt(
        max_model_calls=8,
        max_tool_calls=6,
        allowed_tool_names=ALLOWED_TOOLS,
        required_evidence=REQUIRED_EVIDENCE,
        prometheus_panels=PANELS,
        other_panels=OTHER_PANELS,
        trigger_panel_id="image-pull-affected-pods",
        trigger_duration="10m",
        repair_action="set_container_image",
    )
    normalized = " ".join(prompt.split())
    lowered = normalized.lower()

    assert "evidenceid" in lowered
    assert "untrusted" in lowered
    assert "get_workload" in prompt
    assert "get_pods" in prompt
    assert "get_events" in prompt
    assert "query_prometheus" in prompt
    assert (
        "  - image-pull-affected-pods — Affected pods (pods) [target|higher]: "
        "Registered purpose." in prompt
    )
    assert (
        "  - crash-loop-restarts — Container restarts (restarts) [target|higher]: "
        "Registered purpose." in prompt
    )
    assert "container = one per regular container" in prompt
    assert (
        "oom-killed-containers (OOM killed containers)" in prompt
        and "OOM killed containers (" not in prompt
    )
    assert (
        "condition had held for 10m, and occurredAt is the moment it started firing"
        in normalized
    )
    assert "use a window wider than that duration" in normalized
    assert "start with anchor=occurrence" in normalized
    assert "runStartedAt" in normalized
    assert "never less than its stated interval" in normalized
    assert "when empty" not in prompt
    assert "image-pull-affected-pods is the registered signal of the alert rule" in (
        normalized
    )
    assert "not the alert's firing or resolved state" in normalized
    assert "Query it first" in normalized
    assert "does not mean the alert or incident has resolved" in normalized
    # Direction-neutral: Service panels alert when the value is low.
    assert "non-alerting side of its threshold (see the result's riskDirection)" in (
        normalized
    )
    assert "below its threshold" not in normalized
    assert "describe when samples were on the alerting side" in normalized
    assert "use current Kubernetes Evidence to judge whether the symptom persists" in (
        normalized
    )
    assert "never show that this alert's condition held" in normalized
    assert "one longer window may be queried" in normalized
    assert "record that in missing_information rather than inferring the symptom" in (
        normalized
    )
    assert "Never conclude from panel values alone" in normalized
    assert "Do not sweep panels, windows or anchors" in normalized
    # The stated caps must be the ones the repository enforces, and the counting
    # rule must match it: every attempt counts except a retryable failure.
    assert (
        f"counts every attempt other than a retryable failure and admits at most "
        f"{OBSERVATION_LIMIT} per tool"
    ) in normalized
    assert (
        f"admits at most {OBSERVATION_LIMIT} per panel, window and anchor" in normalized
    )
    assert "start with anchor=occurrence" in normalized
    assert "rangeStart and rangeEnd are the data window" in normalized
    assert "a limit series is configuration, not usage" in normalized
    assert "A neutral panel is context" in normalized
    assert "actual sample timestamps" in prompt
    assert "absent points are unknown" in prompt
    assert "currentValue is the last point of a target panel" in prompt
    assert "summary as well as every root-cause statement" in normalized
    assert "distinct causal mechanism" in normalized
    assert "Do not split a cause and its consequences" in normalized
    assert "evidence-supported inference" in normalized
    assert "continuing causal impact" in normalized
    assert "not every unperformed check" in normalized
    assert "Missing observations do not prove absence" in normalized
    assert "A refused call still spends budget" in normalized
    assert "it is not a tool failure" in normalized
    assert "keeps the last tool call and the last model call" in normalized
    assert "The alert only located the target" in normalized
    assert "identity Evidence: workload" in normalized
    assert "read-only" in lowered
    assert "insufficient_evidence" in prompt
    assert "at most 8 model calls and 6 total" in normalized
    assert "structured response" in lowered
    assert "set_container_image" in prompt
    assert "immediately preceding revision" in prompt
    assert "raw patch" in prompt


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
        prometheus_panels=PANELS,
        trigger_panel_id="image-pull-affected-pods",
        repair_action="set_container_image",
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
            prometheus_panels=(PANELS[0],),
            trigger_panel_id=PANELS[0].panel_id,
            repair_action="set_container_image",
        )


@pytest.mark.parametrize(
    ("panels", "message"),
    [
        ((), "match the allowed tool set"),
        ((PANELS[0], PANELS[0]), "must be unique"),
    ],
)
def test_prompt_rejects_empty_or_duplicate_panel_identifiers(
    panels: tuple[DiagnosticPanel, ...],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        build_diagnostic_system_prompt(
            max_model_calls=8,
            max_tool_calls=6,
            allowed_tool_names=ALLOWED_TOOLS,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=panels,
            trigger_panel_id=None,
            repair_action="set_container_image",
        )


def test_prompt_rejects_a_trigger_panel_outside_the_admitted_set() -> None:
    with pytest.raises(ValueError, match="Trigger panel"):
        build_diagnostic_system_prompt(
            max_model_calls=8,
            max_tool_calls=6,
            allowed_tool_names=ALLOWED_TOOLS,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=(PANELS[0],),
            trigger_panel_id="crash-loop-restarts",
            repair_action=None,
        )


def test_prompt_requires_a_trigger_panel_whenever_panels_are_admitted() -> None:
    with pytest.raises(ValueError, match="Trigger panel"):
        build_diagnostic_system_prompt(
            max_model_calls=8,
            max_tool_calls=6,
            allowed_tool_names=ALLOWED_TOOLS,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=(PANELS[0],),
            trigger_panel_id=None,
            repair_action=None,
        )
