import base64
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from k8s_incident_agent.kubernetes.credentials import (
    load_diagnostic_credential,
    require_credential_ttl,
)
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

NOW = datetime(2026, 8, 21, 8, 0, tzinfo=UTC)
CONTEXT_NAME = "kind-k8s-incident-agent"
CLUSTER_NAME = "k8s-incident-agent"
NAMESPACE = "k8s-incident-scenarios"
USER_NAME = "diagnostic-agent"


def _encode_segment(value: dict[str, object]) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    )
    return encoded.rstrip(b"=").decode()


def _token(expires_at: datetime = NOW + timedelta(hours=1)) -> str:
    return f"{_encode_segment({'alg': 'none'})}.{_encode_segment({'exp': int(expires_at.timestamp())})}.signature"


def _document(
    *,
    token: str | None = None,
    server: str = "https://127.0.0.1:6443",
    context_names: tuple[str, ...] = (CONTEXT_NAME,),
    current_context: str = CONTEXT_NAME,
    proxy_url: str | None = None,
    user: dict[str, object] | None = None,
) -> dict[str, object]:
    cluster: dict[str, object] = {
        "server": server,
        "certificate-authority-data": "test-ca-data",
    }
    if proxy_url is not None:
        cluster["proxy-url"] = proxy_url
    user_config = user if user is not None else {"token": token or _token()}
    return {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{"name": CLUSTER_NAME, "cluster": cluster}],
        "contexts": [
            {
                "name": context_name,
                "context": {
                    "cluster": CLUSTER_NAME,
                    "namespace": NAMESPACE,
                    "user": USER_NAME,
                },
            }
            for context_name in context_names
        ],
        "users": [{"name": USER_NAME, "user": user_config}],
        "current-context": current_context,
    }


def _paths(tmp_path: Path) -> RuntimePaths:
    return RuntimePaths.prepare(tmp_path / "runtime")


def _write_document(
    paths: RuntimePaths,
    document: dict[str, object],
    *,
    mode: int = 0o600,
) -> None:
    paths.diagnostic_kubeconfig.write_text(json.dumps(document), encoding="utf-8")
    paths.diagnostic_kubeconfig.chmod(mode)


def _assert_authentication_failure(
    paths: RuntimePaths,
    *,
    forbidden_texts: tuple[str, ...] = (),
) -> KubernetesBoundaryError:
    with pytest.raises(KubernetesBoundaryError) as captured:
        load_diagnostic_credential(paths, NOW)

    assert captured.value.code is KubernetesErrorCode.AUTHENTICATION_FAILED
    assert captured.value.retryable is False
    for forbidden_text in forbidden_texts:
        assert forbidden_text not in str(captured.value)
    return captured.value


def test_loads_bootstrap_credential_without_exposing_token_in_repr(
    tmp_path: Path,
) -> None:
    paths = _paths(tmp_path)
    token = _token()
    _write_document(paths, _document(token=token))

    credential = load_diagnostic_credential(paths, NOW)

    assert credential.kubeconfig_path == paths.diagnostic_kubeconfig
    assert credential.context_name == CONTEXT_NAME
    assert credential.server_url == "https://127.0.0.1:6443"
    assert credential.expires_at == NOW + timedelta(hours=1)
    assert token not in repr(credential)


def test_missing_credential_fails_closed(tmp_path: Path) -> None:
    paths = _paths(tmp_path)

    _assert_authentication_failure(paths)


def test_non_private_credential_fails_closed(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    _write_document(paths, _document(), mode=0o644)

    _assert_authentication_failure(paths)


def test_symlink_credential_fails_closed(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    target = tmp_path / "credential-target"
    target.write_text(json.dumps(_document()), encoding="utf-8")
    target.chmod(0o600)
    os.symlink(target, paths.diagnostic_kubeconfig)

    _assert_authentication_failure(paths)


@pytest.mark.parametrize(
    "raw_document",
    [
        "not-json",
        json.dumps({"apiVersion": "v1", "kind": "Config"}),
    ],
)
def test_non_bootstrap_document_fails_closed(
    tmp_path: Path,
    raw_document: str,
) -> None:
    paths = _paths(tmp_path)
    paths.diagnostic_kubeconfig.write_text(raw_document, encoding="utf-8")
    paths.diagnostic_kubeconfig.chmod(0o600)

    _assert_authentication_failure(paths)


@pytest.mark.parametrize(
    "document",
    [
        _document(context_names=(CONTEXT_NAME, "another-context")),
        _document(
            context_names=("another-context",),
            current_context="another-context",
        ),
        _document(server="http://127.0.0.1:6443"),
        _document(server="https://cluster.example:6443"),
        _document(proxy_url="http://proxy.example:3128"),
        _document(
            user={
                "exec": {
                    "apiVersion": "client.authentication.k8s.io/v1",
                    "command": "credential-plugin",
                }
            }
        ),
    ],
    ids=[
        "multiple-contexts",
        "context-mismatch",
        "http-server",
        "non-loopback-server",
        "proxy-url",
        "alternative-auth-provider",
    ],
)
def test_credential_scope_and_transport_contract_fail_closed(
    tmp_path: Path,
    document: dict[str, object],
) -> None:
    paths = _paths(tmp_path)
    _write_document(paths, document)

    _assert_authentication_failure(paths)


@pytest.mark.parametrize(
    "token",
    [
        "not-a-jwt",
        f"{_encode_segment({'alg': 'none'})}.{_encode_segment({})}.signature",
        _token(NOW - timedelta(seconds=1)),
    ],
    ids=["malformed", "missing-exp", "expired"],
)
def test_invalid_jwt_expiration_fails_without_leaking_credential(
    tmp_path: Path,
    token: str,
) -> None:
    paths = _paths(tmp_path)
    _write_document(paths, _document(token=token))

    _assert_authentication_failure(
        paths,
        forbidden_texts=(token, str(paths.diagnostic_kubeconfig)),
    )


def test_ttl_gate_accepts_exact_budget_and_rejects_short_budget(
    tmp_path: Path,
) -> None:
    paths = _paths(tmp_path)
    _write_document(paths, _document(token=_token(NOW + timedelta(seconds=240))))
    credential = load_diagnostic_credential(paths, NOW)

    require_credential_ttl(credential, 240, NOW)

    with pytest.raises(KubernetesBoundaryError) as captured:
        require_credential_ttl(credential, 241, NOW)

    assert captured.value.code is KubernetesErrorCode.AUTHENTICATION_FAILED
    assert captured.value.retryable is False
