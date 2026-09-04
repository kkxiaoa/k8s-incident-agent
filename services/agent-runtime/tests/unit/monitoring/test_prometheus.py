import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from pydantic import HttpUrl

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.monitoring import prometheus as prometheus_module
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.monitoring.contracts import MetricQueryState, MetricWindow
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.prometheus import PrometheusHttpClient
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT

NOW = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)
TARGET = KubernetesTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name='image-pull-"quoted\\name',
)
SERVICE_TARGET = KubernetesTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="v1",
    kind="Service",
    name="frontend",
)
PVC_TARGET = KubernetesTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="v1",
    kind="PersistentVolumeClaim",
    name="pvc-storage-class-missing",
)


def _response(document: str, *, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        headers={"content-type": "application/json"},
        content=document.encode(),
    )


def _service(
    response: httpx.Response,
    *,
    now: datetime = NOW,
) -> tuple[PrometheusQueryService, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return response

    http = httpx.AsyncClient(
        base_url="http://127.0.0.1:9090/",
        transport=httpx.MockTransport(handler),
    )
    client = PrometheusHttpClient(http)
    return (
        PrometheusQueryService(
            catalog=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
            client=client,
            cluster_id="k8s-incident-agent",
            now=lambda: now,
        ),
        requests,
    )


@pytest.mark.asyncio
async def test_range_query_keeps_zero_and_escapes_target_labels() -> None:
    service, requests = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{},"values":['
            '[1788339540,"1"],[1788339600,"0"]]}]}}'
        )
    )

    result = await service.query_panel(
        target=TARGET,
        panel_id="image-pull-affected-pods",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await service.close()

    assert result.state is MetricQueryState.OK
    assert result.current_value == 0
    assert result.latest_sample_at == NOW
    assert [sample.value for sample in result.samples] == [1, 0]
    form = dict(httpx.QueryParams(requests[0].content.decode()))
    assert requests[0].url.path == "/api/v1/query_range"
    assert 'namespace="k8s-incident-scenarios"' in form["query"]
    assert 'owner_name="image-pull-\\"quoted\\\\name"' in form["query"]


@pytest.mark.asyncio
async def test_service_endpoint_panel_preserves_multiple_ready_endpoints() -> None:
    service, requests = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{},"values":['
            '[1788339540,"1"],[1788339600,"2"]]}]}}'
        )
    )

    result = await service.query_panel(
        target=SERVICE_TARGET,
        panel_id="service-ready-endpoints",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await service.close()

    assert result.state is MetricQueryState.OK
    assert result.current_value == 2
    assert [sample.value for sample in result.samples] == [1, 2]
    form = dict(httpx.QueryParams(requests[0].content.decode()))
    assert (
        'kube_endpointslice_endpoints{namespace="k8s-incident-scenarios",ready="true"} > 0'
        in form["query"]
    )
    assert 'label_kubernetes_io_service_name="frontend"' in form["query"]


@pytest.mark.asyncio
async def test_pvc_panel_queries_only_the_exact_claim() -> None:
    service, requests = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{},"values":[[1788339600,"1"]]}]}}'
        )
    )

    result = await service.query_panel(
        target=PVC_TARGET,
        panel_id="pvc-pending-state",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await service.close()

    assert result.state is MetricQueryState.OK
    assert result.current_value == 1
    form = dict(httpx.QueryParams(requests[0].content.decode()))
    assert 'namespace="k8s-incident-scenarios"' in form["query"]
    assert 'persistentvolumeclaim="pvc-storage-class-missing"' in form["query"]
    assert "kube_persistentvolumeclaim_info" not in form["query"]


@pytest.mark.asyncio
async def test_query_time_uses_one_millisecond_precision_value_end_to_end() -> None:
    precise_now = NOW.replace(microsecond=123_600)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        form = dict(httpx.QueryParams(request.content.decode()))
        return _response(
            json.dumps(
                {
                    "status": "success",
                    "data": {
                        "resultType": "matrix",
                        "result": [
                            {
                                "metric": {},
                                "values": [[float(form["end"]), "1"]],
                            }
                        ],
                    },
                }
            )
        )

    http = httpx.AsyncClient(
        base_url="http://127.0.0.1:9090/",
        transport=httpx.MockTransport(handler),
    )
    service = PrometheusQueryService(
        catalog=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
        client=PrometheusHttpClient(http),
        cluster_id="k8s-incident-agent",
        now=lambda: precise_now,
    )

    result = await service.query_panel(
        target=TARGET,
        panel_id="image-pull-affected-pods",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await service.close()

    normalized_now = precise_now.replace(microsecond=123_000)
    form = dict(httpx.QueryParams(requests[0].content.decode()))
    assert form["end"] == f"{normalized_now.timestamp():.3f}"
    assert result.queried_at == normalized_now
    assert result.latest_sample_at == normalized_now


@pytest.mark.asyncio
async def test_empty_matrix_is_no_data_and_warning_is_partial() -> None:
    empty, _ = _service(
        _response('{"status":"success","data":{"resultType":"matrix","result":[]}}')
    )
    no_data = await empty.query_panel(
        target=TARGET,
        panel_id="image-pull-affected-pods",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await empty.close()
    assert no_data.state is MetricQueryState.NO_DATA
    assert no_data.current_value is None

    partial, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{},"values":[[1788339600,"0"]]}]},'
            '"warnings":["producer detail must not escape"]}'
        )
    )
    result = await partial.query_panel(
        target=TARGET,
        panel_id="image-pull-affected-pods",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await partial.close()
    assert result.state is MetricQueryState.PARTIAL
    assert "producer detail" not in result.model_dump_json()


@pytest.mark.asyncio
async def test_warnings_do_not_hide_an_invalid_infos_contract() -> None:
    service, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":[]},'
            '"warnings":["partial result"],"infos":"invalid"}'
        )
    )

    with pytest.raises(MonitoringBoundaryError) as error:
        await service.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await service.close()

    assert error.value.code is MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value",
    ["NaN", "+Inf", "-Inf", "not-a-number", "1_0"],
)
async def test_non_finite_or_invalid_sample_is_contract_invalid(value: str) -> None:
    service, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            f'{{"metric":{{}},"values":[[1788339600,"{value}"]]}}]}}}}'
        )
    )

    with pytest.raises(MonitoringBoundaryError) as error:
        await service.query_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await service.close()

    assert error.value.code is MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_missing_final_evaluation_sample_is_stale() -> None:
    stale_timestamp = (NOW - timedelta(seconds=15)).timestamp()
    service, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            f'{{"metric":{{}},"values":[[{stale_timestamp},"1"]]}}]}}}}'
        )
    )

    result = await service.query_panel(
        target=TARGET,
        panel_id="image-pull-affected-pods",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await service.close()

    assert result.state is MetricQueryState.STALE


@pytest.mark.asyncio
async def test_client_creation_disables_environment_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    real_client = httpx.AsyncClient

    def capture_client(*args: object, **kwargs: object) -> httpx.AsyncClient:
        captured.update(kwargs)
        kwargs["transport"] = httpx.MockTransport(lambda _: _response("{}"))
        return real_client(*args, **kwargs)

    monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:8080")
    monkeypatch.setattr(prometheus_module.httpx, "AsyncClient", capture_client)

    client = PrometheusHttpClient.create(HttpUrl("http://127.0.0.1:9090/"))
    await client.close()

    assert captured["trust_env"] is False


@pytest.mark.asyncio
async def test_duplicate_json_label_key_is_rejected() -> None:
    service, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{"job":"one","job":"two"},"values":['
            '[1788339600,"1"]]}]}}'
        )
    )

    with pytest.raises(MonitoringBoundaryError) as error:
        await service.query_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await service.close()

    assert error.value.code is MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_panel_query_rejects_labels_that_the_fixed_aggregate_cannot_emit() -> (
    None
):
    service, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{"unexpected":"series"},"values":['
            '[1788339600,"1"]]}]}}'
        )
    )

    with pytest.raises(MonitoringBoundaryError) as error:
        await service.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await service.close()

    assert error.value.code is MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_response_and_series_budgets_fail_closed() -> None:
    oversized, _ = _service(_response("x" * (256 * 1024 + 1)))
    with pytest.raises(MonitoringBoundaryError) as body_error:
        await oversized.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await oversized.close()
    assert body_error.value.code is MonitoringErrorCode.RESULT_BUDGET_EXCEEDED

    raw_series = ",".join(
        f'{{"metric":{{"instance":"{index}"}},"values":[[1788339600,"1"]]}}'
        for index in range(9)
    )
    too_many_series, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            + raw_series
            + "]}}"
        )
    )
    with pytest.raises(MonitoringBoundaryError) as series_error:
        await too_many_series.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await too_many_series.close()
    assert series_error.value.code is MonitoringErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
async def test_sample_and_label_budgets_fail_closed() -> None:
    samples = ",".join(f'[{1788339000 + index},"1"]' for index in range(513))
    too_many_samples, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{},"values":[' + samples + "]}]}}"
        )
    )
    with pytest.raises(MonitoringBoundaryError) as sample_error:
        await too_many_samples.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.SIX_HOURS,
        )
    await too_many_samples.close()
    assert sample_error.value.code is MonitoringErrorCode.RESULT_BUDGET_EXCEEDED

    labels = ",".join(f'"label_{index}":"value"' for index in range(33))
    too_many_labels, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            '{"metric":{' + labels + '},"values":[[1788339600,"1"]]}]}}'
        )
    )
    with pytest.raises(MonitoringBoundaryError) as label_error:
        await too_many_labels.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await too_many_labels.close()
    assert label_error.value.code is MonitoringErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "values",
    [
        '[["invalid","1"]]',
        '[[1788339600,"1"],[1788339599,"2"]]',
        '[[1788339600,"1"],[1788339600,"2"]]',
    ],
)
async def test_invalid_or_non_increasing_timestamps_are_rejected(values: str) -> None:
    service, _ = _service(
        _response(
            '{"status":"success","data":{"resultType":"matrix","result":['
            f'{{"metric":{{}},"values":{values}}}]}}'
        )
    )

    with pytest.raises(MonitoringBoundaryError) as error:
        await service.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await service.close()

    assert error.value.code is MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_query_error_is_projected_for_console_but_raised_for_evidence() -> None:
    response = _response(
        '{"status":"error","errorType":"execution",'
        '"error":"sensitive producer detail"}',
        status=422,
    )
    console, _ = _service(response)
    result = await console.query_panel(
        target=TARGET,
        panel_id="image-pull-affected-pods",
        window=MetricWindow.FIFTEEN_MINUTES,
    )
    await console.close()

    assert result.state is MetricQueryState.QUERY_ERROR
    assert "sensitive producer detail" not in result.model_dump_json()

    evidence, _ = _service(response)
    with pytest.raises(MonitoringBoundaryError) as error:
        await evidence.observe_panel(
            target=TARGET,
            panel_id="image-pull-affected-pods",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    await evidence.close()
    assert error.value.code is MonitoringErrorCode.QUERY_FAILED
    assert "sensitive producer detail" not in str(error.value)


@pytest.mark.asyncio
async def test_total_request_timeout_includes_transport_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def block(_request: httpx.Request) -> httpx.Response:
        await asyncio.Event().wait()
        raise AssertionError("blocked request unexpectedly completed")

    monkeypatch.setattr(prometheus_module, "_REQUEST_TIMEOUT_SECONDS", 0.01)
    http = httpx.AsyncClient(
        base_url="http://127.0.0.1:9090/",
        transport=httpx.MockTransport(block),
    )
    service = PrometheusQueryService(
        catalog=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
        client=PrometheusHttpClient(http),
        cluster_id="k8s-incident-agent",
        now=lambda: NOW,
    )

    with pytest.raises(MonitoringBoundaryError) as error:
        async with asyncio.timeout(1):
            await service.observe_panel(
                target=TARGET,
                panel_id="image-pull-affected-pods",
                window=MetricWindow.FIFTEEN_MINUTES,
            )
    await service.close()

    assert error.value.code is MonitoringErrorCode.REQUEST_TIMEOUT
    assert error.value.retryable is True


@pytest.mark.asyncio
async def test_health_queries_are_fixed_and_project_only_normalized_signals() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        form = dict(httpx.QueryParams(request.content.decode()))
        if form["query"].startswith("up{"):
            return _response(
                '{"status":"success","data":{"resultType":"vector","result":['
                '{"metric":{"job":"kube-state-metrics"},'
                '"value":[1788339600,"1"]},'
                '{"metric":{"job":"alertmanager"},'
                '"value":[1788339600,"1"]}]}}'
            )
        return _response(
            '{"status":"success","data":{"resultType":"vector","result":['
            '{"metric":{"alertname":"Watchdog"},'
            '"value":[1788339600,"1"]}]}}'
        )

    http = httpx.AsyncClient(
        base_url="http://127.0.0.1:9090/",
        transport=httpx.MockTransport(handler),
    )
    service = PrometheusQueryService(
        catalog=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
        client=PrometheusHttpClient(http),
        cluster_id="k8s-incident-agent",
        now=lambda: NOW,
    )

    result = await service.read_health_signals()
    await service.close()

    assert result.model_dump() == {
        "checkedAt": NOW,
        "partial": False,
        "kubeStateMetricsAvailable": True,
        "alertmanagerAvailable": True,
        "watchdogRuleFiring": True,
    }
    assert [request.url.path for request in requests] == [
        "/api/v1/query",
        "/api/v1/query",
    ]
    queries = [
        dict(httpx.QueryParams(request.content.decode()))["query"]
        for request in requests
    ]
    assert queries == [
        'up{job=~"kube-state-metrics|alertmanager"}',
        'ALERTS{alertname="Watchdog",alertstate="firing"}',
    ]
    assert [
        dict(httpx.QueryParams(request.content.decode()))["lookback_delta"]
        for request in requests
    ] == ["60s", "60s"]
