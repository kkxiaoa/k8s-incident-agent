import os
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from pydantic import ValidationError

from k8s_incident_agent.config import ExecutorSettings


def test_executor_entrypoint_is_independent_and_fails_closed_without_key(
    tmp_path: Path,
) -> None:
    project = Path(__file__).resolve().parents[2]
    scripts = tomllib.loads((project / "pyproject.toml").read_text())["project"][
        "scripts"
    ]
    assert scripts["sandbox-executor"] == "k8s_incident_agent.execution.worker:main"
    env = {
        "PATH": os.environ["PATH"],
        "EXECUTOR_HMAC_KEY_FILE": str(tmp_path / "absent"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    command = [sys.executable, "-m", "k8s_incident_agent.execution.worker"]
    help_result = subprocess.run(
        [*command, "--help"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert help_result.returncode == 0
    result = subprocess.run(
        command, cwd=tmp_path, env=env, capture_output=True, text=True, timeout=15
    )
    assert result.returncode == 1
    assert result.stdout == ""
    assert (
        result.stderr.strip()
        == "Executor stopped: configuration or execution boundary failed"
    )
    assert list(tmp_path.iterdir()) == []
    imported = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import k8s_incident_agent.execution.worker; assert 'k8s_incident_agent.api' not in sys.modules; assert 'k8s_incident_agent.repair.api' not in sys.modules; assert 'k8s_incident_agent.model.factory' not in sys.modules",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert imported.returncode == 0, imported.stderr


def test_executor_does_not_load_runtime_or_dotenv_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RUNTIME_DATA_DIR", str(tmp_path / "must-not-be-created"))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "synthetic-unused")
    settings = ExecutorSettings(executor_hmac_key_file=tmp_path / "key")
    assert settings.kubernetes_cluster_id == "k8s-incident-agent"
    assert list(tmp_path.iterdir()) == []
    with pytest.raises(ValidationError):
        ExecutorSettings(kubernetes_cluster_id="other")  # pyright: ignore[reportArgumentType]
