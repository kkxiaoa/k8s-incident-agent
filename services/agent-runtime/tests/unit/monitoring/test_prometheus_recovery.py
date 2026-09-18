from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
from tests.recovery_fixtures import MonitoringFixture
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET

from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "before_apply",
        "stale",
        "future",
        "missing",
        "duplicate",
        "extra_label",
        "up_stale",
        "partial",
        "rule_missing",
        "rule_duplicate",
        "rule_stale",
        "rule_unknown",
        "rule_error",
        "rule_pagination",
        "rule_warning",
        "pending",
        "foreign_alert",
    ],
)
async def test_recovery_uses_raw_timestamps_complete_uid_coverage_and_individual_rule_health(
    fault: str | None,
) -> None:
    class Fixture(MonitoringFixture):
        def response(self, request: httpx.Request) -> httpx.Response:
            document: dict[str, Any] = super().response(request).json()
            data = document["data"]
            if request.url.path.endswith("rules"):
                rules = data["groups"][0]["rules"]
                if fault == "rule_missing":
                    rules.pop()
                elif fault == "rule_duplicate":
                    rules[-1] = rules[0]
                elif fault == "rule_stale":
                    rules[0]["lastEvaluation"] = (
                        FRESH_NOW - timedelta(seconds=61)
                    ).isoformat()
                elif fault in ("rule_unknown", "rule_error"):
                    rules[0]["health"] = "unknown" if fault == "rule_unknown" else "err"
                elif fault == "rule_pagination":
                    data["groupNextToken"] = "another-group"
                elif fault == "rule_warning":
                    document["warnings"] = ["partial rules"]
            else:
                query = parse_qs(request.content.decode())["query"][0]
                if query.startswith("label_replace"):
                    if fault in ("before_apply", "stale", "future"):
                        seconds = {"before_apply": -1, "stale": -61, "future": 1}[fault]
                        data["result"][1]["value"][1] = str(
                            (FRESH_NOW + timedelta(seconds=seconds)).timestamp()
                        )
                    elif fault == "missing":
                        data["result"].pop(0)
                    elif fault == "duplicate":
                        data["result"][0]["value"][1] = "2"
                    elif fault == "extra_label":
                        data["result"][0]["metric"]["uid"] = "unaggregated"
                if query.startswith("timestamp(up") and fault == "up_stale":
                    data["result"][0]["value"][1] = str(
                        (FRESH_NOW - timedelta(seconds=61)).timestamp()
                    )
                if query.startswith("ALERTS") and fault in ("pending", "foreign_alert"):
                    data["result"] = [
                        {
                            "metric": {
                                "alertname": "K8sIncidentImagePullBackOff",
                                "namespace": TARGET.namespace,
                                "deployment": TARGET.name
                                if fault == "pending"
                                else "sibling",
                                "alertstate": "pending",
                            },
                            "value": [FRESH_NOW.timestamp(), "1"],
                        }
                    ]
            return httpx.Response(200, json=document)

    fixture = Fixture()
    fixture.partial = fault == "partial"
    service = fixture.service()
    invalid = fault in (
        "extra_label",
        "rule_missing",
        "rule_duplicate",
        "rule_pagination",
        "rule_warning",
        "foreign_alert",
    )
    try:
        if invalid:
            with pytest.raises(MonitoringBoundaryError) as error:
                await service.observe_recovery(
                    target=TARGET,
                    container_name="nginx",
                    pod_uids=("pod-uid",),
                    applied_at=FRESH_NOW,
                )
            assert error.value.code is MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
        else:
            result = await service.observe_recovery(
                target=TARGET,
                container_name="nginx",
                pod_uids=("pod-uid",),
                applied_at=FRESH_NOW,
            )
            assert (
                result.chain_healthy
                and result.target_healthy
                and not result.active_alerts
            ) is (fault is None)
            if fault == "before_apply":
                assert result.chain_healthy and not result.target_healthy
            assert "ignored upstream diagnostic" not in result.model_dump_json()
    finally:
        await service.close()
    expressions = [
        parse_qs(request.content.decode())["query"][0]
        for request in fixture.requests
        if request.method == "POST"
    ]
    assert all("cluster=" not in query for query in expressions)
    assert any(
        "min(timestamp(kube_pod_container_status_ready{" in query
        and 'uid=~"pod\\-uid"' not in query
        for query in expressions
    )
    alerts = next(query for query in expressions if query.startswith("ALERTS"))
    assert f'deployment="{TARGET.name}"' in alerts and "pending|firing" in alerts
    rules = next(request for request in fixture.requests if request.method == "GET")
    assert rules.url.params["exclude_alerts"] == "true"
    # Recovery reads only the registered image-repair set, never every Deployment
    # discovery rule, so new catalog alerts cannot change the recovery gate.
    assert set(rules.url.params.get_list("rule_name[]")) == {
        "Watchdog",
        "K8sIncidentImagePullBackOff",
        "K8sIncidentCrashLoopBackOff",
        "K8sIncidentDeploymentReplicasUnavailable",
        "K8sIncidentReadinessProbeFailure",
        "K8sIncidentLivenessProbeRestart",
    }
    assert "K8sIncidentContainerOOMKilled" not in alerts
