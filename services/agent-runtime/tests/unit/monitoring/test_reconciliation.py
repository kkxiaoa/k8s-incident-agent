from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from urllib.parse import parse_qs

import httpx
import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1HTTPGetAction,
    V1ObjectReference,
    V1PodCondition,
    V1Probe,
    V1ResourceRequirements,
)
from tests.recovery_fixtures import MonitoringFixture, RecoveryFixture
from tests.unit.kubernetes.test_adapter_pvc_storage import (
    TARGET as PVC_TARGET,
)
from tests.unit.kubernetes.test_adapter_pvc_storage import (
    _adapter as claim_adapter,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.kubernetes.test_adapter_pvc_storage import (
    _claim,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.kubernetes.test_adapter_service_network import (
    TARGET as SERVICE_TARGET,
)
from tests.unit.kubernetes.test_adapter_service_network import (
    _adapter as service_adapter,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.kubernetes.test_adapter_service_network import (
    _endpoint_slice,  # pyright: ignore[reportPrivateUsage]
    _pod,  # pyright: ignore[reportPrivateUsage]
    _service,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET

from k8s_incident_agent.monitoring.contracts import CurrentAlertState, ObservationReason
from k8s_incident_agent.monitoring.service import (
    _input_coverage_query,  # pyright: ignore[reportPrivateUsage]
    _reconciliation_inputs,  # pyright: ignore[reportPrivateUsage]
)


class CurrentTargetFixture(RecoveryFixture):
    def __init__(self, at: datetime = FRESH_NOW) -> None:
        super().__init__()
        self.now = at
        self.deployment.metadata.creation_timestamp = at - timedelta(minutes=30)
        self.pod.metadata.creation_timestamp = at - timedelta(minutes=25)
        self.pod.status.container_statuses[0].state.running.started_at = at - timedelta(
            minutes=20
        )
        self.pod.status.container_statuses[
            0
        ].container_id = "containerd://current-container"
        self.pod.status.conditions.append(
            V1PodCondition(type="PodScheduled", status="True")
        )
        self.pod.spec.containers[0].resources = V1ResourceRequirements(
            limits={"memory": "64Mi"}
        )
        self.pod.spec.containers[0].readiness_probe = V1Probe(
            http_get=V1HTTPGetAction(path="/ready", port=80)
        )


class CurrentMonitoringFixture(MonitoringFixture):
    def __init__(self, clock: list[datetime] | None = None) -> None:
        super().__init__(clock)
        self.active_rules: dict[str, int] = {}
        self.expression_rules: set[str] = set()
        self.missing_rules: set[str] = set()
        self.range_fault: str | None = None
        self.rule_fault: str | None = None
        self.rule_fault_name: str | None = None

    def response(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("rules"):
            document: dict[str, Any] = super().response(request).json()
            candidates = document["data"]["groups"][0]["rules"]
            rule = (
                next(
                    (
                        item
                        for item in candidates
                        if item["name"] == self.rule_fault_name
                    ),
                    None,
                )
                if self.rule_fault_name
                else candidates[0]
            )
            if rule is None:
                return httpx.Response(200, json=document)
            if self.rule_fault == "query":
                rule["query"] = "vector(0)"
            elif self.rule_fault == "duration":
                rule["duration"] += 1
            elif self.rule_fault == "keep_firing":
                rule["keepFiringFor"] += 1
            elif self.rule_fault == "labels":
                rule["labels"]["severity"] = "critical"
            elif self.rule_fault in ("stale", "future"):
                rule["lastEvaluation"] = (
                    self.clock[0]
                    + timedelta(seconds=-61 if self.rule_fault == "stale" else 1)
                ).isoformat()
            return httpx.Response(200, json=document)
        self.requests.append(request)
        form = parse_qs(request.content.decode())
        query = form["query"][0]
        at = float(form.get("time", form.get("end", []))[0])
        names = tuple(
            dict.fromkeys(re.findall(r'"alertname", "(K8sIncident[^"]+)"', query))
        )
        if request.url.path.endswith("query_range"):
            start = float(form["start"][0])
            end = float(form["end"][0])
            step = int(form["step"][0].removesuffix("s"))
            points = [
                [start + index * step, "1"]
                for index in range(int((end - start) / step) + 1)
            ]
            if self.range_fault == "gap":
                points.pop(len(points) // 2)
            elif self.range_fault == "missing_raw":
                points[len(points) // 2][1] = "0"
            elif self.range_fault == "two_points":
                points = [points[0], points[-1]]
            result = [
                {"metric": {"alertname": name}, "values": points} for name in names
            ]
            result_type = "matrix"
        else:
            if query.startswith("max by(alertname)"):
                selected = {
                    name: value
                    for name, value in self.active_rules.items()
                    if name in query
                }
            elif any(entry.rule.expression in query for entry in self.catalog.entries):
                selected = {name: 1 for name in names if name in self.expression_rules}
            else:
                selected = {name: int(name not in self.missing_rules) for name in names}
            result = [
                {"metric": {"alertname": name}, "value": [at, str(value)]}
                for name, value in selected.items()
            ]
            result_type = "vector"
        return httpx.Response(
            200,
            json={
                "status": "success",
                "data": {"resultType": result_type, "result": result},
            },
        )


async def test_current_observation_reads_all_target_rules_at_one_instant_in_bounded_batches() -> (
    None
):
    fixture = CurrentMonitoringFixture()
    service = fixture.service()
    facts = await CurrentTargetFixture().adapter().read_current_target(TARGET)
    try:
        rules = await service.read_reconciliation_rules()
        result = await service.observe_current_alerts(
            TARGET, facts, rules, at=FRESH_NOW
        )
        assert len(result) == 11
        assert all(
            rule.state is CurrentAlertState.CLEAR and rule.complete for rule in result
        )
        assert len(rules) == 13
    finally:
        await service.close()
    rule_requests = [
        request for request in fixture.requests if request.url.path.endswith("rules")
    ]
    assert [
        len(request.url.params.get_list("rule_name[]")) for request in rule_requests
    ] == [8, 5]
    query_requests = [
        parse_qs(request.content.decode())
        for request in fixture.requests
        if request.method == "POST"
    ]
    assert len(query_requests) == 7
    assert all(form["lookback_delta"] == ["60s"] for form in query_requests)
    assert all(
        float(form.get("time", form.get("end", []))[0]) == FRESH_NOW.timestamp()
        for form in query_requests
    )
    assert all("cluster=" not in form["query"][0] for form in query_requests)
    assert all(
        len(set(re.findall(r'"alertname", "(K8sIncident[^"]+)"', form["query"][0])))
        <= 8
        for form in query_requests
    )


@pytest.mark.parametrize(
    "fault", ["query", "duration", "keep_firing", "labels", "stale", "future"]
)
async def test_definition_drift_and_stale_evaluation_do_not_erase_observed_activity(
    fault: str,
) -> None:
    fixture = CurrentMonitoringFixture()
    fixture.rule_fault = fault
    fixture.active_rules["K8sIncidentImagePullBackOff"] = 2
    service = fixture.service()
    try:
        rules = await service.read_reconciliation_rules()
        result = await service.observe_current_alerts(
            TARGET,
            await CurrentTargetFixture().adapter().read_current_target(TARGET),
            rules,
            at=FRESH_NOW,
        )
    finally:
        await service.close()
    observed = {rule.alert_id: rule for rule in result}
    active = observed["K8sIncidentImagePullBackOff"]
    assert active.state is CurrentAlertState.FIRING and not active.complete
    assert active.reason is (
        ObservationReason.STALE
        if fault in ("stale", "future")
        else ObservationReason.RULE_MISMATCH
    )
    assert observed["K8sIncidentCrashLoopBackOff"].complete


@pytest.mark.parametrize("fault", ["gap", "missing_raw", "two_points"])
async def test_whole_range_coverage_is_required_without_poisoning_unrelated_rules(
    fault: str,
) -> None:
    fixture = CurrentMonitoringFixture()
    fixture.range_fault = fault
    service = fixture.service()
    try:
        result = await service.observe_current_alerts(
            TARGET,
            await CurrentTargetFixture().adapter().read_current_target(TARGET),
            await service.read_reconciliation_rules(),
            at=FRESH_NOW,
        )
    finally:
        await service.close()
    observed = {rule.alert_id: rule for rule in result}
    assert (
        observed["K8sIncidentContainerCPUThrottled"].reason
        is ObservationReason.INPUT_MISSING
    )
    assert (
        observed["K8sIncidentContainerAbnormalExit"].state is CurrentAlertState.UNKNOWN
    )
    assert observed["K8sIncidentImagePullBackOff"].state is CurrentAlertState.CLEAR


@pytest.mark.parametrize(
    "dependency",
    [
        "CrashLoopBackOff",
        "LivenessProbeRestart",
        "ContainerOOMKilled",
        "ContainerProbeFailing",
    ],
)
async def test_suppression_dependencies_propagate_only_source_rule_contract_failure(
    dependency: str,
) -> None:
    fixture = CurrentMonitoringFixture()
    fixture.rule_fault = "query"
    fixture.rule_fault_name = f"K8sIncident{dependency}"
    fixture.active_rules["K8sIncidentContainerAbnormalExit"] = 1
    service = fixture.service()
    try:
        result = await service.observe_current_alerts(
            TARGET,
            await CurrentTargetFixture().adapter().read_current_target(TARGET),
            await service.read_reconciliation_rules(),
            at=FRESH_NOW,
        )
    finally:
        await service.close()
    observed = {rule.alert_id: rule for rule in result}
    abnormal = observed["K8sIncidentContainerAbnormalExit"]
    assert (
        abnormal.state is CurrentAlertState.PENDING
        and abnormal.reason is ObservationReason.RULE_MISMATCH
    )
    assert observed["K8sIncidentContainerOOMKilled"].complete is (
        dependency not in ("CrashLoopBackOff", "ContainerOOMKilled")
    )
    assert observed["K8sIncidentImagePullBackOff"].complete


async def test_invalid_source_state_cannot_become_a_complete_clear_observation() -> (
    None
):
    fixture = CurrentMonitoringFixture()
    fixture.active_rules["K8sIncidentImagePullBackOff"] = 3
    service = fixture.service()
    try:
        result = await service.observe_current_alerts(
            TARGET,
            await CurrentTargetFixture().adapter().read_current_target(TARGET),
            await service.read_reconciliation_rules(),
            at=FRESH_NOW,
        )
    finally:
        await service.close()
    observed = next(
        rule for rule in result if rule.alert_id == "K8sIncidentImagePullBackOff"
    )
    assert observed.state is CurrentAlertState.UNKNOWN and not observed.complete
    assert observed.reason is ObservationReason.INCOMPLETE


@pytest.mark.parametrize("active", [None, 1, 2])
async def test_missing_raw_and_native_expression_are_not_inferred_clear(
    active: int | None,
) -> None:
    fixture = CurrentMonitoringFixture()
    name = "K8sIncidentContainerCPUThrottled"
    if active is not None:
        fixture.active_rules[name] = active
    fixture.missing_rules.add(name)
    fixture.expression_rules.add("K8sIncidentImagePullBackOff")
    service = fixture.service()
    try:
        result = await service.observe_current_alerts(
            TARGET,
            await CurrentTargetFixture().adapter().read_current_target(TARGET),
            await service.read_reconciliation_rules(),
            at=FRESH_NOW,
        )
    finally:
        await service.close()
    observed = {rule.alert_id: rule for rule in result}
    expected = (
        CurrentAlertState.UNKNOWN
        if active is None
        else CurrentAlertState.PENDING
        if active == 1
        else CurrentAlertState.FIRING
    )
    assert observed[name].state is expected
    assert not observed[name].complete
    assert (
        observed["K8sIncidentImagePullBackOff"].reason
        is ObservationReason.WAITING_EVALUATION
    )
    assert observed["K8sIncidentImagePullBackOff"].state is CurrentAlertState.UNKNOWN


async def promtool_cases() -> dict[str, Any]:
    """Compile production proofs; input labels/values are independent KSM/kubelet samples."""
    at = datetime.fromtimestamp(1800, UTC)
    fixture = CurrentTargetFixture(at)
    facts = await fixture.adapter().read_current_target(TARGET)
    inputs = _reconciliation_inputs(facts)
    namespace = 'namespace="k8s-incident-scenarios"'
    pod = f'{namespace},pod="recovered-pod",uid="recovered-pod-uid"'
    container = f'{pod},container="workload"'
    owner = {
        "series": f'kube_pod_owner{{job="kube-state-metrics",{pod},owner_kind="ReplicaSet",owner_is_controller="true",owner_name="rs-old"}}',
        "values": "1+0x120",
    }
    replica_owner = {
        "series": f'kube_replicaset_owner{{job="kube-state-metrics",{namespace},replicaset="rs-old",owner_kind="Deployment",owner_is_controller="true",owner_name="image-pull-backoff"}}',
        "values": "1+0x120",
    }
    running = {
        "series": f'kube_pod_container_status_running{{job="kube-state-metrics",{container}}}',
        "values": "1+0x120",
    }
    restarts = {
        "series": f'kube_pod_container_status_restarts_total{{job="kube-state-metrics",{container}}}',
        "values": "0+0x120",
    }
    labels = {
        "series": f'kube_pod_labels{{job="kube-state-metrics",{pod}}}',
        "values": "1+0x120",
    }
    probes = {
        "series": f'prober_probe_total{{job="kubelet-probes",{namespace},pod="recovered-pod",pod_uid="recovered-pod-uid",container="workload",probe_type="Readiness",result="successful"}}',
        "values": "0+1x120",
    }
    started = {
        "series": f'kube_pod_container_state_started{{job="kube-state-metrics",{container}}}',
        "values": "600+0x120",
    }
    cases: list[dict[str, Any]] = []

    def add(
        name: str,
        suffix: str,
        series: list[dict[str, str]],
        value: float,
        *,
        ranges: bool = False,
    ) -> None:
        rule = f"K8sIncident{suffix}"
        expression = _input_coverage_query(inputs, (rule,), at=at)
        if ranges:
            window = max(item.window_seconds for item in inputs[rule].specific)
            proof = _input_coverage_query(inputs, (rule,), at=at, range_sample=True)
            expression = f"({expression}) * min_over_time(({proof})[{window}s:15s])"
        cases.append(
            {
                "name": name,
                "interval": "15s",
                "input_series": series,
                "promql_expr_test": [
                    {
                        "expr": expression,
                        "eval_time": "30m",
                        "exp_samples": [
                            {"labels": f'{{alertname="{rule}"}}', "value": value}
                        ],
                    }
                ],
            }
        )

    add(
        "running container does not require waiting reason",
        "ImagePullBackOff",
        [owner, replica_owner, running],
        1,
    )
    add(
        "missing running metric is not healthy absence",
        "ImagePullBackOff",
        [owner, replica_owner],
        0,
    )
    add(
        "another Pod UID cannot cover current Pod",
        "ImagePullBackOff",
        [
            owner,
            replica_owner,
            {
                **running,
                "series": running["series"].replace("recovered-pod-uid", "old-pod-uid"),
            },
        ],
        0,
    )
    add(
        "current replicas match SDK values",
        "DeploymentReplicasUnavailable",
        [
            {
                "series": f'kube_deployment_spec_replicas{{job="kube-state-metrics",{namespace},deployment="image-pull-backoff"}}',
                "values": "1+0x120",
            },
            {
                "series": f'kube_deployment_status_replicas_available{{job="kube-state-metrics",{namespace},deployment="image-pull-backoff"}}',
                "values": "1+0x120",
            },
        ],
        1,
    )
    add(
        "missing Deployment replicas is not zero",
        "DeploymentReplicasUnavailable",
        [],
        0,
    )
    add(
        "never terminated container needs no last termination metric",
        "ContainerOOMKilled",
        [owner, replica_owner],
        1,
    )
    add(
        "scheduled Pod normally has no unschedulable series",
        "PodUnschedulable",
        [owner, replica_owner],
        1,
    )
    add(
        "a true zero restart counter covers its full window",
        "ContainerAbnormalExit",
        [owner, replica_owner, restarts],
        1,
        ranges=True,
    )
    gap = "0+0x87 _ _ _ _ _ _ _ _ 0+0x24"
    add(
        "recent counter points do not repair an earlier gap",
        "ContainerAbnormalExit",
        [owner, replica_owner, {**restarts, "values": gap}],
        0,
        ranges=True,
    )
    add(
        "a never-created failure counter is valid with positive probe producer",
        "ContainerProbeFailing",
        [owner, replica_owner, labels, probes, started],
        1,
        ranges=True,
    )
    add(
        "no probe producer cannot prove zero failures",
        "ContainerProbeFailing",
        [owner, replica_owner, labels, started],
        0,
        ranges=True,
    )
    memory_limit = {
        "series": f'kube_pod_container_resource_limits{{job="kube-state-metrics",{container},resource="memory",unit="byte"}}',
        "values": "67108864+0x120",
    }
    memory = {
        "series": f'container_memory_working_set_bytes{{job="kubelet-resource",{namespace},pod="recovered-pod",container="workload"}}',
        "values": "0+0x120",
    }
    resource_start = {
        "series": f'container_start_time_seconds{{job="kubelet-resource",{namespace},pod="recovered-pod",container="workload"}}',
        "values": "600.875+0x120",
    }
    add(
        "resource start fractional seconds match API whole seconds",
        "ContainerMemoryNearLimit",
        [owner, replica_owner, memory_limit, memory, resource_start],
        1,
    )
    add(
        "resource start in another second cannot match current container",
        "ContainerMemoryNearLimit",
        [
            owner,
            replica_owner,
            memory_limit,
            memory,
            {**resource_start, "values": "599.999+0x120"},
        ],
        0,
    )
    add(
        "missing memory usage cannot mean zero bytes",
        "ContainerMemoryNearLimit",
        [owner, replica_owner, memory_limit, resource_start],
        0,
    )
    for cgroup in (
        "/kubepods/burstable/podrecovered-pod-uid/current-container",
        "/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-podrecovered_pod_uid.slice/cri-containerd-current-container.scope",
    ):
        counters = [
            {
                "series": f'{metric}{{job="kubelet-cadvisor",{namespace},pod="recovered-pod",container="workload",id="{cgroup}"}}',
                "values": "0+1x120",
            }
            for metric in (
                "container_cpu_cfs_periods_total",
                "container_cpu_cfs_throttled_periods_total",
            )
        ]
        add(
            "current cgroup counter coverage " + cgroup,
            "ContainerCPUThrottled",
            [owner, replica_owner, *counters],
            1,
            ranges=True,
        )
        add(
            "old container counters cannot cover recreated container " + cgroup,
            "ContainerCPUThrottled",
            [
                owner,
                replica_owner,
                *[
                    {
                        **item,
                        "series": item["series"].replace(
                            "current-container", "old-container"
                        ),
                    }
                    for item in counters
                ],
            ],
            0,
            ranges=True,
        )
        add(
            "old and current cgroups cannot dilute the expression " + cgroup,
            "ContainerCPUThrottled",
            [
                owner,
                replica_owner,
                *counters,
                *[
                    {
                        **item,
                        "series": item["series"].replace(
                            "current-container", "old-container"
                        ),
                    }
                    for item in counters
                ],
            ],
            0,
            ranges=True,
        )
    add(
        "absent CFS is not zero",
        "ContainerCPUThrottled",
        [owner, replica_owner],
        0,
        ranges=True,
    )
    fixture.deployment.spec.replicas = 0
    fixture.deployment.status.available_replicas = 0
    inputs = _reconciliation_inputs(await fixture.adapter().read_current_target(TARGET))
    add(
        "zero desired and available are present values",
        "DeploymentReplicasUnavailable",
        [
            {
                "series": f'kube_deployment_spec_replicas{{job="kube-state-metrics",{namespace},deployment="image-pull-backoff"}}',
                "values": "0+0x120",
            },
            {
                "series": f'kube_deployment_status_replicas_available{{job="kube-state-metrics",{namespace},deployment="image-pull-backoff"}}',
                "values": "0+0x120",
            },
        ],
        1,
    )
    add(
        "mismatched replicas cannot establish current state",
        "DeploymentReplicasUnavailable",
        [
            {
                "series": f'kube_deployment_spec_replicas{{job="kube-state-metrics",{namespace},deployment="image-pull-backoff"}}',
                "values": "1+0x120",
            },
            {
                "series": f'kube_deployment_status_replicas_available{{job="kube-state-metrics",{namespace},deployment="image-pull-backoff"}}',
                "values": "0+0x120",
            },
        ],
        0,
    )
    replica_series = [
        {
            "series": f'{metric}{{job="kube-state-metrics",{namespace},deployment="image-pull-backoff"}}',
            "values": "0+0x120",
        }
        for metric in (
            "kube_deployment_spec_replicas",
            "kube_deployment_status_replicas_available",
        )
    ]
    fixture.old_ready_pod = True
    two_replica_facts = await fixture.adapter().read_current_target(TARGET)
    shared_replica_facts = two_replica_facts.model_copy(
        update={
            "pods": [
                item.model_copy(
                    update={
                        "pod": item.pod.model_copy(
                            update={"owner": facts.pods[0].pod.owner}
                        )
                    }
                )
                for item in two_replica_facts.pods
            ]
        }
    )
    other_owner, other_running = (
        {
            **item,
            "series": item["series"]
            .replace("recovered-pod-uid", "old-ready-uid")
            .replace("recovered-pod", "old-ready-pod"),
        }
        for item in (owner, running)
    )
    shared_series = [owner, other_owner, replica_owner, running, other_running]
    names = tuple(
        f"K8sIncident{suffix}"
        for suffix in (
            "ImagePullBackOff",
            "ContainerOOMKilled",
            "DeploymentReplicasUnavailable",
        )
    )
    for name, current_facts, series, values in (
        (
            "two Pods share one ReplicaSet proof across rules",
            shared_replica_facts,
            shared_series,
            (1, 1, 1),
        ),
        (
            "one rule's missing input does not poison another rule",
            shared_replica_facts,
            shared_series[:-1],
            (0, 1, 1),
        ),
        (
            "a missing Pod owner cannot be covered by another Pod",
            shared_replica_facts,
            [owner, replica_owner, running, other_running],
            (0, 0, 1),
        ),
        (
            "a replaced Pod UID cannot share the previous owner's proof",
            shared_replica_facts,
            [
                owner,
                {
                    **other_owner,
                    "series": other_owner["series"].replace(
                        "old-ready-uid", "replaced-uid"
                    ),
                },
                replica_owner,
                running,
                other_running,
            ],
            (0, 0, 1),
        ),
        (
            "a missing shared ReplicaSet only invalidates Pod rules",
            shared_replica_facts,
            [owner, other_owner, running, other_running],
            (0, 0, 1),
        ),
        (
            "different ReplicaSets require their own owner proofs",
            two_replica_facts,
            [
                owner,
                {
                    **other_owner,
                    "series": other_owner["series"].replace("rs-old", "rs-new"),
                },
                replica_owner,
                {
                    **replica_owner,
                    "series": replica_owner["series"].replace("rs-old", "rs-new"),
                },
                running,
                other_running,
            ],
            (1, 1, 1),
        ),
        (
            "one ReplicaSet cannot cover another missing ReplicaSet",
            two_replica_facts,
            [
                owner,
                {
                    **other_owner,
                    "series": other_owner["series"].replace("rs-old", "rs-new"),
                },
                replica_owner,
                running,
                other_running,
            ],
            (0, 0, 1),
        ),
    ):
        cases.append(
            {
                "name": name,
                "interval": "15s",
                "input_series": [*series, *replica_series],
                "promql_expr_test": [
                    {
                        "expr": _input_coverage_query(
                            _reconciliation_inputs(current_facts), names, at=at
                        ),
                        "eval_time": "30m",
                        "exp_samples": [
                            {"labels": f'{{alertname="{rule}"}}', "value": value}
                            for rule, value in zip(names, values, strict=True)
                        ],
                    }
                ],
            }
        )
    service = cast(Any, _service(selector={"app": "actual"}))
    service.metadata.creation_timestamp = datetime.fromtimestamp(100, UTC)
    endpoint = cast(Any, _endpoint_slice(ready=True))
    endpoint.endpoints[0].target_ref = V1ObjectReference(
        api_version="v1",
        kind="Pod",
        namespace=SERVICE_TARGET.namespace,
        name="candidate",
        uid="candidate-uid",
    )
    adapter, _, _ = service_adapter(
        service, [_pod("candidate")], [endpoint], clock=lambda: at
    )
    inputs = _reconciliation_inputs(await adapter.read_current_target(SERVICE_TARGET))
    service_labels = f'job="kube-state-metrics",{namespace},service="service-selector-mismatch",uid="service-uid"'
    service_series = [
        {
            "series": f'kube_service_labels{{{service_labels},label_k8s_incident_agent_io_monitor_selector="true"}}',
            "values": "1+0x120",
        },
        {
            "series": f'kube_service_spec_type{{{service_labels},type="ClusterIP"}}',
            "values": "1+0x120",
        },
        {
            "series": f'kube_service_info{{{service_labels},cluster_ip="10.96.0.20"}}',
            "values": "1+0x120",
        },
        {
            "series": f'kube_pod_labels{{job="kube-state-metrics",{namespace},pod="candidate",uid="candidate-uid",label_k8s_incident_agent_io_service="service-selector-mismatch"}}',
            "values": "1+0x120",
        },
        {
            "series": f'kube_endpointslice_labels{{job="kube-state-metrics",{namespace},endpointslice="service-selector-mismatch-abcde",label_kubernetes_io_service_name="service-selector-mismatch"}}',
            "values": "1+0x120",
        },
        {
            "series": f'kube_endpointslice_endpoints{{job="kube-state-metrics",{namespace},endpointslice="service-selector-mismatch-abcde",ready="true",address="10.244.0.1"}}',
            "values": "1+0x120",
        },
    ]
    add(
        "Service raw coverage returns no endpoint addresses",
        "ServiceEndpointsUnavailable",
        service_series,
        1,
    )
    add(
        "missing endpoint input is not an empty healthy Service",
        "ServiceEndpointsUnavailable",
        service_series[:-1],
        0,
    )
    add(
        "old Service UID does not cover current Service",
        "ServiceEndpointsUnavailable",
        [
            {
                **item,
                "series": item["series"].replace(
                    'uid="service-uid"', 'uid="old-service-uid"'
                ),
            }
            for item in service_series
        ],
        0,
    )
    for ready, ready_label in ((True, "true"), (False, "false"), (None, "")):
        endpoint.endpoints[0].conditions.ready = ready
        inputs = _reconciliation_inputs(
            await adapter.read_current_target(SERVICE_TARGET)
        )
        for metric_ready in ("true", "false", ""):
            if ready is True and metric_ready == "true":
                continue
            add(
                f"Service SDK ready {ready_label or 'nil'} compared with metric ready {metric_ready or 'empty'}",
                "ServiceEndpointsUnavailable",
                [
                    *service_series[:-1],
                    {
                        **service_series[-1],
                        "series": service_series[-1]["series"].replace(
                            'ready="true"', f'ready="{metric_ready}"'
                        ),
                    },
                ],
                float(metric_ready == ready_label),
            )
    claim = cast(Any, _claim("standard", phase="Bound"))
    claim.metadata.creation_timestamp = datetime.fromtimestamp(100, UTC)
    claim.metadata.labels = {"k8s-incident-agent.io/pending-policy": "immediate"}
    inputs = _reconciliation_inputs(
        await claim_adapter(claim, None)[0].read_current_target(PVC_TARGET)
    )
    claim_labels = f'job="kube-state-metrics",{namespace},persistentvolumeclaim="pvc-binding-pending"'
    claim_series = [
        {
            "series": f"kube_persistentvolumeclaim_created{{{claim_labels}}}",
            "values": "100+0x120",
        },
        {
            "series": f'kube_persistentvolumeclaim_status_phase{{{claim_labels},phase="Pending"}}',
            "values": "0+0x120",
        },
        {
            "series": f'kube_persistentvolumeclaim_labels{{{claim_labels},label_k8s_incident_agent_io_pending_policy="immediate"}}',
            "values": "1+0x120",
        },
    ]
    add(
        "Bound PVC includes a real zero Pending metric",
        "PersistentVolumeClaimPending",
        claim_series,
        1,
    )
    add(
        "missing Pending series is not zero",
        "PersistentVolumeClaimPending",
        [claim_series[0], claim_series[2]],
        0,
    )
    add(
        "old PVC creation metric cannot cover recreated claim",
        "PersistentVolumeClaimPending",
        [{**claim_series[0], "values": "99+0x120"}, *claim_series[1:]],
        0,
    )
    return {"rule_files": [], "evaluation_interval": "15s", "tests": cases}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(promtool_cases())))
