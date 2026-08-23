from copy import deepcopy
from typing import cast
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate


def _diagnosed_payload() -> dict[str, object]:
    return {
        "outcome": "diagnosed",
        "summary": "The observations support a specific failure.",
        "root_causes": [
            {
                "code": "observed_failure",
                "statement": "The cited observations identify the failure.",
                "confidence": "high",
                "evidence_ids": [str(uuid4())],
            }
        ],
        "missing_information": [],
    }


def _insufficient_payload() -> dict[str, object]:
    return {
        "outcome": "insufficient_evidence",
        "summary": "The available observations do not establish a root cause.",
        "root_causes": [],
        "missing_information": ["A successful read of the target state is missing."],
    }


def test_candidate_accepts_canonical_uuid_strings_from_structured_output() -> None:
    payload = _diagnosed_payload()
    candidate = DiagnosisCandidate.model_validate(payload)

    evidence_id = candidate.root_causes[0].evidence_ids[0]
    assert isinstance(evidence_id, UUID)
    root_causes = cast(list[dict[str, object]], payload["root_causes"])
    evidence_ids = cast(list[str], root_causes[0]["evidence_ids"])
    assert str(evidence_id) == evidence_ids[0]


@pytest.mark.parametrize(
    "payload",
    [
        {
            **_diagnosed_payload(),
            "root_causes": [],
        },
        {
            **_insufficient_payload(),
            "root_causes": _diagnosed_payload()["root_causes"],
        },
        {
            **_insufficient_payload(),
            "missing_information": [],
        },
    ],
)
def test_outcome_constraints_reject_semantically_invalid_shapes(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        DiagnosisCandidate.model_validate(payload)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("summary", ""),
        ("summary", "s" * 1025),
        ("missing_information", ["m" * 513]),
    ],
)
def test_text_and_collection_budgets_are_enforced(
    field: str,
    value: object,
) -> None:
    payload = _insufficient_payload()
    payload[field] = value

    with pytest.raises(ValidationError):
        DiagnosisCandidate.model_validate(payload)


@pytest.mark.parametrize(
    "root_cause_update",
    [
        {"code": "Unknown-Code"},
        {"code": "a" * 65},
        {"statement": ""},
        {"statement": "s" * 1025},
        {"confidence": "certain"},
        {"evidence_ids": []},
        {"evidence_ids": [str(uuid4()) for _ in range(11)]},
        {"evidence_ids": [1]},
    ],
)
def test_root_cause_contract_rejects_invalid_fields(
    root_cause_update: dict[str, object],
) -> None:
    payload = _diagnosed_payload()
    root_causes = cast(list[dict[str, object]], payload["root_causes"])
    root_cause = deepcopy(root_causes[0])
    root_cause.update(root_cause_update)
    payload["root_causes"] = [root_cause]

    with pytest.raises(ValidationError):
        DiagnosisCandidate.model_validate(payload)


def test_evidence_ids_must_be_unique_within_a_root_cause() -> None:
    payload = _diagnosed_payload()
    evidence_id = str(uuid4())
    root_causes = cast(list[dict[str, object]], payload["root_causes"])
    root_causes[0]["evidence_ids"] = [
        evidence_id,
        evidence_id,
    ]

    with pytest.raises(ValidationError):
        DiagnosisCandidate.model_validate(payload)


def test_candidate_rejects_extra_fields_without_rendering_input() -> None:
    payload = _diagnosed_payload()
    payload["scenario_id"] = "private-scenario"

    with pytest.raises(ValidationError) as error:
        DiagnosisCandidate.model_validate(payload)

    rendered = str(error.value)
    assert "private-scenario" not in rendered


def test_candidate_rejects_type_coercion() -> None:
    payload = _diagnosed_payload()
    payload["summary"] = 123

    with pytest.raises(ValidationError):
        DiagnosisCandidate.model_validate(payload)
