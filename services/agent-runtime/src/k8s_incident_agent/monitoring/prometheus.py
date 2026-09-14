from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import pairwise
from typing import Final, Literal, cast

import httpx
from pydantic import HttpUrl

from k8s_incident_agent.monitoring.contracts import MetricSample
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.json import load_unique_json

_MAX_RESPONSE_BYTES: Final = 256 * 1024
_MAX_SERIES: Final = 8
_MAX_SAMPLES: Final = 512
_MAX_LABELS: Final = 32
_MAX_LABEL_NAME_LENGTH: Final = 128
_MAX_LABEL_VALUE_LENGTH: Final = 512
_MAX_ANNOTATIONS: Final = 16
_MAX_ANNOTATION_LENGTH: Final = 1024
_REQUEST_TIMEOUT_SECONDS: Final = 5.0
_MAX_CONCURRENCY: Final = 4
_LABEL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SAMPLE_VALUE = re.compile(
    r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"
)
_KNOWN_ERROR_TYPES: Final = frozenset(
    {
        "timeout",
        "canceled",
        "execution",
        "bad_data",
        "internal",
        "unavailable",
        "not_found",
        "not_acceptable",
    }
)


@dataclass(frozen=True, slots=True)
class PrometheusSeries:
    labels: tuple[tuple[str, str], ...]
    samples: tuple[MetricSample, ...]

    def label(self, name: str) -> str | None:
        return next((value for key, value in self.labels if key == name), None)


@dataclass(frozen=True, slots=True)
class PrometheusQueryResult:
    series: tuple[PrometheusSeries, ...]
    partial: bool


@dataclass(frozen=True, slots=True)
class PrometheusRule:
    name: str
    health: Literal["ok", "err", "unknown"]
    last_evaluation: datetime


class PrometheusHttpClient:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._limit = asyncio.Semaphore(_MAX_CONCURRENCY)

    @classmethod
    def create(cls, base_url: HttpUrl) -> PrometheusHttpClient:
        return cls(
            httpx.AsyncClient(
                base_url=str(base_url),
                timeout=httpx.Timeout(_REQUEST_TIMEOUT_SECONDS),
                trust_env=False,
                limits=httpx.Limits(
                    max_connections=_MAX_CONCURRENCY,
                    max_keepalive_connections=2,
                ),
            )
        )

    async def close(self) -> None:
        await self._http.aclose()

    async def query_range(
        self,
        expression: str,
        *,
        start: datetime,
        end: datetime,
        step_seconds: int,
        lookback_seconds: int,
    ) -> PrometheusQueryResult:
        return await self._query(
            "/api/v1/query_range",
            {
                "query": expression,
                "start": _unix_parameter(start),
                "end": _unix_parameter(end),
                "step": f"{step_seconds}s",
                "timeout": f"{int(_REQUEST_TIMEOUT_SECONDS)}s",
                "lookback_delta": f"{lookback_seconds}s",
                "limit": str(_MAX_SERIES),
            },
            expected_result_type="matrix",
        )

    async def query_instant(
        self,
        expression: str,
        *,
        at: datetime,
        lookback_seconds: int,
    ) -> PrometheusQueryResult:
        return await self._query(
            "/api/v1/query",
            {
                "query": expression,
                "time": _unix_parameter(at),
                "timeout": f"{int(_REQUEST_TIMEOUT_SECONDS)}s",
                "lookback_delta": f"{lookback_seconds}s",
                "limit": str(_MAX_SERIES),
            },
            expected_result_type="vector",
        )

    async def _query(
        self,
        path: str,
        form: Mapping[str, str],
        *,
        expected_result_type: Literal["matrix", "vector"],
    ) -> PrometheusQueryResult:
        payload = await self._request("POST", path, form)
        return _parse_success(payload, expected_result_type=expected_result_type)

    async def read_recovery_rules(
        self, names: tuple[str, ...]
    ) -> tuple[PrometheusRule, ...]:
        if not names or len(names) > 8 or len(set(names)) != len(names):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        parameters = [
            ("type", "alert"),
            ("exclude_alerts", "true"),
            ("rule_group[]", "k8s-incident-agent"),
            ("file[]", "/etc/prometheus/rules/alerts.yaml"),
            ("group_limit", "1"),
            *(("rule_name[]", name) for name in names),
        ]
        payload = await self._request("GET", "/api/v1/rules", parameters)
        return _parse_recovery_rules(payload, names)

    async def _request(
        self,
        method: Literal["GET", "POST"],
        path: str,
        parameters: Mapping[str, str] | list[tuple[str, str]],
    ) -> bytes:
        try:
            async with (
                asyncio.timeout(_REQUEST_TIMEOUT_SECONDS),
                self._limit,
                self._http.stream(
                    method,
                    path,
                    data=cast(Mapping[str, str], parameters)
                    if method == "POST"
                    else None,
                    params=httpx.QueryParams(
                        tuple(parameters)
                        if isinstance(parameters, list)
                        else parameters
                    )
                    if method == "GET"
                    else None,
                    headers={"accept": "application/json"},
                    timeout=_REQUEST_TIMEOUT_SECONDS,
                ) as response,
            ):
                payload = await _read_response_body(response)
                status_code = response.status_code
                content_type = response.headers.get("content-type", "")
        except (TimeoutError, httpx.TimeoutException):
            raise MonitoringBoundaryError(MonitoringErrorCode.REQUEST_TIMEOUT) from None
        except (httpx.TransportError, OSError):
            raise MonitoringBoundaryError(MonitoringErrorCode.UNAVAILABLE) from None

        if not 200 <= status_code < 300:
            if status_code == 429 or 500 <= status_code <= 599:
                error = _try_parse_error(payload, content_type)
                if error is not None:
                    raise error
                raise MonitoringBoundaryError(MonitoringErrorCode.UNAVAILABLE)
            error = _try_parse_error(payload, content_type)
            if error is not None:
                raise error
            raise MonitoringBoundaryError(MonitoringErrorCode.QUERY_FAILED)
        if content_type.partition(";")[0].strip().lower() != "application/json":
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        return payload


def _parse_recovery_rules(
    payload: bytes, names: tuple[str, ...]
) -> tuple[PrometheusRule, ...]:
    try:
        document = load_unique_json(payload)
        if not isinstance(document, dict):
            raise ValueError
        document = cast(dict[str, object], document)
        data = document.get("data")
        if document.get("status") != "success" or not isinstance(data, dict):
            raise ValueError
        data = cast(dict[str, object], data)
        groups = data.get("groups")
        if (
            document.get("warnings")
            or document.get("infos")
            or data.get("groupNextToken")
            or not isinstance(groups, list)
            or len(cast(list[object], groups)) != 1
        ):
            raise ValueError
        group = cast(list[object], groups)[0]
        if not isinstance(group, dict):
            raise ValueError
        group = cast(dict[str, object], group)
        rules = group.get("rules")
        if (
            group.get("name") != "k8s-incident-agent"
            or group.get("file") != "/etc/prometheus/rules/alerts.yaml"
            or not isinstance(rules, list)
            or len(cast(list[object], rules)) != len(names)
        ):
            raise ValueError
        projected: list[PrometheusRule] = []
        for raw in cast(list[object], rules):
            if not isinstance(raw, dict):
                raise ValueError
            rule = cast(dict[str, object], raw)
            name, health, at = (
                rule.get("name"),
                rule.get("health"),
                rule.get("lastEvaluation"),
            )
            if (
                name not in names
                or rule.get("type") != "alerting"
                or health not in ("ok", "err", "unknown")
                or not isinstance(at, str)
            ):
                raise ValueError
            parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
            if parsed.utcoffset() is None:
                raise ValueError
            projected.append(
                PrometheusRule(cast(str, name), health, parsed.astimezone(UTC))
            )
        if len({rule.name for rule in projected}) != len(names):
            raise ValueError
        return tuple(projected)
    except (ValueError, TypeError, OverflowError):
        raise MonitoringBoundaryError(
            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None


async def _read_response_body(response: httpx.Response) -> bytes:
    lengths = response.headers.get_list("content-length")
    if len(lengths) > 1:
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    if lengths:
        try:
            declared = int(lengths[0])
        except ValueError:
            raise MonitoringBoundaryError(
                MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
            ) from None
        if declared < 0:
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        if declared > _MAX_RESPONSE_BYTES:
            raise MonitoringBoundaryError(MonitoringErrorCode.RESULT_BUDGET_EXCEEDED)
    body = bytearray()
    async for chunk in response.aiter_bytes():
        if len(chunk) > _MAX_RESPONSE_BYTES - len(body):
            raise MonitoringBoundaryError(MonitoringErrorCode.RESULT_BUDGET_EXCEEDED)
        body.extend(chunk)
    return bytes(body)


def _try_parse_error(
    payload: bytes,
    content_type: str,
) -> MonitoringBoundaryError | None:
    if content_type.partition(";")[0].strip().lower() != "application/json":
        return None
    try:
        document = load_unique_json(payload)
    except ValueError:
        return None
    if not isinstance(document, dict):
        return None
    mapping = cast(dict[str, object], document)
    if mapping.get("status") != "error":
        return None
    error_type = mapping.get("errorType")
    error_message = mapping.get("error")
    if (
        not isinstance(error_type, str)
        or error_type not in _KNOWN_ERROR_TYPES
        or not isinstance(error_message, str)
        or not error_message
        or len(error_message) > _MAX_ANNOTATION_LENGTH
    ):
        return MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    if error_type in {"timeout", "canceled"}:
        return MonitoringBoundaryError(MonitoringErrorCode.REQUEST_TIMEOUT)
    if error_type in {"internal", "unavailable"}:
        return MonitoringBoundaryError(MonitoringErrorCode.UNAVAILABLE)
    return MonitoringBoundaryError(MonitoringErrorCode.QUERY_FAILED)


def _parse_success(
    payload: bytes,
    *,
    expected_result_type: Literal["matrix", "vector"],
) -> PrometheusQueryResult:
    try:
        document = load_unique_json(payload)
    except ValueError:
        raise MonitoringBoundaryError(
            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None
    if not isinstance(document, dict):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    mapping = cast(dict[str, object], document)
    if mapping.get("status") == "error":
        error = _try_parse_error(payload, "application/json")
        if error is None:
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        raise error
    data = mapping.get("data")
    if mapping.get("status") != "success" or not isinstance(data, dict):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    data_mapping = cast(dict[str, object], data)
    result = data_mapping.get("result")
    if data_mapping.get("resultType") != expected_result_type or not isinstance(
        result, list
    ):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    has_warnings = _has_annotations(mapping, "warnings")
    has_infos = _has_annotations(mapping, "infos")
    return PrometheusQueryResult(
        series=_parse_series(
            cast(list[object], result),
            result_type=expected_result_type,
        ),
        partial=has_warnings or has_infos,
    )


def _has_annotations(document: dict[str, object], key: str) -> bool:
    raw = document.get(key)
    if raw is None:
        return False
    if not isinstance(raw, list):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    annotations = cast(list[object], raw)
    if len(annotations) > _MAX_ANNOTATIONS:
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    for value in annotations:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > _MAX_ANNOTATION_LENGTH
            or any(ord(character) < 0x20 for character in value)
        ):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    return bool(annotations)


def _parse_series(
    raw_series: list[object],
    *,
    result_type: Literal["matrix", "vector"],
) -> tuple[PrometheusSeries, ...]:
    if len(raw_series) > _MAX_SERIES:
        raise MonitoringBoundaryError(MonitoringErrorCode.RESULT_BUDGET_EXCEEDED)
    series: list[PrometheusSeries] = []
    identities: set[tuple[tuple[str, str], ...]] = set()
    sample_count = 0
    for raw in raw_series:
        if not isinstance(raw, dict):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        item = cast(dict[str, object], raw)
        metric = item.get("metric")
        sample_field = "values" if result_type == "matrix" else "value"
        allowed_keys = {"metric", sample_field}
        if set(item) != allowed_keys or not isinstance(metric, dict):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        labels = _parse_labels(cast(dict[object, object], metric))
        if labels in identities:
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        identities.add(labels)
        if result_type == "matrix":
            raw_samples = item[sample_field]
            if not isinstance(raw_samples, list) or not raw_samples:
                raise MonitoringBoundaryError(
                    MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
                )
            samples = tuple(
                _parse_sample(value) for value in cast(list[object], raw_samples)
            )
        else:
            samples = (_parse_sample(item[sample_field]),)
        sample_count += len(samples)
        if sample_count > _MAX_SAMPLES:
            raise MonitoringBoundaryError(MonitoringErrorCode.RESULT_BUDGET_EXCEEDED)
        if any(
            current.timestamp <= previous.timestamp
            for previous, current in pairwise(samples)
        ):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        series.append(PrometheusSeries(labels=labels, samples=samples))
    return tuple(sorted(series, key=lambda value: value.labels))


def _parse_labels(raw: dict[object, object]) -> tuple[tuple[str, str], ...]:
    if len(raw) > _MAX_LABELS:
        raise MonitoringBoundaryError(MonitoringErrorCode.RESULT_BUDGET_EXCEEDED)
    labels: list[tuple[str, str]] = []
    for key, value in raw.items():
        if (
            not isinstance(key, str)
            or _LABEL_NAME.fullmatch(key) is None
            or len(key) > _MAX_LABEL_NAME_LENGTH
            or not isinstance(value, str)
            or len(value) > _MAX_LABEL_VALUE_LENGTH
            or any(
                ord(character) < 0x20 or ord(character) == 0x7F for character in value
            )
        ):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        labels.append((key, value))
    return tuple(sorted(labels))


def _parse_sample(raw: object) -> MetricSample:
    if not isinstance(raw, list):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    values = cast(list[object], raw)
    if len(values) != 2:
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    raw_timestamp, raw_value = values
    if not isinstance(raw_timestamp, (int, float)) or isinstance(raw_timestamp, bool):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    try:
        timestamp_value = float(raw_timestamp)
    except (OverflowError, ValueError):
        raise MonitoringBoundaryError(
            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None
    if (
        not math.isfinite(timestamp_value)
        or timestamp_value < 0
        or not isinstance(raw_value, str)
        or not raw_value
        or len(raw_value) > 64
        or _SAMPLE_VALUE.fullmatch(raw_value) is None
    ):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    try:
        timestamp = datetime.fromtimestamp(timestamp_value, UTC)
        value = float(raw_value)
    except (OSError, OverflowError, ValueError):
        raise MonitoringBoundaryError(
            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None
    if not math.isfinite(value):
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    return MetricSample(timestamp=timestamp, value=value)


def _unix_parameter(value: datetime) -> str:
    if value.utcoffset() is None:
        raise ValueError("Prometheus query time must include a timezone")
    return f"{value.astimezone(UTC).timestamp():.3f}"
