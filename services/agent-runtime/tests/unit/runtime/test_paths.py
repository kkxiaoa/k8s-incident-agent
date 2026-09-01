import stat
from pathlib import Path

import pytest

from k8s_incident_agent.runtime.paths import RuntimePaths

REPOSITORY_ROOT = Path(__file__).resolve().parents[5]


def test_runtime_paths_create_one_private_root_with_fixed_targets(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtime"

    paths = RuntimePaths.prepare(root)

    assert paths == RuntimePaths(
        root=root,
        business_database=root / "incidents.sqlite3",
        checkpoint_database=root / "checkpoints.sqlite3",
        diagnostic_kubeconfig=root / "diagnostic.kubeconfig",
        runtime_lock=root / "runtime.lock",
        run_artifacts=root / "runs",
    )
    assert stat.S_IMODE(root.stat().st_mode) == 0o700


@pytest.mark.parametrize(
    "root",
    [Path("relative-runtime"), Path("/"), Path.home(), REPOSITORY_ROOT],
)
def test_runtime_paths_reject_non_absolute_or_broad_roots(root: Path) -> None:
    with pytest.raises(ValueError):
        RuntimePaths.prepare(root)


def test_runtime_paths_reject_symlink_or_non_private_roots(tmp_path: Path) -> None:
    real_root = tmp_path / "real-runtime"
    real_root.mkdir(mode=0o700)
    symlink_root = tmp_path / "symlink-runtime"
    symlink_root.symlink_to(real_root, target_is_directory=True)

    with pytest.raises(ValueError):
        RuntimePaths.prepare(symlink_root)

    non_private_root = tmp_path / "non-private-runtime"
    non_private_root.mkdir(mode=0o755)
    with pytest.raises(ValueError):
        RuntimePaths.prepare(non_private_root)


def test_runtime_paths_reject_symlink_artifact_targets(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir(mode=0o700)
    external_database = tmp_path / "external.sqlite3"
    external_database.touch(mode=0o600)
    (root / "incidents.sqlite3").symlink_to(external_database)

    with pytest.raises(ValueError):
        RuntimePaths.prepare(root)


def test_runtime_paths_reject_unsafe_checkpoint_sidecars(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir(mode=0o700)
    external_file = tmp_path / "external-wal"
    external_file.touch(mode=0o600)
    (root / "checkpoints.sqlite3-wal").symlink_to(external_file)

    with pytest.raises(ValueError):
        RuntimePaths.prepare(root)
