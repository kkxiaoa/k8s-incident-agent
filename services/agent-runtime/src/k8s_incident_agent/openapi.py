import argparse
import json
from pathlib import Path
from typing import Any, cast

from k8s_incident_agent.api import create_app

_SCHEMA_REFERENCE_PREFIX = "#/components/schemas/"


def _schema_references(value: object) -> set[str]:
    references: set[str] = set()
    if isinstance(value, dict):
        mapping = cast(dict[str, object], value)
        reference = mapping.get("$ref")
        if isinstance(reference, str) and reference.startswith(
            _SCHEMA_REFERENCE_PREFIX
        ):
            references.add(reference.removeprefix(_SCHEMA_REFERENCE_PREFIX))
        for nested in mapping.values():
            references.update(_schema_references(nested))
    elif isinstance(value, list):
        for nested in cast(list[object], value):
            references.update(_schema_references(nested))
    return references


def _prune_unreferenced_schemas(document: dict[str, Any]) -> None:
    components = cast(dict[str, Any], document.get("components", {}))
    schemas = cast(dict[str, Any], components.get("schemas", {}))
    roots = {key: value for key, value in document.items() if key != "components"}
    component_roots = {
        key: value for key, value in components.items() if key != "schemas"
    }
    references = _schema_references(roots) | _schema_references(component_roots)
    pending = list(references)
    while pending:
        name = pending.pop()
        schema = schemas.get(name)
        if schema is None:
            continue
        for dependency in _schema_references(schema) - references:
            references.add(dependency)
            pending.append(dependency)
    components["schemas"] = {
        name: schema for name, schema in schemas.items() if name in references
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent-runtime-openapi",
        allow_abbrev=False,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    export = subparsers.add_parser("export", allow_abbrev=False)
    export.add_argument("--output", required=True, type=Path)
    return parser


def main() -> None:
    arguments = _parser().parse_args()
    output: Path = arguments.output
    schema = create_app(include_alertmanager_route=True).openapi()
    _prune_unreferenced_schemas(schema)
    document = json.dumps(
        schema,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    output.write_text(f"{document}\n", encoding="utf-8")
