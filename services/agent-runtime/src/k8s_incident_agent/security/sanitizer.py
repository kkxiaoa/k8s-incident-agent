from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

TEXT_LIMIT_CODE_POINTS = 2048
_REDACTED = "[REDACTED]"

_URI_PATTERN = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s<>\"']+")
_PEM_PATTERN = re.compile(
    r"-----BEGIN [^-\r\n]+-----.*?-----END [^-\r\n]+-----",
    re.IGNORECASE | re.DOTALL,
)
_UNTERMINATED_PEM_PATTERN = re.compile(
    r"-----BEGIN [^-\r\n]+-----.*\Z",
    re.IGNORECASE | re.DOTALL,
)
_BEARER_PATTERN = re.compile(
    r"\bBearer[ \t]+[A-Za-z0-9._~+/=-]+",
    re.IGNORECASE,
)
_JWT_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_-])"
    r"[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r"(?![A-Za-z0-9_-])"
)
_SENSITIVE_WHOLE_VALUE_PATTERN = re.compile(
    r"(?<![\"'A-Za-z0-9_.-])"
    r"(?P<prefix>[A-Za-z0-9_.-]*(?:authorization|cookie)"
    r"[A-Za-z0-9_.-]*[ \t]*[:=][ \t]*)"
    r"(?P<value>[^\r\n]+)",
    re.IGNORECASE,
)
_SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"(?P<prefix>"
    r"\"?[A-Za-z0-9_.-]*(?:token|password|api[_-]?key|authorization|cookie)"
    r"[A-Za-z0-9_.-]*\"?[ \t]*[:=][ \t]*"
    r")"
    r"(?P<value>\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\r\n,;}\]]+)",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class SanitizedText:
    value: str
    truncated: bool
    redacted: bool


def sanitize_untrusted_text(
    value: str,
    *,
    max_code_points: int = TEXT_LIMIT_CODE_POINTS,
) -> SanitizedText:
    raw_value: object = value
    if not isinstance(raw_value, str):  # pyright: ignore[reportUnnecessaryIsInstance]
        raise TypeError("Untrusted text must be a string")
    raw_limit: object = max_code_points
    if (
        not isinstance(raw_limit, int)  # pyright: ignore[reportUnnecessaryIsInstance]
        or isinstance(raw_limit, bool)
        or raw_limit <= 0
    ):
        raise ValueError("Text limit must be a positive integer")

    sanitized, control_replacements = _remove_disallowed_controls(raw_value)
    sanitized, uri_replaced = _strip_sensitive_uri_components(sanitized)
    sanitized, pem_replacements = _PEM_PATTERN.subn(_redact_pem, sanitized)
    sanitized, unterminated_pem_replacements = _UNTERMINATED_PEM_PATTERN.subn(
        _redact_pem,
        sanitized,
    )
    sanitized, bearer_replacements = _BEARER_PATTERN.subn(
        f"Bearer {_REDACTED}", sanitized
    )
    sanitized, jwt_replacements = _JWT_PATTERN.subn(_REDACTED, sanitized)
    sanitized, assignment_replacements = _SENSITIVE_ASSIGNMENT_PATTERN.subn(
        _redact_assignment,
        sanitized,
    )
    sanitized, whole_value_replacements = _SENSITIVE_WHOLE_VALUE_PATTERN.subn(
        _redact_assignment,
        sanitized,
    )

    truncated = len(sanitized) > raw_limit
    if truncated:
        sanitized = sanitized[:raw_limit]

    return SanitizedText(
        value=sanitized,
        truncated=truncated,
        redacted=bool(
            control_replacements
            or uri_replaced
            or pem_replacements
            or unterminated_pem_replacements
            or bearer_replacements
            or jwt_replacements
            or assignment_replacements
            or whole_value_replacements
        ),
    )


def _strip_sensitive_uri_components(value: str) -> tuple[str, bool]:
    replaced = False

    def replace(match: re.Match[str]) -> str:
        nonlocal replaced
        raw_uri = match.group(0)
        try:
            parsed = urlsplit(raw_uri)
            if not (
                parsed.username or parsed.password or parsed.query or parsed.fragment
            ):
                return raw_uri
            sanitized = _without_sensitive_uri_components(parsed)
        except (TypeError, ValueError):
            sanitized = _REDACTED
        replaced = True
        return sanitized

    return _URI_PATTERN.sub(replace, value), replaced


def _remove_disallowed_controls(value: str) -> tuple[str, int]:
    allowed_controls = {"\t", "\n", "\r"}
    characters: list[str] = []
    replacements = 0
    for character in value:
        if character not in allowed_controls and unicodedata.category(character) in {
            "Cc",
            "Cf",
            "Cs",
        }:
            replacements += 1
            continue
        characters.append(character)
    return "".join(characters), replacements


def _without_sensitive_uri_components(parsed: SplitResult) -> str:
    hostname = parsed.hostname
    if not hostname:
        return _REDACTED
    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    port = parsed.port
    netloc = rendered_host if port is None else f"{rendered_host}:{port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


def _redact_assignment(match: re.Match[str]) -> str:
    value = match.group("value")
    if value.startswith('"') and value.endswith('"'):
        replacement = f'"{_REDACTED}"'
    elif value.startswith("'") and value.endswith("'"):
        replacement = f"'{_REDACTED}'"
    else:
        replacement = _REDACTED
    return f"{match.group('prefix')}{replacement}"


def _redact_pem(match: re.Match[str]) -> str:
    line_breaks = "".join(
        character for character in match.group(0) if character in {"\r", "\n"}
    )
    return f"{_REDACTED}{line_breaks}"
