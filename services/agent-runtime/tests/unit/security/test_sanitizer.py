from __future__ import annotations

import pytest

from k8s_incident_agent.security.sanitizer import (
    TEXT_LIMIT_CODE_POINTS,
    sanitize_untrusted_text,
)


def test_removes_disallowed_control_characters_without_retaining_input() -> None:
    result = sanitize_untrusted_text("safe\x00\x1ftext\u202enext\nline")

    assert result.value == "safetextnext\nline"
    assert result.redacted is True
    assert result.truncated is False


def test_strips_uri_credentials_query_and_fragment() -> None:
    result = sanitize_untrusted_text(
        "pull https://user:password@example.test/image:v1?token=secret#details"
    )

    assert result.value == "pull https://example.test/image:v1"
    assert result.redacted is True
    assert "user" not in result.value
    assert "secret" not in result.value


@pytest.mark.parametrize(
    ("value", "forbidden"),
    [
        ("Authorization: Bearer top-secret-token", "top-secret-token"),
        (
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkaWFnbm9zdGljIn0.signaturevalue",
            "eyJzdWIiOiJkaWFnbm9zdGljIn0",
        ),
        (
            "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
            "private-material",
        ),
        ("database_password=correct-horse-battery-staple", "correct-horse"),
        ('{"api_key": "provider-secret"}', "provider-secret"),
        ("Cookie: session=browser-secret", "browser-secret"),
    ],
)
def test_redacts_credential_patterns(value: str, forbidden: str) -> None:
    result = sanitize_untrusted_text(value)

    assert result.redacted is True
    assert forbidden not in result.value
    assert "[REDACTED]" in result.value


def test_redacts_the_complete_basic_authorization_header() -> None:
    result = sanitize_untrusted_text("Authorization: Basic dXNlcjpwYXNz")

    assert result.value == "Authorization: [REDACTED]"
    assert result.redacted is True


def test_redacts_every_value_in_a_cookie_header() -> None:
    result = sanitize_untrusted_text(
        "Cookie: session=first-secret; refresh=second-secret"
    )

    assert result.value == "Cookie: [REDACTED]"
    assert result.redacted is True


def test_redacts_every_value_in_an_unquoted_cookie_assignment() -> None:
    result = sanitize_untrusted_text(
        "cookie=session=first-secret; refresh=second-secret"
    )

    assert result.value == "cookie=[REDACTED]"
    assert result.redacted is True


def test_redacts_a_whitespace_separated_sensitive_assignment_value() -> None:
    result = sanitize_untrusted_text("authorization=Token opaque-secret")

    assert result.value == "authorization=[REDACTED]"
    assert result.redacted is True


def test_truncates_at_the_unicode_code_point_boundary() -> None:
    value = "界" * (TEXT_LIMIT_CODE_POINTS + 1)

    result = sanitize_untrusted_text(value)

    assert result.value == "界" * TEXT_LIMIT_CODE_POINTS
    assert len(result.value) == TEXT_LIMIT_CODE_POINTS
    assert result.truncated is True
    assert result.redacted is False


def test_exact_text_limit_is_not_truncated() -> None:
    value = "a" * TEXT_LIMIT_CODE_POINTS

    result = sanitize_untrusted_text(value)

    assert result.value == value
    assert result.truncated is False


def test_invalid_inputs_raise_only_static_errors() -> None:
    secret = "must-not-appear-in-error"

    with pytest.raises(TypeError) as error:
        sanitize_untrusted_text(secret.encode())  # type: ignore[arg-type]

    assert secret not in repr(error.value)

    with pytest.raises(ValueError) as limit_error:
        sanitize_untrusted_text(secret, max_code_points=0)

    assert secret not in repr(limit_error.value)
