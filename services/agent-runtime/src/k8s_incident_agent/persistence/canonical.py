import json
from typing import cast

from k8s_incident_agent.domain.models import JsonValue


def canonical_json(value: JsonValue) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def parse_json_object(value: str) -> dict[str, JsonValue]:
    parsed = cast(JsonValue, json.loads(value))
    if not isinstance(parsed, dict):
        raise ValueError("Expected a JSON object")
    return parsed
