from pathlib import Path

import pytest

from k8s_incident_agent.monitoring.auth import AlertmanagerWebhookAuthenticator
from k8s_incident_agent.monitoring.errors import AlertAuthenticationError


def _credential() -> bytes:
    return b"a" * 32


def test_authenticator_accepts_only_the_complete_mounted_credential(
    tmp_path: Path,
) -> None:
    credential_file = tmp_path / "credential"
    credential_file.write_bytes(_credential())
    authenticator = AlertmanagerWebhookAuthenticator.from_file(credential_file)

    authenticator.require(_credential().decode())
    for candidate in (None, "", "a" * 31, "a" * 33, "é" * 32):
        with pytest.raises(AlertAuthenticationError):
            authenticator.require(candidate)


def test_projected_secret_symlink_inside_its_mount_is_supported(
    tmp_path: Path,
) -> None:
    revision = tmp_path / "..2026_09_02"
    revision.mkdir()
    (revision / "credential").write_bytes(_credential())
    (tmp_path / "..data").symlink_to(revision.name)
    projected = tmp_path / "credential"
    projected.symlink_to("..data/credential")

    authenticator = AlertmanagerWebhookAuthenticator.from_file(projected)
    authenticator.require(_credential().decode())


def test_credential_symlink_cannot_escape_its_mount(tmp_path: Path) -> None:
    mount = tmp_path / "mount"
    mount.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(_credential())
    projected = mount / "credential"
    projected.symlink_to(outside)

    with pytest.raises(ValueError, match="could not be read"):
        AlertmanagerWebhookAuthenticator.from_file(projected)


@pytest.mark.parametrize(
    "payload",
    [b"a" * 31, b"a" * 257, b"a" * 31 + b"\n", b"a" * 31 + b" "],
)
def test_credential_file_contract_is_bounded_and_whitespace_free(
    tmp_path: Path,
    payload: bytes,
) -> None:
    credential_file = tmp_path / "credential"
    credential_file.write_bytes(payload)

    with pytest.raises(ValueError, match="credential"):
        AlertmanagerWebhookAuthenticator.from_file(credential_file)
