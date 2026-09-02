import hmac
import os
import stat
from pathlib import Path

from k8s_incident_agent.monitoring.errors import AlertAuthenticationError

_MIN_TOKEN_BYTES = 32
_MAX_TOKEN_BYTES = 256


class AlertmanagerWebhookAuthenticator:
    __slots__ = ("_token",)

    def __init__(self, token: bytes) -> None:
        self._token = token

    @classmethod
    def from_file(cls, path: Path) -> "AlertmanagerWebhookAuthenticator":
        try:
            resolved = path.resolve(strict=True)
            mount_root = path.parent.resolve(strict=True)
            if not resolved.is_relative_to(mount_root):
                raise ValueError
            descriptor = os.open(resolved, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except (OSError, RuntimeError, ValueError):
            raise ValueError(
                "Alertmanager webhook credential could not be read"
            ) from None
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_size > _MAX_TOKEN_BYTES
            ):
                raise ValueError("Alertmanager webhook credential file is invalid")
            token_parts: list[bytes] = []
            remaining = _MAX_TOKEN_BYTES + 1
            while remaining > 0:
                part = os.read(descriptor, remaining)
                if not part:
                    break
                token_parts.append(part)
                remaining -= len(part)
            token = b"".join(token_parts)
        finally:
            os.close(descriptor)
        if (
            len(token) < _MIN_TOKEN_BYTES
            or len(token) > _MAX_TOKEN_BYTES
            or any(byte < 0x21 or byte > 0x7E for byte in token)
        ):
            raise ValueError("Alertmanager webhook credential is invalid")
        return cls(token)

    def require(self, credentials: str | None) -> None:
        try:
            candidate = credentials.encode("ascii") if credentials is not None else b""
        except UnicodeEncodeError:
            candidate = b""
        if not hmac.compare_digest(candidate, self._token):
            raise AlertAuthenticationError
