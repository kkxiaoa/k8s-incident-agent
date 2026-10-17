from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select
from tests.factories import normalized_trigger
from tests.unit.monitoring.test_reconciliation import CurrentTargetFixture
from tests.unit.persistence.test_monitoring_overview import (
    _incident,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET

from k8s_incident_agent.domain.models import EvidenceRecord, IncidentStatus
from k8s_incident_agent.monitoring.contracts import (
    CurrentAlertObservation,
    CurrentAlertState,
    CurrentAlertSummary,
    ObservationReason,
    RuleAlertObservation,
)
from k8s_incident_agent.persistence.models import (
    CurrentAlertObservationRow,
    IncidentRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import IncidentRepository


async def current_observation(
    state: CurrentAlertState = CurrentAlertState.CLEAR,
) -> CurrentAlertObservation:
    return CurrentAlertObservation(
        target=TARGET,
        catalog_version="2026-09-03.4",
        facts=await CurrentTargetFixture().adapter().read_current_target(TARGET),
        summary=CurrentAlertSummary(
            state=state,
            complete=True,
            observed_at=FRESH_NOW,
            received_at=FRESH_NOW,
            target_healthy=True,
            reason=None,
            rules=(
                RuleAlertObservation(
                    alert_id="K8sIncidentImagePullBackOff",
                    state=state,
                    complete=True,
                    reason=None,
                    evaluated_at=FRESH_NOW,
                ),
            ),
        ),
    )


async def test_targets_deduplicate_525_historical_incidents_and_advance_fair_order_after_failure(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        async with database.session_factory() as session, session.begin():
            for index in range(525):
                incident = _incident(
                    source_ref="K8sIncidentImagePullBackOff",
                    status=IncidentStatus.DIAGNOSED,
                    created_at=FRESH_NOW,
                )
                incident.resource_name = (
                    "shared-target" if index < 513 else f"target-{index}"
                )
                session.add(incident)
        async with database.session_factory() as session:
            before = (
                await session.execute(
                    select(
                        IncidentRow.id, IncidentRow.updated_at, IncidentRow.status
                    ).order_by(IncidentRow.id)
                )
            ).all()
        seen: set[str] = set()
        last_batch_names: set[str] = set()
        for _ in range(2):
            batch = await repository.reconciliation_targets()
            assert len(batch) == 8
            assert len({target.name for target in batch}) == 8
            seen.update(target.name for target in batch)
            last_batch_names = {target.name for target in batch[-5:]}
            for target in batch:
                await repository.save_current_alert_observation(
                    CurrentAlertObservation(
                        target=target,
                        catalog_version="2026-09-03.4",
                        facts=None,
                        summary=CurrentAlertSummary(
                            observed_at=FRESH_NOW,
                            received_at=FRESH_NOW,
                            reason=ObservationReason.UNAVAILABLE,
                        ),
                    )
                )
        assert len(seen) == 13
        async with database.session_factory() as session:
            assert (
                await session.scalar(
                    select(func.count()).select_from(CurrentAlertObservationRow)
                )
                == 13
            )
            assert await session.scalar(select(func.count()).select_from(RunRow)) == 0
            assert (
                await session.execute(
                    select(
                        IncidentRow.id, IncidentRow.updated_at, IncidentRow.status
                    ).order_by(IncidentRow.id)
                )
            ).all() == before
        restarted = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        assert (await restarted.reconciliation_targets())[
            0
        ].name not in last_batch_names
        overview = await repository.get_current_alert_overview(FRESH_NOW)
        assert overview.total_targets == overview.unknown_targets == 13


@pytest.mark.parametrize(
    "identity", ["matching", "missing", "different", "conflicting"]
)
async def test_current_detail_requires_existing_evidence_uid_and_never_mutates_business_time(
    tmp_path: Path, identity: str
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        created = await repository.create_incident_and_run(
            normalized_trigger(), MODEL, BUDGET
        )
        await repository.start_run(created.run_id, FRESH_NOW)
        observation = await current_observation(CurrentAlertState.FIRING)
        assert observation.facts is not None
        references = [] if identity == "missing" else [observation.facts.target_ref]
        if identity in ("different", "conflicting"):
            other = observation.facts.target_ref.model_copy(
                update={"uid": "previous-deployment-uid"}
            )
            references = [other] if identity == "different" else [*references, other]
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
        before = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        await repository.save_current_alert_observation(observation)
        detail = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        assert before is not None and detail is not None
        assert detail.incident.updated_at == before.incident.updated_at
        assert detail.alert_summary.state is (
            CurrentAlertState.FIRING
            if identity == "matching"
            else CurrentAlertState.UNKNOWN
        )
        assert detail.alert_summary.reason is (
            None if identity == "matching" else ObservationReason.IDENTITY_UNVERIFIED
        )
        overview = await repository.get_current_alert_overview(FRESH_NOW)
        assert overview.total_targets == 1 and overview.firing_rules == 1


async def test_latest_observation_retains_bounded_last_known_but_stale_and_future_are_unknown(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.create_incident_and_run(normalized_trigger(), MODEL, BUDGET)
        observation = await current_observation(CurrentAlertState.FIRING)
        await repository.save_current_alert_observation(observation)
        unknown = observation.model_copy(
            update={
                "facts": None,
                "summary": CurrentAlertSummary(
                    observed_at=FRESH_NOW + timedelta(seconds=30),
                    received_at=FRESH_NOW + timedelta(seconds=30),
                    reason=ObservationReason.UNAVAILABLE,
                ),
            }
        )
        await repository.save_current_alert_observation(unknown)
        latest = await repository.get_current_alert_observation(TARGET)
        assert latest is not None
        assert latest.summary.state is CurrentAlertState.UNKNOWN
        assert latest.summary.last_known_state is CurrentAlertState.FIRING
        assert latest.summary.last_known_at == FRESH_NOW
        assert latest.facts == observation.facts
        async with database.session_factory() as session:
            assert (
                await session.scalar(
                    select(func.count()).select_from(CurrentAlertObservationRow)
                )
                == 1
            )
        await repository.save_current_alert_observation(observation)
        for at in (FRESH_NOW - timedelta(seconds=1), FRESH_NOW + timedelta(seconds=61)):
            overview = await repository.get_current_alert_overview(at)
            assert overview.unknown_targets == 1
            assert overview.firing_rules == overview.pending_rules == 0
        partial = observation.model_copy(
            update={
                "summary": observation.summary.model_copy(
                    update={
                        "state": CurrentAlertState.UNKNOWN,
                        "complete": False,
                        "reason": ObservationReason.STALE,
                    }
                )
            }
        )
        await repository.save_current_alert_observation(partial)
        overview = await repository.get_current_alert_overview(FRESH_NOW)
        assert overview.unknown_targets == 1 and overview.firing_rules == 1
        assert partial.facts is not None
        recreated = partial.model_copy(
            update={
                "facts": partial.facts.model_copy(
                    update={
                        "target_ref": partial.facts.target_ref.model_copy(
                            update={"uid": "new-deployment-uid"}
                        )
                    }
                )
            }
        )
        await repository.save_current_alert_observation(recreated)
        latest = await repository.get_current_alert_observation(TARGET)
        assert latest is not None and latest.summary.last_known_state is None
