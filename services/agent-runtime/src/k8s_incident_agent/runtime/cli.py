import argparse
import asyncio
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Literal

from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.repositories import PruneTarget
from k8s_incident_agent.runtime.retention import confirm_prune, preview_prune

type _PruneMode = Literal["preview", "confirm"]


def _parse_args(argv: Sequence[str] | None) -> _PruneMode:
    parser = argparse.ArgumentParser(prog="runtime", allow_abbrev=False)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prune_parser = subparsers.add_parser("prune", allow_abbrev=False)
    mode = prune_parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true")
    mode.add_argument("--confirm", action="store_true")
    arguments = parser.parse_args(argv)
    return "preview" if arguments.preview else "confirm"


def _target_payload(
    target: PruneTarget,
) -> dict[str, str | int | list[str]]:
    return {
        "artifactDirectories": [
            str(directory) for directory in target.artifact_directories
        ],
        "diagnosisRows": target.diagnosis_rows,
        "eventRows": target.event_rows,
        "evidenceRows": target.evidence_rows,
        "incidentId": str(target.incident_id),
        "runIds": [str(run_id) for run_id in target.run_ids],
        "runRows": target.run_rows,
        "updatedAt": target.updated_at.isoformat(),
    }


def main(argv: Sequence[str] | None = None) -> int:
    mode = _parse_args(argv)
    settings = Settings()
    now = datetime.now(UTC)
    if mode == "preview":
        targets = asyncio.run(preview_prune(settings, now))
    else:
        targets = asyncio.run(confirm_prune(settings, now)).deleted_targets
    print(
        json.dumps(
            {
                "mode": mode,
                "targets": [_target_payload(target) for target in targets],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0
