"""Versioned lifecycle cases through authenticated intake and the real persisted graph.

Only Kubernetes/Prometheus I/O and the model are replaced. These checks prove wiring,
identity and cost accounting, not the diagnostic quality of a live model.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID

import httpx
import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1ContainerState,
    V1ContainerStateRunning,
    V1ContainerStateWaiting,
    V1ObjectReference,
    V1Probe,
    V1ResourceRequirements,
    V1TCPSocketAction,
)
from langchain_core.runnables.config import RunnableConfig
from sqlalchemy import select
from tests.factories import (
    diagnostic_model_stub,
    monitoring_health_service_stub,
    operator_sessions_stub,
)
from tests.unit.application.test_alerts import alert_payload
from tests.unit.kubernetes import test_adapter_pvc_storage as pvc_fixtures
from tests.unit.kubernetes import test_adapter_service_network as service_fixtures
from tests.unit.monitoring.test_reconciliation import (
    CurrentMonitoringFixture,
    CurrentTargetFixture,
)
from tests.unit.repair.test_repair_preparation import FRESH_NOW, credential
from tests.unit.routes.test_incidents import (
    _QueuedScheduler,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.workflow.test_target_investigation import (
    _CapturingModel,  # pyright: ignore[reportPrivateUsage]
    _database,  # pyright: ignore[reportPrivateUsage]
    _diagnosed,  # pyright: ignore[reportPrivateUsage]
    _model_snapshot,  # pyright: ignore[reportPrivateUsage]
    _tool_call,  # pyright: ignore[reportPrivateUsage]
)

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.alerts import AlertmanagerApplicationService
from k8s_incident_agent.application.events import (
    EventDependencies,
    IncidentEventService,
    RunEventNotifier,
)
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.application.reconciliation import AlertReconciler
from k8s_incident_agent.config import Settings
from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.policy import DiagnosticPolicyCatalog
from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    DiagnosisWorkflowRunSnapshot,
    RunBudget,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.monitoring.auth import AlertmanagerWebhookAuthenticator
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.persistence.models import IncidentRow, RunRow
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import GraphDependencies, build_incident_graph


@pytest.fixture(scope="module")
def lifecycle_cases() -> dict[str, Any]:
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadScenarioCatalog} from './scripts/scenario.mjs'; console.log(JSON.stringify(loadScenarioCatalog(process.cwd()).filter(e=>e.lifecycle)))",
        ],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return {entry["lifecycle"]["kind"]: entry for entry in json.loads(result.stdout)}


@pytest.mark.parametrize(
    "kind",
    [
        "correlated-deployment",
        "reconfigured-deployment",
        "persistent-pvc",
        "persistent-service",
    ],
)
async def test_versioned_lifecycle_crosses_webhook_reconcile_graph_and_read_contracts(
    tmp_path: Path,
    lifecycle_cases: dict[str, Any],
    kind: str,
) -> None:
    case = lifecycle_cases[kind]
    definition, lifecycle = case["definition"], case["lifecycle"]
    target = KubernetesTarget.model_validate(definition["target"])
    assert target.namespace is not None
    clock = [FRESH_NOW]
    deployment = CurrentTargetFixture(clock[0])
    deployment.deployment.metadata.name = target.name
    for replica in deployment.replicas:
        replica.metadata.owner_references[0].name = target.name
    deployment.deployment.spec.template.spec.containers[
        0
    ].resources = V1ResourceRequirements(
        requests={"cpu": "10m"}, limits={"memory": "64Mi"}
    )
    deployment.pod.spec.containers[0].resources = deepcopy(
        deployment.deployment.spec.template.spec.containers[0].resources
    )
    deployment.deployment.status.ready_replicas = 0
    deployment.deployment.status.available_replicas = 0
    deployment.pod.status.container_statuses[0].ready = False
    deployment.pod.status.container_statuses[0].image_id = "containerd://observed-image"
    deployment.pod.status.container_statuses[0].state = V1ContainerState(
        waiting=V1ContainerStateWaiting(reason="CrashLoopBackOff")
    )
    if kind == "correlated-deployment":
        probe = V1Probe(
            tcp_socket=V1TCPSocketAction(port=8081),
            period_seconds=2,
            timeout_seconds=1,
            failure_threshold=3,
        )
        deployment.deployment.spec.template.spec.containers[
            0
        ].liveness_probe = deepcopy(probe)
        deployment.pod.spec.containers[0].liveness_probe = probe
    claim = cast(Any, pvc_fixtures._claim("unavailable", phase="Pending"))  # pyright: ignore[reportPrivateUsage]
    claim.metadata.creation_timestamp = clock[0] - timedelta(minutes=30)
    claim.metadata.labels = {"k8s-incident-agent.io/pending-policy": "immediate"}
    service = cast(Any, service_fixtures._service(selector={"app": "wrong"}))  # pyright: ignore[reportPrivateUsage]
    service.metadata.creation_timestamp = clock[0] - timedelta(minutes=30)
    pod = service_fixtures._pod("candidate")  # pyright: ignore[reportPrivateUsage]
    endpoint = cast(Any, service_fixtures._endpoint_slice(ready=True))  # pyright: ignore[reportPrivateUsage]
    endpoint.endpoints[0].target_ref = V1ObjectReference(
        api_version="v1",
        kind="Pod",
        namespace=target.namespace,
        name="candidate",
        uid="candidate-uid",
    )
    core = service_fixtures._CoreApi(service, [pod])  # pyright: ignore[reportPrivateUsage]
    discovery = service_fixtures._DiscoveryApi([])  # pyright: ignore[reportPrivateUsage]
    if target.kind == "Service":
        clients = SimpleNamespace(
            apps_api=object(),
            core_api=core,
            discovery_api=discovery,
            events_api=object(),
            storage_api=object(),
            timeout_seconds=10,
            cluster_id=target.cluster,
            diagnostic_namespace=target.namespace,
        )
        adapter = KubernetesEvidenceAdapter(
            cast(KubernetesClients, clients), clock=lambda: clock[0]
        )
    elif target.kind == "PersistentVolumeClaim":
        _, pvc_core, storage, events = pvc_fixtures._adapter(  # pyright: ignore[reportPrivateUsage]
            claim,
            pvc_fixtures._storage_class("unavailable", binding_mode="Immediate"),  # pyright: ignore[reportPrivateUsage]
        )  # pyright: ignore[reportPrivateUsage]
        clients = SimpleNamespace(
            apps_api=object(),
            core_api=pvc_core,
            discovery_api=object(),
            events_api=events,
            storage_api=storage,
            timeout_seconds=10,
            cluster_id=target.cluster,
            diagnostic_namespace=target.namespace,
        )
        adapter = KubernetesEvidenceAdapter(
            cast(KubernetesClients, clients), clock=lambda: clock[0]
        )
    else:
        adapter = deployment.adapter()
    catalog = load_alert_catalog(REPOSITORY_ROOT / "monitoring/catalog")
    policies = DiagnosticPolicyCatalog(
        scenarios=load_scenario_catalog(REPOSITORY_ROOT / "scenarios"), alerts=catalog
    )
    alerts = [definition["monitoring_alert_id"]]
    if kind == "correlated-deployment":
        alerts += [
            "K8sIncidentCrashLoopBackOff",
            "K8sIncidentDeploymentReplicasUnavailable",
        ]
    monitoring = CurrentMonitoringFixture(clock)
    monitoring.active_rules = dict.fromkeys(alerts, 2)
    monitoring.expression_rules = set(alerts)
    prometheus = monitoring.service()
    token = tmp_path / "webhook-token"
    token.write_text("a" * 32)
    budget = RunBudget(max_model_calls=5, max_tool_calls=4, timeout_seconds=90)
    async with (
        _database(tmp_path) as (paths, database),
        open_checkpoint_store(paths.checkpoint_database) as saver,
    ):
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        incidents = IncidentApplicationService(
            catalog=(),
            scenario_alert_ids={},
            alert_catalog=catalog,
            repository=repository,
            supervisor=_QueuedScheduler(),
            credential=credential(),
            model=_model_snapshot,
            budget=budget,
            now=lambda: clock[0],
        )
        reconciler = AlertReconciler(
            repository=repository,
            adapter=adapter,
            prometheus=prometheus,
            now=lambda: clock[0],
            diagnose=lambda target, at, revision: incidents.reconcile_alert_target(
                target, catalog, at, revision
            ),
        )
        alerts_service = AlertmanagerApplicationService(
            catalog=catalog,
            authenticator=AlertmanagerWebhookAuthenticator.from_file(token),
            repository=repository,
            cluster_id=target.cluster,
            diagnostic_namespace=target.namespace,
            now=lambda: clock[0],
            request_reconciliation=reconciler.request_reconciliation,
        )

        class FiniteReplay(IncidentEventService):
            async def open_stream(
                self, incident_id: UUID, last_event_id_header: str | None
            ) -> AsyncGenerator[bytes]:
                detail = await repository.get_incident_detail(
                    incident_id, run_id=None, event_limit=100
                )
                assert detail is not None
                stream = await super().open_stream(incident_id, last_event_id_header)

                async def finite() -> AsyncGenerator[bytes]:
                    try:
                        async for frame in stream:
                            yield frame
                            if frame.startswith(
                                f"id: {detail.event_cursor}\n".encode()
                            ):
                                break
                    finally:
                        await stream.aclose()

                return finite()

        event_service = FiniteReplay(
            EventDependencies(repository=repository, notifier=RunEventNotifier())
        )

        @asynccontextmanager
        async def context(_: Settings) -> AsyncGenerator[RuntimeContainer]:
            yield RuntimeContainer(
                operator=operator_sessions_stub(),
                diagnostic_model=diagnostic_model_stub(),
                incidents=incidents,
                events=event_service,
                alerts=alerts_service,
                monitoring=monitoring_health_service_stub(),
            )

        app = api.create_app(
            settings=Settings(
                runtime_paths=paths,
                alertmanager_webhook_token_file=token,
                _env_file=None,  # pyright: ignore[reportCallIssue]
            ),
            runtime_context_factory=context,
        )  # pyright: ignore[reportCallIssue]
        payload = json.loads(alert_payload())
        template = payload["alerts"][0]
        payload["alerts"] = []
        for index, alert in enumerate(alerts):
            occurrence = deepcopy(template)
            occurrence["fingerprint"] = f"{index + 1:016x}"
            occurrence["startsAt"] = clock[0].isoformat().replace("+00:00", "Z")
            occurrence["labels"] = {
                "alertname": alert,
                "cluster": target.cluster,
                "namespace": target.namespace,
                {
                    "Deployment": "deployment",
                    "Service": "service",
                    "PersistentVolumeClaim": "persistentvolumeclaim",
                }[target.kind]: target.name,
            }
            payload["alerts"].append(occurrence)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://testserver"
            ) as client,
        ):

            async def notify() -> None:
                response = await client.post(
                    "/api/v1/alerts/alertmanager",
                    headers={"Authorization": "Bearer " + "a" * 32},
                    json=payload,
                )
                assert response.status_code == 204, response.text

            async def run_pending() -> None:
                for run_id in await repository.list_recoverable_run_ids():
                    run = await repository.get_workflow_run_snapshot(run_id)
                    assert isinstance(run, DiagnosisWorkflowRunSnapshot)
                    tool = {
                        "Deployment": "get_workload",
                        "Service": "get_service_network",
                        "PersistentVolumeClaim": "get_pvc_storage",
                    }[target.kind]
                    model = _CapturingModel(
                        responses=[
                            _tool_call(tool, "identity"),
                            _diagnosed(run.id, ["identity"]),
                        ]
                    )
                    graph = build_incident_graph(
                        GraphDependencies(
                            repository=repository,
                            checkpointer=saver,
                            model=model,
                            model_snapshot=_model_snapshot(),
                            credential=credential(),
                            adapter=adapter,
                            prometheus=prometheus,
                            now=lambda: clock[0],
                        ),
                        run,
                        policies.resolve(run.source, run.target),
                    )
                    config: RunnableConfig = {
                        "configurable": {"thread_id": str(run.id)}
                    }
                    await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                        {"run_id": str(run.id)},
                        config,
                        context=DiagnosticToolContext(
                            run=AgentRunSnapshot(
                                id=run.id,
                                started_at=clock[0],
                                timeout_seconds=budget.timeout_seconds,
                            ),
                            target=target,
                            credential=credential(),
                            adapter=adapter,
                            repository=repository,
                            now=lambda: clock[0],
                            prometheus=prometheus,
                            occurred_at=run.occurred_at,
                        ),
                        durability="sync",
                    )  # pyright: ignore[reportUnknownMemberType]

            async def tick(seconds: int = 30) -> None:
                clock[0] += timedelta(seconds=seconds)
                deployment.now = clock[0]
                await reconciler.reconcile()
                await run_pending()

            async def rows() -> tuple[list[IncidentRow], list[RunRow]]:
                async with database.session_factory() as session:
                    return list(await session.scalars(select(IncidentRow))), list(
                        await session.scalars(select(RunRow))
                    )

            assert (
                await client.post("/api/v1/alerts/alertmanager", json=payload)
            ).status_code == 401
            await notify()
            assert (await rows()) == ([], [])
            await tick()
            episode_rows, run_rows = await rows()
            assert len(episode_rows) == len(run_rows) == 1
            initial_id, first_run_id = episode_rows[0].id, run_rows[0].id
            for _ in range(lifecycle["observation_seconds"] // 30):
                if (
                    kind == "reconfigured-deployment"
                    and len(payload["alerts"]) == 1
                    and clock[0] >= FRESH_NOW + timedelta(minutes=5)
                ):
                    availability = "K8sIncidentDeploymentReplicasUnavailable"
                    alerts.append(availability)
                    monitoring.active_rules[availability] = 2
                    monitoring.expression_rules.add(availability)
                    occurrence = deepcopy(payload["alerts"][0])
                    occurrence["labels"]["alertname"] = availability
                    occurrence["fingerprint"] = f"{2:016x}"
                    occurrence["startsAt"] = clock[0].isoformat().replace("+00:00", "Z")
                    payload["alerts"].append(occurrence)
                await notify()
                await tick()
            before_repeats = [run.id for run in (await rows())[1]]
            assert len(before_repeats) == (
                2 if kind == "reconfigured-deployment" else 1
            )
            assert before_repeats[0] == first_run_id
            if kind == "reconfigured-deployment":
                latest = (await client.get(f"/api/v1/incidents/{initial_id}")).json()
                assert latest["selectedRun"]["diagnosisTrigger"]["reason"] == (
                    "new_symptom"
                )
                assert latest["selectedRun"]["diagnosisTrigger"]["source"]["ref"] == (
                    "K8sIncidentDeploymentReplicasUnavailable"
                )
                # Cooldown can retain an intermediate change that becomes unnecessary
                # once the current facts return to the successful diagnosis baseline.
                for cpu in ("20m", "10m"):
                    cast(
                        Any,
                        deployment.deployment.spec.template.spec.containers[
                            0
                        ].resources,
                    ).requests["cpu"] = cpu
                    cast(Any, deployment.pod.spec.containers[0].resources).requests[
                        "cpu"
                    ] = cpu
                    await tick()
                    deferred = (
                        await client.get(f"/api/v1/incidents/{initial_id}")
                    ).json()["diagnosisDeferral"]
                    if cpu == "20m":
                        assert deferred["reason"] == "cooldown"
                    else:
                        assert deferred is None
                assert [run.id for run in (await rows())[1]] == before_repeats
            # A new occurrence with comparable facts associates to the same UID
            # without replacing the successful diagnosis baseline or consuming a Run.
            payload["alerts"][0]["startsAt"] = (
                clock[0].isoformat().replace("+00:00", "Z")
            )
            for _ in range(22):
                await notify()
                await tick()
            assert [run.id for run in (await rows())[1]] == before_repeats
            if kind == "reconfigured-deployment":
                cast(
                    Any,
                    deployment.deployment.spec.template.spec.containers[0].resources,
                ).requests["cpu"] = "20m"
                cast(Any, deployment.pod.spec.containers[0].resources).requests[
                    "cpu"
                ] = "20m"
                await tick()
                assert len((await rows())[1]) == 3
                changed = (await client.get(f"/api/v1/incidents/{initial_id}")).json()
                assert changed["selectedRun"]["diagnosisTrigger"]["reason"] == (
                    "facts_changed"
                )
                assert changed["selectedRun"]["id"] not in before_repeats
                deployment.deployment.metadata.uid = "replacement-uid"
                deployment.deployment.metadata.creation_timestamp = clock[0]
                for replica in deployment.replicas:
                    replica.metadata.owner_references[0].uid = "replacement-uid"
                clock[0] += timedelta(seconds=1)
                payload["alerts"] = [payload["alerts"][0]]
                monitoring.active_rules = {alerts[0]: 2}
                monitoring.expression_rules = {alerts[0]}
                payload["alerts"][0]["startsAt"] = (
                    clock[0].isoformat().replace("+00:00", "Z")
                )
                await notify()
                await tick()
                assert len((await rows())[0]) == 2
                assert len((await rows())[1]) == 4
            latest_id = (await rows())[0][-1].id
            monitoring.rule_fault = "query"
            monitoring.rule_fault_name = alerts[0]
            for _ in range(11):
                await tick()
            blind = (await client.get(f"/api/v1/incidents/{latest_id}")).json()
            assert blind["alertSummary"]["state"] == "UNKNOWN"
            assert blind["incident"]["lifecycleStatus"] == "OPEN"
            monitoring.rule_fault = None
            if kind != "persistent-pvc":
                monitoring.active_rules.clear()
                monitoring.expression_rules.clear()
                if target.kind == "Service":
                    service.spec.selector = {"app": "actual"}
                    discovery.endpoint_slices = [endpoint]
                else:
                    deployment.deployment.status.ready_replicas = 1
                    deployment.deployment.status.available_replicas = 1
                    deployment.pod.status.container_statuses[0].ready = True
                    deployment.pod.status.container_statuses[
                        0
                    ].state = V1ContainerState(
                        running=V1ContainerStateRunning(started_at=clock[0])
                    )
                for _ in range(11):
                    await tick()
            else:
                await tick()
            final = (await client.get(f"/api/v1/incidents/{latest_id}")).json()
            assert final["incident"]["lifecycleStatus"] == (
                "OPEN" if kind == "persistent-pvc" else "CLOSED"
            )
            assert final["alertSummary"]["state"] == (
                "FIRING" if kind == "persistent-pvc" else "CLEAR"
            )
            assert (
                final["alertSignal"]["status"] == "FIRING"
                and final["alertSignal"]["endsAt"] is None
            )
            episode_rows, run_rows = await rows()
            assert len(run_rows) == (4 if kind == "reconfigured-deployment" else 1)
            for episode in episode_rows:
                async with asyncio.timeout(5):
                    replay = await client.get(
                        f"/api/v1/incidents/{episode.id}/events",
                        headers={"Last-Event-ID": "0"},
                    )
                assert replay.status_code == 200
                frames = [
                    json.loads(frame.split("data: ")[1])
                    for frame in replay.text.strip().split("\n\n")
                ]
                associated = [
                    frame
                    for frame in frames
                    if "targetUid" in frame and "fingerprint" in frame
                ]
                assert len(associated) == (
                    len(alerts) + 1 if episode.id == initial_id else 1
                )
                assert len({frame["targetUid"] for frame in associated}) == 1
                history = (
                    await client.get(f"/api/v1/incidents/{episode.id}/runs?limit=50")
                ).json()
                for summary in history["items"]:
                    detail = (
                        await client.get(
                            f"/api/v1/incidents/{episode.id}?runId={summary['id']}"
                        )
                    ).json()
                    assert detail["selectedRun"]["status"] == "COMPLETED", detail
                    persisted = next(run for run in run_rows if run.id == summary["id"])
                    assert detail["selectedRun"]["diagnosisUsage"] == {
                        "modelCalls": persisted.model_calls,
                        "toolCalls": persisted.tool_calls,
                        "maxModelCalls": 5,
                        "maxToolCalls": 4,
                        "timeoutSeconds": 90,
                    }
                    assert (
                        persisted.model_calls is not None
                        and 0 < persisted.model_calls <= 5
                    )
                    assert (
                        persisted.tool_calls is not None
                        and 0 < persisted.tool_calls <= 4
                    )
                    assert detail["selectedRun"]["requestSource"] == "system"
                    trigger = detail["selectedRun"]["diagnosisTrigger"]
                    assert trigger["changes"]
                    assert trigger["source"] == trigger["changes"][0]["source"]
                    for change in trigger["changes"]:
                        assert any(frame.get("change") == change for frame in frames)
                    ids = {item["id"] for item in detail["evidence"]}
                    assert (
                        set(detail["diagnosis"]["rootCauses"][0]["evidenceIds"]) <= ids
                    )
                    assert any(
                        frame.get("runId") == summary["id"]
                        and frame.get("runStatus") == "COMPLETED"
                        for frame in frames
                    )
                if episode.id == initial_id and kind == "reconfigured-deployment":
                    assert episode.lifecycle_status == "OPEN"
        await prometheus.close()
