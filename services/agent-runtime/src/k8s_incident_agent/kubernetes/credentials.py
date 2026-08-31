import base64
import binascii
import copy
import json
import math
import os
import stat
from dataclasses import dataclass, field
from datetime import UTC, datetime
from ipaddress import ip_address
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.runtime.paths import PRIVATE_FILE_MODE, RuntimePaths

_CLUSTER_NAME = "k8s-incident-agent"
_CONTEXT_NAME = "kind-k8s-incident-agent"
_NAMESPACE = "k8s-incident-scenarios"
_USER_NAME = "diagnostic-agent"


@dataclass(frozen=True, slots=True)
class DiagnosticCredential:
    kubeconfig_path: Path
    context_name: str
    server_url: str
    expires_at: datetime
    _kubeconfig: dict[str, object] = field(repr=False, compare=False)

    def copy_kubeconfig_for_client(self) -> dict[str, object]:
        return copy.deepcopy(self._kubeconfig)


@dataclass(frozen=True, slots=True)
class InClusterCredentialLease:
    pass


type DiagnosticCredentialLease = DiagnosticCredential | InClusterCredentialLease


def load_diagnostic_credential(
    paths: RuntimePaths,
    now: datetime,
) -> DiagnosticCredential:
    normalized_now = _require_aware_utc(now)
    raw_document = _read_private_file(paths.diagnostic_kubeconfig)
    try:
        parsed = cast(object, json.loads(raw_document))
    except json.JSONDecodeError:
        raise _authentication_failure() from None

    document = _require_object(parsed)
    _require_exact_keys(
        document,
        {"apiVersion", "kind", "clusters", "contexts", "users", "current-context"},
    )
    if document["apiVersion"] != "v1" or document["kind"] != "Config":
        raise _authentication_failure()

    cluster_entry = _single_object(document["clusters"])
    _require_exact_keys(cluster_entry, {"name", "cluster"})
    if cluster_entry["name"] != _CLUSTER_NAME:
        raise _authentication_failure()
    cluster = _require_object(cluster_entry["cluster"])
    _require_exact_keys(cluster, {"server", "certificate-authority-data"})
    server_url = _validate_server_url(cluster["server"])
    _require_non_empty_string(cluster["certificate-authority-data"])

    context_entry = _single_object(document["contexts"])
    _require_exact_keys(context_entry, {"name", "context"})
    if context_entry["name"] != _CONTEXT_NAME:
        raise _authentication_failure()
    context = _require_object(context_entry["context"])
    _require_exact_keys(context, {"cluster", "namespace", "user"})
    if context != {
        "cluster": _CLUSTER_NAME,
        "namespace": _NAMESPACE,
        "user": _USER_NAME,
    }:
        raise _authentication_failure()
    if document["current-context"] != _CONTEXT_NAME:
        raise _authentication_failure()

    user_entry = _single_object(document["users"])
    _require_exact_keys(user_entry, {"name", "user"})
    if user_entry["name"] != _USER_NAME:
        raise _authentication_failure()
    user = _require_object(user_entry["user"])
    _require_exact_keys(user, {"token"})
    token = _require_non_empty_string(user["token"])
    expires_at = _parse_jwt_expiration(token)
    if expires_at <= normalized_now:
        raise _authentication_failure()

    return DiagnosticCredential(
        kubeconfig_path=paths.diagnostic_kubeconfig,
        context_name=_CONTEXT_NAME,
        server_url=server_url,
        expires_at=expires_at,
        _kubeconfig=document,
    )


def require_credential_window(
    credential: DiagnosticCredentialLease,
    required_seconds: float,
    now: datetime,
) -> None:
    if not math.isfinite(required_seconds) or required_seconds < 0:
        raise ValueError("required credential TTL must be finite and non-negative")
    normalized_now = _require_aware_utc(now)
    if isinstance(credential, InClusterCredentialLease):
        return
    if (credential.expires_at - normalized_now).total_seconds() < required_seconds:
        raise _authentication_failure()


def _read_private_file(path: Path) -> str:
    descriptor = -1
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
        file_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or stat.S_IMODE(file_stat.st_mode) != PRIVATE_FILE_MODE
        ):
            raise _authentication_failure()
        with os.fdopen(descriptor, encoding="utf-8") as credential_file:
            descriptor = -1
            return credential_file.read()
    except (OSError, UnicodeError):
        raise _authentication_failure() from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _require_object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise _authentication_failure()
    untyped = cast(dict[object, object], value)
    if not all(isinstance(key, str) for key in untyped):
        raise _authentication_failure()
    return {cast(str, key): item for key, item in untyped.items()}


def _single_object(value: object) -> dict[str, object]:
    if not isinstance(value, list):
        raise _authentication_failure()
    items = cast(list[object], value)
    if len(items) != 1:
        raise _authentication_failure()
    return _require_object(items[0])


def _require_exact_keys(value: dict[str, object], expected: set[str]) -> None:
    if set(value) != expected:
        raise _authentication_failure()


def _require_non_empty_string(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        raise _authentication_failure()
    return value


def _validate_server_url(value: object) -> str:
    server_url = _require_non_empty_string(value)
    try:
        parsed = urlsplit(server_url)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError:
        raise _authentication_failure() from None
    if (
        parsed.scheme != "https"
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or not _is_loopback(hostname)
    ):
        raise _authentication_failure()
    return server_url.removesuffix("/")


def _is_loopback(hostname: str) -> bool:
    if hostname.casefold() == "localhost":
        return True
    try:
        return ip_address(hostname).is_loopback
    except ValueError:
        return False


def _parse_jwt_expiration(token: str) -> datetime:
    segments = token.split(".")
    if len(segments) != 3 or not segments[1]:
        raise _authentication_failure()
    padding = "=" * (-len(segments[1]) % 4)
    try:
        payload_bytes = base64.b64decode(
            f"{segments[1]}{padding}",
            altchars=b"-_",
            validate=True,
        )
        payload = _require_object(cast(object, json.loads(payload_bytes)))
    except (binascii.Error, UnicodeError, json.JSONDecodeError):
        raise _authentication_failure() from None
    expiration = payload.get("exp")
    if (
        isinstance(expiration, bool)
        or not isinstance(expiration, int)
        or expiration <= 0
    ):
        raise _authentication_failure()
    try:
        return datetime.fromtimestamp(expiration, UTC)
    except (OverflowError, OSError, ValueError):
        raise _authentication_failure() from None


def _require_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("datetime must include a UTC offset")
    return value.astimezone(UTC)


def _authentication_failure() -> KubernetesBoundaryError:
    return KubernetesBoundaryError(KubernetesErrorCode.AUTHENTICATION_FAILED)
