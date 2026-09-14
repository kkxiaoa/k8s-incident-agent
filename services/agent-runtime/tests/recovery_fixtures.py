from __future__ import annotations

import copy
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1ContainerState,
    V1ContainerStateRunning,
    V1DeploymentStatus,
    V1ListMeta,
    V1ObjectMeta,
    V1PodCondition,
    V1PodList,
)
from pydantic import HttpUrl

from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.monitoring.prometheus import PrometheusHttpClient
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from tests.unit.repair.test_repair_preparation import (
    FRESH_NOW,
    PREVIOUS,
    KubernetesFixture,
)


class RecoveryFixture(KubernetesFixture):
    def __init__(self) -> None:
        super().__init__()
        self.old_ready_pod = False
        self.deployment.metadata.generation = 4
        self.deployment.spec.template.metadata = V1ObjectMeta(
            labels={"app": "image-pull"}
        )
        self.deployment.spec.template.spec.containers[0].image = PREVIOUS
        self.deployment.status = V1DeploymentStatus(
            observed_generation=4,
            replicas=1,
            updated_replicas=1,
            available_replicas=1,
            ready_replicas=1,
        )
        for rs in self.replicas:
            rs.spec.replicas = 0
            rs.spec.template.metadata = V1ObjectMeta(labels={"app": "image-pull"})
        # The Deployment controller may reuse the old healthy ReplicaSet.
        self.replicas[1].spec.replicas = 1
        self.replicas[1].spec.template = copy.deepcopy(self.deployment.spec.template)
        self.replicas[1].spec.template.metadata.labels["pod-template-hash"] = "old-hash"
        self.pod.metadata.name, self.pod.metadata.uid = (
            "recovered-pod",
            "recovered-pod-uid",
        )
        self.pod.metadata.owner_references[0].name = "rs-old"
        self.pod.metadata.owner_references[0].uid = "rs-old"
        self.pod.spec.containers[0].image = PREVIOUS
        self.pod.status.phase = "Running"
        self.pod.status.conditions = [V1PodCondition(type="Ready", status="True")]
        self.pod.status.container_statuses[0].state = V1ContainerState(
            running=V1ContainerStateRunning()
        )
        self.pod.status.container_statuses[0].image = PREVIOUS
        self.pod.status.container_statuses[0].ready = True

    async def list_namespaced_pod(self, **_: object) -> object:
        pods = [self.pod]
        if self.old_ready_pod:
            old = copy.deepcopy(self.pod)
            old.metadata.name, old.metadata.uid = "old-ready-pod", "old-ready-uid"
            old.metadata.owner_references[0].name = "rs-new"
            old.metadata.owner_references[0].uid = "rs-new"
            pods.append(old)
        return V1PodList(metadata=V1ListMeta(), items=pods)


class MonitoringFixture:
    def __init__(self, clock: list[datetime] | None = None) -> None:
        self.clock = clock or [FRESH_NOW]
        self.oldest: datetime | None = None
        self.covered = 1
        self.up = 1
        self.active = False
        self.partial = False
        self.rule_health = "ok"
        self.requests: list[httpx.Request] = []
        self.catalog = load_alert_catalog(
            Path(__file__).resolve().parents[3] / "monitoring" / "catalog"
        )

    def response(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        at = self.clock[0]
        if request.url.path == "/api/v1/rules":
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "groups": [
                            {
                                "name": "k8s-incident-agent",
                                "file": "/etc/prometheus/rules/alerts.yaml",
                                "rules": [
                                    {
                                        "name": name,
                                        "type": "alerting",
                                        "health": self.rule_health,
                                        "lastEvaluation": at.isoformat(),
                                        "alerts": None,
                                        "evaluationTime": 0.003,
                                        "state": "firing",
                                        "lastError": "ignored upstream diagnostic",
                                    }
                                    for name in request.url.params.get_list(
                                        "rule_name[]"
                                    )
                                ],
                            }
                        ]
                    },
                },
            )
        form = parse_qs(request.content.decode())
        expression = form["query"][0]
        results: list[dict[str, Any]]
        if expression.startswith("up{") or expression.startswith("timestamp(up{"):
            results = [
                {
                    "metric": {"job": job},
                    "value": [
                        at.timestamp(),
                        str(
                            at.timestamp()
                            if expression.startswith("timestamp")
                            else self.up
                        ),
                    ],
                }
                for job in ("kube-state-metrics", "alertmanager")
            ]
        elif expression.startswith("ALERTS"):
            results = (
                [
                    {
                        "metric": {
                            "alertname": self.catalog.entries[0].alert_id,
                            "namespace": "k8s-incident-scenarios",
                            "deployment": "image-pull-backoff",
                            "alertstate": "firing",
                        },
                        "value": [at.timestamp(), "1"],
                    }
                ]
                if self.active
                else []
            )
        else:
            results = [
                {
                    "metric": {"check": "covered"},
                    "value": [at.timestamp(), str(self.covered)],
                },
                {
                    "metric": {"check": "oldest"},
                    "value": [at.timestamp(), str((self.oldest or at).timestamp())],
                },
            ]
        return httpx.Response(
            200,
            json={
                "status": "success",
                "data": {"resultType": "vector", "result": results},
                **({"warnings": ["partial"]} if self.partial else {}),
            },
        )

    def service(self) -> PrometheusQueryService:
        return PrometheusQueryService(
            catalog=self.catalog,
            client=PrometheusHttpClient(
                httpx.AsyncClient(
                    base_url=str(HttpUrl("http://127.0.0.1:9090")),
                    transport=httpx.MockTransport(self.response),
                )
            ),
            cluster_id="k8s-incident-agent",
            now=lambda: self.clock[0],
        )
