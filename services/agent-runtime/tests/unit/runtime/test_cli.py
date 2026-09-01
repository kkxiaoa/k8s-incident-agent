import json
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest

import k8s_incident_agent.runtime.cli as cli_module
from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.repositories import PruneTarget
from k8s_incident_agent.runtime.retention import PruneResult

SERVICE_ROOT = Path(__file__).resolve().parents[3]
RUN_ID = UUID("00000000-0000-0000-0000-000000000001")
INCIDENT_ID = UUID("00000000-0000-0000-0000-000000000002")


@pytest.mark.parametrize("mode", ["preview", "confirm"])
def test_prune_cli_emits_exact_targets_for_selected_mode(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    mode: str,
) -> None:
    target = PruneTarget(
        incident_id=INCIDENT_ID,
        updated_at=datetime(2026, 9, 1, 8, 0, tzinfo=UTC),
        run_ids=(RUN_ID,),
        artifact_directories=(tmp_path / "runtime" / "runs" / str(RUN_ID),),
        event_rows=5,
        evidence_rows=1,
        diagnosis_rows=1,
        run_rows=1,
    )

    async def fake_preview(
        _settings: Settings, _now: object
    ) -> tuple[PruneTarget, ...]:
        return (target,)

    async def fake_confirm(_settings: Settings, _now: object) -> PruneResult:
        return PruneResult(deleted_targets=(target,))

    monkeypatch.setattr(
        cli_module,
        "Settings",
        lambda: cast(Settings, object()),
    )
    monkeypatch.setattr(cli_module, "preview_prune", fake_preview)
    monkeypatch.setattr(cli_module, "confirm_prune", fake_confirm)

    assert cli_module.main(["prune", f"--{mode}"]) == 0

    assert json.loads(capsys.readouterr().out) == {
        "mode": mode,
        "targets": [
            {
                "artifactDirectories": [str(target.artifact_directories[0])],
                "diagnosisRows": 1,
                "eventRows": 5,
                "evidenceRows": 1,
                "incidentId": str(INCIDENT_ID),
                "runIds": [str(RUN_ID)],
                "runRows": 1,
                "updatedAt": "2026-09-01T08:00:00+00:00",
            }
        ],
    }


@pytest.mark.parametrize(
    "arguments",
    [
        [],
        ["prune"],
        ["prune", "--preview", "--confirm"],
        ["prune", "--preview", "--run-id", str(RUN_ID)],
        ["prune", "--confirm", "--path", "/tmp/unsafe"],
        ["prune", "--preview", "--sql", "DELETE FROM agent_runs"],
        ["prune", "--con"],
        ["prune", "--pre"],
    ],
)
def test_prune_cli_rejects_missing_conflicting_or_expansive_arguments(
    arguments: list[str],
) -> None:
    with pytest.raises(SystemExit) as error:
        cli_module.main(arguments)

    assert error.value.code == 2


def test_runtime_console_script_uses_guarded_cli() -> None:
    pyproject = tomllib.loads(
        (SERVICE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )

    assert pyproject["project"]["scripts"]["runtime"] == (
        "k8s_incident_agent.runtime.cli:main"
    )
