from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from k8s_incident_agent.repair.auth import (
    NonceReplayCache,
    PatchValidatorAuthenticationError,
    load_hmac_key,
    request_signature,
    response_signature,
    verify_request_authentication,
    verify_response_authentication,
)

NOW = datetime(2026, 9, 6, 12, 0, tzinfo=UTC)
KEY = b"0123456789abcdef0123456789abcdef"
NONCE = "a" * 43
BODY = b'{"schemaVersion":1}'


def test_request_and_response_signatures_use_separate_domains() -> None:
    timestamp = str(int(NOW.timestamp()))
    request = request_signature(KEY, timestamp, NONCE, BODY)
    response = response_signature(KEY, 200, NONCE, BODY)

    assert request != response
    assert len(request) == 64
    assert len(response) == 64


@pytest.mark.asyncio
async def test_validator_authenticates_exact_bytes_then_rejects_nonce_replay() -> None:
    timestamp = str(int(NOW.timestamp()))
    signature = request_signature(KEY, timestamp, NONCE, BODY)
    replay = NonceReplayCache(freshness_seconds=30)

    await verify_request_authentication(
        key=KEY,
        timestamp=timestamp,
        nonce=NONCE,
        signature=signature,
        body=BODY,
        now=NOW,
        replay_cache=replay,
    )
    with pytest.raises(PatchValidatorAuthenticationError) as captured:
        await verify_request_authentication(
            key=KEY,
            timestamp=timestamp,
            nonce=NONCE,
            signature=signature,
            body=BODY,
            now=NOW + timedelta(seconds=1),
            replay_cache=replay,
        )

    assert captured.value.code == "patch_validator_replay_rejected"


def test_runtime_rejects_response_body_or_status_substitution() -> None:
    signature = response_signature(KEY, 200, NONCE, BODY)

    with pytest.raises(PatchValidatorAuthenticationError):
        verify_response_authentication(
            key=KEY,
            status_code=409,
            nonce=NONCE,
            signature=signature,
            body=BODY,
        )
    with pytest.raises(PatchValidatorAuthenticationError):
        verify_response_authentication(
            key=KEY,
            status_code=200,
            nonce=NONCE,
            signature=signature,
            body=b'{"schemaVersion":2}',
        )


@pytest.mark.asyncio
async def test_replay_cache_fails_closed_at_its_capacity() -> None:
    replay = NonceReplayCache(freshness_seconds=30, max_entries=1)
    timestamp = str(int(NOW.timestamp()))
    first_nonce = "a" * 43
    second_nonce = "b" * 43

    await verify_request_authentication(
        key=KEY,
        timestamp=timestamp,
        nonce=first_nonce,
        signature=request_signature(KEY, timestamp, first_nonce, BODY),
        body=BODY,
        now=NOW,
        replay_cache=replay,
    )
    with pytest.raises(PatchValidatorAuthenticationError) as captured:
        await verify_request_authentication(
            key=KEY,
            timestamp=timestamp,
            nonce=second_nonce,
            signature=request_signature(KEY, timestamp, second_nonce, BODY),
            body=BODY,
            now=NOW,
            replay_cache=replay,
        )

    assert captured.value.code == "patch_validator_replay_rejected"


def test_hmac_key_loader_requires_exact_binary_length(tmp_path: Path) -> None:
    key_path = tmp_path / "hmac-key"
    key_path.write_bytes(KEY)

    assert load_hmac_key(key_path) == KEY

    key_path.write_bytes(KEY + b"x")
    with pytest.raises(ValueError, match="unavailable"):
        load_hmac_key(key_path)


def test_hmac_key_loader_accepts_projected_symlink_but_rejects_escape(
    tmp_path: Path,
) -> None:
    projected = tmp_path / "projected"
    projected.mkdir()
    data = projected / "..data"
    data.mkdir()
    (data / "hmac-key").write_bytes(KEY)
    key_path = projected / "hmac-key"
    key_path.symlink_to("..data/hmac-key")

    assert load_hmac_key(key_path) == KEY

    external = tmp_path / "external-key"
    external.write_bytes(KEY)
    key_path.unlink()
    key_path.symlink_to(external)
    with pytest.raises(ValueError, match="unavailable"):
        load_hmac_key(key_path)
