import getpass
import json
import os
import pty
import secrets
import select
import stat
import subprocess
import sys
import termios
import time
import tomllib
import warnings
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from pydantic_settings import SettingsError

import k8s_incident_agent.runtime.cli as cli_module
import k8s_incident_agent.runtime.operator as operator_module
from k8s_incident_agent.auth.verifier import PasswordVerifier
from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.repositories import PruneTarget
from k8s_incident_agent.runtime.reset import (
    ResetOutcome,
    ResetPlan,
    ResetResult,
    ResetState,
    StageOneResetError,
    reset_plan_digest,
)
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
        repair_proposal_rows=1,
        run_rows=1,
        alert_signal_rows=1,
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
                "alertSignalRows": 1,
                "artifactDirectories": [str(target.artifact_directories[0])],
                "diagnosisRows": 1,
                "eventRows": 5,
                "evidenceRows": 1,
                "incidentId": str(INCIDENT_ID),
                "repairProposalRows": 1,
                "runIds": [str(RUN_ID)],
                "runRows": 1,
                "updatedAt": "2026-09-01T08:00:00+00:00",
            }
        ],
    }


@pytest.mark.parametrize("mode", ["preview", "confirm"])
def test_stage_one_reset_cli_emits_stable_safe_json(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    mode: str,
) -> None:
    plan = ResetPlan(
        state=ResetState.STAGE_ONE,
        source_head="20260814_0001",
        target_head="20260902_0003",
        business_files=("incidents.sqlite3-wal", "incidents.sqlite3"),
        checkpoint_files=("checkpoints.sqlite3",),
        run_ids=(RUN_ID,),
        artifact_run_ids=(RUN_ID,),
        row_counts=(("incidents", 1), ("agent_runs", 1)),
    )
    result = ResetResult(
        plan=plan,
        outcome=ResetOutcome.RESET,
        completed_at=datetime(2026, 9, 1, 8, 0, tzinfo=UTC),
        new_head="20260902_0003",
        deleted_business_files=plan.business_files,
        deleted_checkpoint_files=plan.checkpoint_files,
        deleted_artifact_run_ids=plan.artifact_run_ids,
    )

    def fake_reset_preview(_settings: Settings) -> ResetPlan:
        return plan

    def fake_reset_confirm(
        _settings: Settings,
        expected_plan_digest: str,
    ) -> ResetResult:
        assert expected_plan_digest == reset_plan_digest(plan)
        return result

    monkeypatch.setattr(
        cli_module,
        "Settings",
        lambda: cast(Settings, object()),
    )
    monkeypatch.setattr(cli_module, "preview_stage_one_data", fake_reset_preview)
    monkeypatch.setattr(cli_module, "confirm_stage_one_data", fake_reset_confirm)

    arguments = ["reset-stage-one-data", "--preview"]
    if mode == "confirm":
        arguments = [
            "reset-stage-one-data",
            "--confirm",
            reset_plan_digest(plan),
        ]
    assert cli_module.main(arguments) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload == {
        "mode": mode,
        "planDigest": reset_plan_digest(plan),
        "sourceHead": "20260814_0001",
        "state": "stage_one",
        "targetHead": "20260902_0003",
        "targets": {
            "artifactRunIds": [str(RUN_ID)],
            "businessFiles": ["incidents.sqlite3-wal", "incidents.sqlite3"],
            "checkpointFiles": ["checkpoints.sqlite3"],
            "rowCounts": {"agent_runs": 1, "incidents": 1},
            "runIds": [str(RUN_ID)],
        },
        **(
            {
                "completedAt": "2026-09-01T08:00:00Z",
                "deleted": {
                    "artifactRunIds": [str(RUN_ID)],
                    "businessFiles": [
                        "incidents.sqlite3-wal",
                        "incidents.sqlite3",
                    ],
                    "checkpointFiles": ["checkpoints.sqlite3"],
                },
                "newHead": "20260902_0003",
                "outcome": "reset",
            }
            if mode == "confirm"
            else {}
        ),
    }


def test_stage_one_reset_cli_returns_a_safe_structured_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_preview(_settings: Settings) -> ResetPlan:
        raise StageOneResetError("reset_rejected", "preflight")

    monkeypatch.setattr(
        cli_module,
        "Settings",
        lambda: cast(Settings, object()),
    )
    monkeypatch.setattr(cli_module, "preview_stage_one_data", fail_preview)

    assert cli_module.main(["reset-stage-one-data", "--preview"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "error": {"code": "reset_rejected", "phase": "preflight"},
        "mode": "preview",
    }


def test_stage_one_reset_cli_redacts_settings_failures(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_settings() -> Settings:
        raise SettingsError("secret path and value")

    monkeypatch.setattr(cli_module, "Settings", fail_settings)

    assert cli_module.main(["reset-stage-one-data", "--preview"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "secret path and value" not in captured.err
    assert json.loads(captured.err) == {
        "error": {"code": "configuration_invalid", "phase": "preflight"},
        "mode": "preview",
    }


def test_stage_one_reset_cli_redacts_runtime_root_filesystem_failures(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    unsafe_root = "/dev/null/private-runtime"
    monkeypatch.setenv("RUNTIME_DATA_DIR", unsafe_root)

    assert cli_module.main(["reset-stage-one-data", "--preview"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert unsafe_root not in captured.err
    assert json.loads(captured.err) == {
        "error": {"code": "configuration_invalid", "phase": "preflight"},
        "mode": "preview",
    }


def test_stage_one_reset_cli_binds_real_preview_to_confirm(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("RUNTIME_DATA_DIR", str(tmp_path / "runtime"))

    assert cli_module.main(["reset-stage-one-data", "--preview"]) == 0
    preview = json.loads(capsys.readouterr().out)

    assert (
        cli_module.main(["reset-stage-one-data", "--confirm", preview["planDigest"]])
        == 0
    )
    result = json.loads(capsys.readouterr().out)

    assert result["planDigest"] == preview["planDigest"]
    assert result["outcome"] == "migrated"
    assert result["newHead"] == "20260902_0003"


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
        ["reset-stage-one-data"],
        ["reset-stage-one-data", "--confirm"],
        ["reset-stage-one-data", "--preview", "--confirm"],
        ["reset-stage-one-data", "--confirm", f"sha256:{'0' * 63}"],
        ["reset-stage-one-data", "--confirm", f"sha256:{'A' * 64}"],
        ["reset-stage-one-data", "--confirm", f"sha512:{'0' * 64}"],
        ["reset-stage-one-data", "--preview", "--run-id", str(RUN_ID)],
        ["reset-stage-one-data", "--confirm", "--path", "/tmp/unsafe"],
        ["reset-stage-one-data", "--preview", "--sql", "DROP TABLE incidents"],
        ["reset-stage-one-data", "--con"],
        ["reset-stage-one-data", "--pre"],
    ],
)
def test_runtime_cli_rejects_missing_conflicting_or_expansive_arguments(
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


def test_operator_init_creates_private_verifier_without_settings(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    password = secrets.token_urlsafe(32)

    def read_password(_prompt: str) -> str:
        return password

    monkeypatch.setattr(operator_module.getpass, "getpass", read_password)
    monkeypatch.setattr(
        cli_module, "Settings", lambda: pytest.fail("init must not load Settings")
    )
    target = tmp_path / "verifier"
    actual_write = os.write

    def short_write(fd: int, data: memoryview) -> int:
        return actual_write(fd, data[:7])

    monkeypatch.setattr(operator_module.os, "write", short_write)
    assert cli_module.main(["operator", "init", "--output", str(target)]) == 0
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert PasswordVerifier.from_file(target).matches(password.encode())
    captured = capsys.readouterr()
    assert password not in captured.out + captured.err
    assert target.read_text() not in captured.out + captured.err
    assert sorted(path.name for path in tmp_path.iterdir()) == ["verifier"]
    assert cli_module.main(["operator", "init", "--output", str(target)]) == 1
    assert PasswordVerifier.from_file(target).matches(password.encode())


@pytest.mark.parametrize(
    "case",
    ["mismatch", "empty", "oversize", "echo", "eof", "interrupt", "link", "write"],
)
def test_operator_init_rejects_unsafe_input_without_leaking_or_overwriting(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    case: str,
) -> None:
    password = secrets.token_urlsafe(32)
    entries = iter(
        [password, "different"] if case == "mismatch" else [password, password]
    )

    def read_password(_: str) -> str:
        if case == "echo":
            warnings.warn("echo unavailable", getpass.GetPassWarning, stacklevel=2)
            pytest.fail("must not reach echo fallback")
        if case == "eof":
            raise EOFError
        if case == "interrupt":
            raise KeyboardInterrupt
        if case == "empty":
            return ""
        if case == "oversize":
            return "密" * 342
        return next(entries)

    monkeypatch.setattr(operator_module.getpass, "getpass", read_password)
    target = tmp_path / "verifier"
    if case == "link":
        target.symlink_to(tmp_path / "untouched")
    if case == "write":

        def no_progress(_fd: int, _data: memoryview) -> int:
            return 0

        monkeypatch.setattr(operator_module.os, "write", no_progress)
    assert cli_module.main(["operator", "init", "--output", str(target)]) == 1
    captured = capsys.readouterr()
    assert password not in captured.out + captured.err
    if case == "write":
        assert target.read_bytes() == b""
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
        assert "partial output" in captured.err
    else:
        assert not target.exists()
    if case == "link":
        assert target.is_symlink()
        assert not (tmp_path / "untouched").exists()


def test_operator_init_does_not_echo_mistaken_password_arguments(
    capsys: pytest.CaptureFixture[str],
) -> None:
    password = secrets.token_urlsafe(32)
    with pytest.raises(SystemExit) as error:
        cli_module.main(
            ["operator", "init", "--output", "/unused", "--password", password]
        )
    assert error.value.code == 2
    assert password not in capsys.readouterr().err


def test_operator_init_real_terminal_disables_echo(tmp_path: Path) -> None:
    password = secrets.token_urlsafe(32).encode()
    target = tmp_path / "verifier"
    master, slave = pty.openpty()
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from k8s_incident_agent.runtime.cli import main; raise SystemExit(main())",
            "operator",
            "init",
            "--output",
            str(target),
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    transcript = bytearray()
    try:
        for prompt in (
            b"Set login password (hidden): ",
            b"Confirm login password (hidden): ",
        ):
            deadline = time.monotonic() + 10
            while prompt not in transcript:
                assert time.monotonic() < deadline, "CLI did not prompt in time"
                if select.select([master], [], [], 0.1)[0]:
                    transcript.extend(os.read(master, 8192))
            assert not (termios.tcgetattr(slave)[3] & termios.ECHO)
            os.write(master, password + b"\n")
        assert process.wait(timeout=10) == 0
        while select.select([master], [], [], 0)[0]:
            transcript.extend(os.read(master, 8192))
        assert password not in transcript
        assert b"$argon2" not in transcript
        assert PasswordVerifier.from_file(target).matches(password)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)
