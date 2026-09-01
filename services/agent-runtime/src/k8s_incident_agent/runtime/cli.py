import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Literal

from pydantic import ValidationError
from pydantic_settings import SettingsError

from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.repositories import PruneTarget
from k8s_incident_agent.runtime.reset import (
    ResetPlan,
    ResetResult,
    StageOneResetError,
    confirm_stage_one_data,
    preview_stage_one_data,
)
from k8s_incident_agent.runtime.retention import confirm_prune, preview_prune

type _ExecutionMode = Literal["preview", "confirm"]
type _RuntimeCommand = Literal["prune", "reset-stage-one-data"]


def _parse_args(argv: Sequence[str] | None) -> tuple[_RuntimeCommand, _ExecutionMode]:
    parser = argparse.ArgumentParser(prog="runtime", allow_abbrev=False)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prune_parser = subparsers.add_parser("prune", allow_abbrev=False)
    _add_mode_arguments(prune_parser)
    reset_parser = subparsers.add_parser(
        "reset-stage-one-data",
        allow_abbrev=False,
    )
    _add_mode_arguments(reset_parser)
    arguments = parser.parse_args(argv)
    command_name = arguments.command
    if command_name not in ("prune", "reset-stage-one-data"):
        raise RuntimeError("Unknown Runtime command")
    return command_name, "preview" if arguments.preview else "confirm"


def _add_mode_arguments(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true")
    mode.add_argument("--confirm", action="store_true")


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


def _reset_plan_payload(plan: ResetPlan) -> dict[str, object]:
    return {
        "sourceHead": plan.source_head,
        "state": plan.state.value,
        "targetHead": plan.target_head,
        "targets": {
            "artifactRunIds": [str(run_id) for run_id in plan.artifact_run_ids],
            "businessFiles": list(plan.business_files),
            "checkpointFiles": list(plan.checkpoint_files),
            "rowCounts": dict(plan.row_counts),
            "runIds": [str(run_id) for run_id in plan.run_ids],
        },
    }


def _reset_result_payload(result: ResetResult) -> dict[str, object]:
    return {
        **_reset_plan_payload(result.plan),
        "completedAt": result.completed_at.isoformat().replace("+00:00", "Z"),
        "deleted": {
            "artifactRunIds": [
                str(run_id) for run_id in result.deleted_artifact_run_ids
            ],
            "businessFiles": list(result.deleted_business_files),
            "checkpointFiles": list(result.deleted_checkpoint_files),
        },
        "newHead": result.new_head,
        "outcome": result.outcome.value,
    }


def _emit_reset_error(
    code: str,
    phase: str,
    mode: _ExecutionMode,
) -> None:
    print(
        json.dumps(
            {
                "error": {
                    "code": code,
                    "phase": phase,
                },
                "mode": mode,
            },
            separators=(",", ":"),
            sort_keys=True,
        ),
        file=sys.stderr,
    )


def main(argv: Sequence[str] | None = None) -> int:
    command_name, mode = _parse_args(argv)
    if command_name == "reset-stage-one-data":
        try:
            settings = Settings()
            if mode == "preview":
                reset_payload = _reset_plan_payload(preview_stage_one_data(settings))
            else:
                reset_payload = _reset_result_payload(confirm_stage_one_data(settings))
        except (OSError, SettingsError, ValidationError):
            _emit_reset_error("configuration_invalid", "preflight", mode)
            return 1
        except StageOneResetError as error:
            _emit_reset_error(error.code, error.phase, mode)
            return 1
        print(
            json.dumps(
                {"mode": mode, **reset_payload},
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return 0

    now = datetime.now(UTC)
    settings = Settings()
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
