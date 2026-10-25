from datetime import datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from tests.factories import normalized_trigger
from tests.unit.application.test_incidents import (
    _scenario,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.persistence.test_alert_observations import current_observation
from tests.unit.persistence.test_episode_diagnosis import CATALOG
from tests.unit.persistence.test_incident_lifecycle import advance_window, open_episode
from tests.unit.persistence.test_monitoring_overview import (
    _incident,  # pyright: ignore[reportPrivateUsage]
    _signal,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET, credential
from tests.unit.routes.test_incidents import (
    _client,  # pyright: ignore[reportPrivateUsage]
)

from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    EvidenceRecord,
    IncidentLifecycleStatus,
    IncidentStatus,
)
from k8s_incident_agent.monitoring.contracts import CurrentAlertState, ObservationReason
from k8s_incident_agent.persistence.repositories import IncidentRepository

IMAGE = "K8sIncidentImagePullBackOff"
CRASH = "K8sIncidentCrashLoopBackOff"


class NoScheduling:
    async def schedule(self, run_id: UUID) -> None:
        pytest.fail(f"Queries must not schedule a Run: {run_id}")


def query_service(
    repository: IncidentRepository, clock: list[datetime]
) -> IncidentApplicationService:
    scenario = _scenario()
    return IncidentApplicationService(
        catalog=(scenario,),
        scenario_alert_ids={scenario.scenario_id: scenario.monitoring_alert_id},
        alert_catalog=CATALOG,
        repository=repository,
        supervisor=NoScheduling(),
        credential=credential(),
        model=lambda: None,
        budget=BUDGET,
        now=lambda: clock[0],
    )


async def test_api_filters_before_pagination_across_blocks_without_occurrence_duplicates(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        observed = await current_observation(CurrentAlertState.FIRING)
        assert observed.facts is not None
        matches: list[str] = []
        async with database.session_factory() as session, session.begin():
            for index in range(125):
                row = _incident(
                    source_ref=IMAGE,
                    status=IncidentStatus.RECEIVED,
                    created_at=FRESH_NOW - timedelta(seconds=index),
                )
                (
                    row.cluster,
                    row.namespace,
                    row.api_version,
                    row.kind,
                    row.resource_name,
                ) = (
                    TARGET.cluster,
                    TARGET.namespace,
                    TARGET.api_version,
                    TARGET.kind,
                    TARGET.name,
                )
                row.lifecycle_status = IncidentLifecycleStatus.OPEN
                row.target_uid = (
                    observed.facts.target_ref.uid
                    if index >= 100
                    else "previous-target-uid"
                )
                session.add(row)
                await session.flush()
                if index >= 100:
                    matches.append(row.id)
                    for count in range(3):
                        signal = _signal(
                            row,
                            status=AlertSignalStatus.FIRING,
                            starts_at=FRESH_NOW - timedelta(minutes=count + 1),
                        )
                        signal.fingerprint = f"{index * 3 + count:016x}"
                        signal.trigger_ref = CRASH if count else IMAGE
                        session.add(signal)
        await repository.save_current_alert_observation(observed)
        service = query_service(repository, [FRESH_NOW])
        async with _client(tmp_path, service) as client:
            query = {
                "alertId": CRASH,
                "lifecycleStatus": "OPEN",
                "alertState": "FIRING",
                "status": "RECEIVED",
            }
            first = await client.get("/api/v1/incidents", params=query)
            assert first.status_code == 200
            body = first.json()
            assert [item["id"] for item in body["items"]] == matches[:20]
            assert len(body["alertTypes"]) == len(CATALOG.entries)
            assert all(
                item["alertIds"] == sorted((IMAGE, CRASH)) and item["latestRun"] is None
                for item in body["items"]
            )
            cursor = body["nextCursor"]
            assert cursor is not None
            second = (
                await client.get(
                    "/api/v1/incidents", params={**query, "cursor": cursor}
                )
            ).json()
            assert [item["id"] for item in second["items"]] == matches[20:]
            assert second["nextCursor"] is None
            for key, value in {
                "alertId": IMAGE,
                "lifecycleStatus": "CLOSED",
                "alertState": "UNKNOWN",
                "status": "FAILED",
            }.items():
                rejected = await client.get(
                    "/api/v1/incidents", params={**query, "cursor": cursor, key: value}
                )
                assert (
                    rejected.status_code == 400
                    and rejected.json()["error"]["code"] == "invalid_cursor"
                )
            for key in query:
                rejected = await client.get(
                    "/api/v1/incidents", params={key: "not-registered"}
                )
                assert (
                    rejected.status_code == 422
                    and rejected.json()["error"]["code"] == "invalid_request"
                )
            # Without a type predicate the first hundred candidates do not match;
            # the current-state filter must continue into the following block.
            sparse = (
                await client.get("/api/v1/incidents", params={"alertState": "FIRING"})
            ).json()
            assert [item["id"] for item in sparse["items"]] == matches[:20]
            detail = (await client.get(f"/api/v1/incidents/{matches[0]}")).json()
            assert detail["selectedRun"] is None
            assert detail["alertSummary"] == body["items"][0]["alertSummary"]


@pytest.mark.parametrize("identity", ["matching", "conflicting", "missing"])
async def test_list_and_detail_share_all_historical_identity_and_freshness_evidence(
    tmp_path: Path, identity: str
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        created = await repository.create_incident_and_run(
            normalized_trigger(), MODEL, BUDGET
        )
        await repository.start_run(created.run_id, FRESH_NOW)
        observed = await current_observation(CurrentAlertState.FIRING)
        assert observed.facts is not None
        references = [] if identity == "missing" else [observed.facts.target_ref]
        if identity == "conflicting":
            references.append(
                observed.facts.target_ref.model_copy(update={"uid": "old-target"})
            )
        for index, reference in enumerate(references):
            call = f"workload-{index}"
            await repository.record_tool_started(created.run_id, call, "get_workload")
            await repository.record_evidence(
                EvidenceRecord(
                    run_id=created.run_id,
                    tool_call_id=call,
                    tool_name="get_workload",
                    evidence_kind="workload",
                    target_ref=reference.model_dump(mode="json"),
                    observed_at=FRESH_NOW,
                    payload={},
                    truncated=False,
                    redacted=False,
                )
            )
        await repository.save_current_alert_observation(observed)
        service = query_service(repository, clock)
        for offset, reason in [
            (0, None),
            (61, ObservationReason.STALE),
            (-1, ObservationReason.CLOCK_INVALID),
        ]:
            clock[0] = FRESH_NOW + timedelta(seconds=offset)
            page = await service.list_incidents(limit=20, cursor=None)
            detail = await service.get_incident(created.incident_id, run_id=None)
            assert page.items[0].alert_summary == detail.alert_summary
            assert page.items[0].alert_summary.reason == (
                reason
                if identity == "matching"
                else ObservationReason.IDENTITY_UNVERIFIED
            )
            assert page.items[0].alert_ids == (IMAGE,)
            assert page.items[0].latest_run is not None
            assert page.items[0].latest_run.attempt == 1
            state = (
                CurrentAlertState.FIRING
                if identity == "matching" and offset == 0
                else CurrentAlertState.UNKNOWN
            )
            filtered = await service.list_incidents(
                limit=20, cursor=None, alert_state=state
            )
            assert [item.id for item in filtered.items] == [created.incident_id]


async def test_closed_runless_incident_keeps_firing_notification_history_separate_from_current_clear(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        incident_id = await open_episode(repository)
        await advance_window(repository, clock, ticks=11)
        service = query_service(repository, clock)
        async with _client(tmp_path, service) as client:
            detail = (await client.get(f"/api/v1/incidents/{incident_id}")).json()
            assert detail["incident"]["lifecycleStatus"] == "CLOSED"
            assert detail["closure"] == {
                "basis": "observed_stable",
                "closedAt": detail["incident"]["updatedAt"],
            }
            assert (
                detail["selectedRun"] is None
                and detail["alertSummary"]["state"] == "CLEAR"
            )
            history = (
                await client.get(f"/api/v1/incidents/{incident_id}/alerts")
            ).json()
            assert len(history["items"]) == 1
            assert history["items"][0]["status"] == "FIRING"
            assert history["items"][0]["endsAt"] is None
            assert history["items"][0]["firstReceivedAt"] is not None
            assert history["nextCursor"] is None
            closed = (
                await client.get(
                    "/api/v1/incidents",
                    params={"lifecycleStatus": "CLOSED", "alertState": "CLEAR"},
                )
            ).json()
            assert [item["id"] for item in closed["items"]] == [str(incident_id)]


async def test_occurrence_history_paginates_stable_keys_and_keeps_legacy_null_receipts(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        async with database.session_factory() as session, session.begin():
            row = _incident(
                source_ref=IMAGE, status=IncidentStatus.RECEIVED, created_at=FRESH_NOW
            )
            session.add(row)
            await session.flush()
            for index in range(25):
                signal = _signal(
                    row, status=AlertSignalStatus.FIRING, starts_at=FRESH_NOW
                )
                signal.fingerprint = f"{index:016x}"
                session.add(signal)
        service = query_service(repository, [FRESH_NOW])
        async with _client(tmp_path, service) as client:
            first = (await client.get(f"/api/v1/incidents/{row.id}/alerts")).json()
            assert len(first["items"]) == 20
            assert first["items"][0]["fingerprint"] == f"{24:016x}"
            assert all(
                item["firstReceivedAt"] is None and item["lastReceivedAt"] is None
                for item in first["items"]
            )
            cursor = first["nextCursor"]
            second = (
                await client.get(
                    f"/api/v1/incidents/{row.id}/alerts", params={"cursor": cursor}
                )
            ).json()
            assert len(second["items"]) == 5 and second["nextCursor"] is None
            other = "11111111-1111-4111-8111-111111111111"
            rejected = await client.get(
                f"/api/v1/incidents/{other}/alerts", params={"cursor": cursor}
            )
            assert (
                rejected.status_code == 400
                and rejected.json()["error"]["code"] == "invalid_cursor"
            )
            legacy = (
                await client.get(
                    "/api/v1/incidents", params={"lifecycleStatus": "UNDETERMINED"}
                )
            ).json()
            assert [item["id"] for item in legacy["items"]] == [row.id]


async def test_current_activity_lists_unique_targets_without_inventing_webhook_identity(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        observed = await current_observation(CurrentAlertState.PENDING)
        assert observed.facts is not None
        for index in range(24):
            target = TARGET.model_copy(update={"name": f"source-target-{index:02d}"})
            async with database.session_factory() as session, session.begin():
                row = _incident(
                    source_ref="image-pull-backoff",
                    source_type="scenario",
                    status=IncidentStatus.RECEIVED,
                    created_at=FRESH_NOW,
                )
                row.resource_name = target.name
                session.add(row)
            await repository.save_current_alert_observation(
                observed.model_copy(
                    update={
                        "target": target,
                        "facts": observed.facts.model_copy(
                            update={
                                "target_ref": observed.facts.target_ref.model_copy(
                                    update={"name": target.name}
                                )
                            }
                        ),
                    }
                )
            )
        overview = await repository.get_current_alert_overview(FRESH_NOW)
        assert overview.total_targets == 24 and overview.pending_rules == 24
        assert len(overview.activities) == 20
        assert {activity.target.name for activity in overview.activities} == {
            f"source-target-{index:02d}" for index in range(20)
        }
        assert all(
            activity.observed_at == FRESH_NOW
            and activity.rules[0].state is CurrentAlertState.PENDING
            for activity in overview.activities
        )
        stale = await repository.get_current_alert_overview(
            FRESH_NOW + timedelta(seconds=61)
        )
        assert stale.activities == () and stale.unknown_targets == 24
