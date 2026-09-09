from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1Container,
    V1Deployment,
    V1DeploymentCondition,
    V1DeploymentSpec,
    V1DeploymentStatus,
    V1ExecAction,
    V1GRPCAction,
    V1HTTPGetAction,
    V1LabelSelector,
    V1ObjectMeta,
    V1PodSpec,
    V1PodTemplateSpec,
    V1Probe,
    V1TCPSocketAction,
)

from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

TARGET = ScenarioTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
)
OBSERVED_AT = datetime(2026, 8, 21, 9, 0, tzinfo=UTC)


class _AppsApi:
    def __init__(self, deployment: object) -> None:
        self.deployment = deployment
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    async def read_namespaced_deployment(
        self,
        name: str,
        namespace: str,
        **kwargs: object,
    ) -> object:
        self.calls.append((name, namespace, kwargs))
        return self.deployment


def _clients(apps_api: _AppsApi) -> KubernetesClients:
    return cast(
        KubernetesClients,
        SimpleNamespace(
            apps_api=apps_api,
            core_api=object(),
            discovery_api=object(),
            events_api=object(),
            storage_api=object(),
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )


def _deployment(
    *,
    image: str = "registry.invalid/k8s-incident-agent/missing:v1",
    command: list[str] | None = None,
    args: list[str] | None = None,
    reason: str | None = "ProgressDeadlineExceeded",
    match_expressions: list[object] | None = None,
    status: V1DeploymentStatus | None = None,
) -> V1Deployment:
    return V1Deployment(
        api_version="apps/v1",
        kind="Deployment",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=TARGET.name,
            uid="deployment-uid",
            resource_version="42",
            generation=3,
        ),
        spec=V1DeploymentSpec(
            replicas=1,
            selector=V1LabelSelector(
                match_labels={"app": "broken-image"},
                match_expressions=cast(Any, match_expressions),
            ),
            template=V1PodTemplateSpec(
                spec=V1PodSpec(
                    containers=[
                        V1Container(
                            name="z-sidecar",
                            image="sidecar:v1",
                            image_pull_policy="IfNotPresent",
                        ),
                        V1Container(
                            name="app",
                            image=image,
                            image_pull_policy="Always",
                            command=command or ["/agnhost"],
                            args=args or ["invalid-command"],
                        ),
                    ]
                )
            ),
        ),
        status=status
        if status is not None
        else V1DeploymentStatus(
            observed_generation=3,
            replicas=1,
            updated_replicas=1,
            ready_replicas=0,
            available_replicas=0,
            conditions=[
                V1DeploymentCondition(
                    type="Progressing",
                    status="False",
                    reason=reason,
                ),
                V1DeploymentCondition(
                    type="Available",
                    status="False",
                ),
            ],
        ),
    )


def _deployment_containers(deployment: V1Deployment) -> list[V1Container]:
    spec = cast(object, getattr(deployment, "spec", None))
    assert isinstance(spec, V1DeploymentSpec)
    template = cast(object, getattr(spec, "template", None))
    assert isinstance(template, V1PodTemplateSpec)
    pod_spec = cast(object, getattr(template, "spec", None))
    assert isinstance(pod_spec, V1PodSpec)
    containers = cast(object, getattr(pod_spec, "containers", None))
    assert isinstance(containers, list)
    container_values = cast(list[object], containers)
    assert all(isinstance(container, V1Container) for container in container_values)
    return cast(list[V1Container], container_values)


def _adapter(
    deployment: object,
    *,
    clock: Callable[[], datetime] = lambda: OBSERVED_AT,
) -> tuple[KubernetesEvidenceAdapter, _AppsApi]:
    apps_api = _AppsApi(deployment)
    return KubernetesEvidenceAdapter(_clients(apps_api), clock=clock), apps_api


@pytest.mark.asyncio
async def test_read_workload_projects_and_sorts_only_the_approved_fields() -> None:
    adapter, apps_api = _adapter(_deployment())

    observation = await adapter.read_workload(TARGET)

    assert apps_api.calls == [
        (
            TARGET.name,
            TARGET.namespace,
            {"_request_timeout": 10.0},
        )
    ]
    assert observation.model_dump(mode="json", by_alias=True) == {
        "evidenceKind": "workload",
        "targetRef": {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "namespace": TARGET.namespace,
            "name": TARGET.name,
            "uid": "deployment-uid",
        },
        "observedAt": "2026-08-21T09:00:00Z",
        "payload": {
            "workload": {
                "resourceVersion": "42",
                "generation": 3,
                "observedGeneration": 3,
                "replicas": {
                    "desired": 1,
                    "updated": 1,
                    "ready": 0,
                    "available": 0,
                },
                "selector": {"matchLabels": {"app": "broken-image"}},
                "containers": [
                    {
                        "name": "app",
                        "image": "registry.invalid/k8s-incident-agent/missing:v1",
                        "imagePullPolicy": "Always",
                        "command": ["/agnhost"],
                        "args": ["invalid-command"],
                        "probes": [],
                        "sourceIndex": 1,
                    },
                    {
                        "name": "z-sidecar",
                        "image": "sidecar:v1",
                        "imagePullPolicy": "IfNotPresent",
                        "command": [],
                        "args": [],
                        "probes": [],
                        "sourceIndex": 0,
                    },
                ],
                "conditions": [
                    {"type": "Available", "status": "False", "reason": None},
                    {
                        "type": "Progressing",
                        "status": "False",
                        "reason": "ProgressDeadlineExceeded",
                    },
                ],
            }
        },
        "truncated": False,
        "redacted": False,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [("cluster", "other-cluster"), ("namespace", "default")],
)
async def test_read_workload_rejects_target_outside_client_scope_before_request(
    field: str,
    value: str,
) -> None:
    adapter, apps_api = _adapter(_deployment())
    target = TARGET.model_copy(update={field: value})

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_workload(target)

    assert captured.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
    assert apps_api.calls == []


@pytest.mark.asyncio
async def test_read_workload_normalizes_missing_optional_status_fields() -> None:
    adapter, _ = _adapter(
        _deployment(
            reason=None,
            status=V1DeploymentStatus(
                conditions=[],
                replicas=1,
            ),
        )
    )

    observation = await adapter.read_workload(TARGET)
    workload = observation.payload.workload

    assert workload.observed_generation is None
    assert workload.replicas.updated == 0
    assert workload.replicas.ready == 0
    assert workload.replicas.available == 0
    assert workload.conditions == []


@pytest.mark.asyncio
async def test_read_workload_sanitizes_untrusted_values_and_aggregates_flags() -> None:
    adapter, _ = _adapter(
        _deployment(
            image="https://user:password@registry.test/image:v1?token=secret#fragment",
            reason="Bearer cluster-credential\x00",
        )
    )

    observation = await adapter.read_workload(TARGET)

    app = observation.payload.workload.containers[0]
    condition = observation.payload.workload.conditions[1]
    assert app.image == "https://registry.test/image:v1"
    assert condition.reason == "Bearer [REDACTED]"
    assert observation.redacted is True
    assert observation.truncated is False


@pytest.mark.asyncio
async def test_read_workload_projects_probe_handlers_and_effective_timings() -> None:
    deployment = _deployment()
    containers = _deployment_containers(deployment)
    app = containers[1]
    sidecar = containers[0]
    app.startup_probe = V1Probe(
        _exec=V1ExecAction(command=["sh", "-c", "password=not-projected"]),
    )
    app.readiness_probe = V1Probe(
        http_get=V1HTTPGetAction(
            host="internal.example",
            http_headers=[],
            path="/ready?token=secret",
            port="health",
            scheme="HTTPS",
        ),
        initial_delay_seconds=5,
        period_seconds=7,
        timeout_seconds=2,
        success_threshold=2,
        failure_threshold=4,
    )
    app.liveness_probe = V1Probe(tcp_socket=V1TCPSocketAction(port=8080))
    sidecar.liveness_probe = V1Probe(grpc=V1GRPCAction(port=9090, service="private"))
    adapter, _ = _adapter(deployment)

    observation = await adapter.read_workload(TARGET)

    app_probes = observation.payload.workload.containers[0].model_dump(
        mode="json",
        by_alias=True,
    )["probes"]
    assert app_probes == [
        {
            "probeKind": "startup",
            "handler": {"type": "exec"},
            "initialDelaySeconds": 0,
            "periodSeconds": 10,
            "timeoutSeconds": 1,
            "successThreshold": 1,
            "failureThreshold": 3,
        },
        {
            "probeKind": "readiness",
            "handler": {
                "type": "http_get",
                "path": "/ready?token=[REDACTED]",
                "port": "health",
                "scheme": "HTTPS",
            },
            "initialDelaySeconds": 5,
            "periodSeconds": 7,
            "timeoutSeconds": 2,
            "successThreshold": 2,
            "failureThreshold": 4,
        },
        {
            "probeKind": "liveness",
            "handler": {"type": "tcp_socket", "port": 8080},
            "initialDelaySeconds": 0,
            "periodSeconds": 10,
            "timeoutSeconds": 1,
            "successThreshold": 1,
            "failureThreshold": 3,
        },
    ]
    sidecar_probe = observation.payload.workload.containers[1].probes[0]
    assert sidecar_probe.model_dump(mode="json", by_alias=True)["handler"] == {
        "type": "grpc",
        "port": 9090,
    }
    serialized = observation.model_dump_json(by_alias=True)
    assert "internal.example" not in serialized
    assert "httpHeaders" not in serialized
    assert "not-projected" not in serialized
    assert "private" not in serialized
    assert observation.redacted is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "probe",
    [
        V1Probe(
            _exec=V1ExecAction(command=["true"]),
            tcp_socket=V1TCPSocketAction(port=8080),
        ),
        V1Probe(tcp_socket=V1TCPSocketAction(port=0)),
        V1Probe(tcp_socket=V1TCPSocketAction(port="INVALID_PORT_NAME")),
        V1Probe(grpc=V1GRPCAction(port=cast(Any, "grpc-name"))),
        V1Probe(http_get=V1HTTPGetAction(path="relative", port=8080)),
        V1Probe(_exec=V1ExecAction(command=["true"]), period_seconds=0),
    ],
)
async def test_read_workload_rejects_invalid_probe_contract(probe: V1Probe) -> None:
    deployment = _deployment()
    _deployment_containers(deployment)[1].readiness_probe = probe
    adapter, _ = _adapter(deployment)

    with pytest.raises(KubernetesBoundaryError) as error:
        await adapter.read_workload(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_read_workload_rejects_liveness_success_threshold_above_one() -> None:
    deployment = _deployment()
    _deployment_containers(deployment)[1].liveness_probe = V1Probe(
        _exec=V1ExecAction(command=["true"]),
        success_threshold=2,
    )
    adapter, _ = _adapter(deployment)

    with pytest.raises(KubernetesBoundaryError) as error:
        await adapter.read_workload(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_read_workload_redacts_a_value_after_a_sensitive_flag() -> None:
    adapter, _ = _adapter(_deployment(args=["--password", "literal-secret", "serve"]))

    observation = await adapter.read_workload(TARGET)

    assert observation.payload.workload.containers[0].args == [
        "--password",
        "[REDACTED]",
        "serve",
    ]
    assert observation.redacted is True


@pytest.mark.asyncio
async def test_read_workload_redacts_a_sensitive_value_split_across_argv() -> None:
    adapter, _ = _adapter(
        _deployment(
            command=["/agnhost", "--api-key"],
            args=["literal-secret", "serve"],
        )
    )

    observation = await adapter.read_workload(TARGET)

    container = observation.payload.workload.containers[0]
    assert container.command == ["/agnhost", "--api-key"]
    assert container.args == ["[REDACTED]", "serve"]
    assert observation.redacted is True


@pytest.mark.asyncio
async def test_read_workload_rejects_expression_selectors() -> None:
    adapter, _ = _adapter(_deployment(match_expressions=[object()]))

    with pytest.raises(KubernetesBoundaryError) as error:
        await adapter.read_workload(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
