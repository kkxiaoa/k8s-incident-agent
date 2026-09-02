import json


class DuplicateJsonKeyError(ValueError):
    pass


def load_unique_json(payload: bytes) -> object:
    try:
        return json.loads(payload, object_pairs_hook=_unique_object)
    except (
        DuplicateJsonKeyError,
        RecursionError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        raise ValueError("JSON document is invalid") from None


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    document: dict[str, object] = {}
    for key, value in pairs:
        if key in document:
            raise DuplicateJsonKeyError
        document[key] = value
    return document
