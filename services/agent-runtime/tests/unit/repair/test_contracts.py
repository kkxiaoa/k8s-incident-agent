from uuid import uuid4

import pytest
from pydantic import ValidationError

from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate


def _diagnosis_payload() -> dict[str, object]:
    workload_id = str(uuid4())
    rollout_id = str(uuid4())
    return {
        "outcome": "diagnosed",
        "summary": "The current image cannot be pulled.",
        "root_causes": [
            {
                "code": "image_invalid_registry",
                "statement": "The configured image uses a reserved registry.",
                "confidence": "high",
                "evidence_ids": [workload_id, rollout_id],
            }
        ],
        "missing_information": [],
        "repair_intent": {
            "action": "set_container_image",
            "target": {
                "cluster": "k8s-incident-agent",
                "namespace": "k8s-incident-scenarios",
                "api_version": "apps/v1",
                "kind": "Deployment",
                "name": "image-pull-backoff",
            },
            "container_name": "workload",
            "replacement_image": "registry.k8s.io/e2e-test-images/agnhost:2.53",
            "evidence_ids": [workload_id, rollout_id],
        },
    }


def test_diagnosis_accepts_only_the_fixed_repair_intent() -> None:
    candidate = DiagnosisCandidate.model_validate(_diagnosis_payload())

    assert candidate.repair_intent is not None
    assert candidate.repair_intent.action == "set_container_image"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("action", "apply_manifest"),
        ("patch", [{"op": "replace", "path": "/spec/replicas", "value": 0}]),
        ("dry_run", False),
        ("resource", "secrets"),
        ("url", "https://kubernetes.default.svc"),
    ],
)
def test_repair_intent_rejects_arbitrary_write_inputs(
    field: str,
    value: object,
) -> None:
    payload = _diagnosis_payload()
    intent = payload["repair_intent"]
    assert isinstance(intent, dict)
    intent[field] = value

    with pytest.raises(ValidationError):
        DiagnosisCandidate.model_validate(payload)


def test_insufficient_evidence_cannot_carry_a_repair_intent() -> None:
    payload = _diagnosis_payload()
    payload["outcome"] = "insufficient_evidence"
    payload["root_causes"] = []
    payload["missing_information"] = ["A prior revision is required."]

    with pytest.raises(ValidationError):
        DiagnosisCandidate.model_validate(payload)
