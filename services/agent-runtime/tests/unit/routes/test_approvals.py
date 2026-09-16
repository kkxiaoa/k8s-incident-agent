from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from sqlalchemy import event, func, select, update
from sqlalchemy.exc import OperationalError
from tests.factories import diagnostic_model_stub, monitoring_health_service_stub
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import (
    FRESH_NOW,
    KubernetesFixture,
    create_preparation,
    seed_source,
)
from tests.unit.repair.test_repair_preparation import (
    credential as diagnostic_credential,
)
from tests.unit.routes.test_operator import credential as credential
from tests.unit.workflow.test_repair_preparation import dependencies

from k8s_incident_agent.api import RuntimeContainer, create_app
from k8s_incident_agent.application.events import (
    EventDependencies,
    IncidentEventService,
    RunEventNotifier,
)
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.auth.sessions import OperatorSessions
from k8s_incident_agent.auth.verifier import PasswordVerifier
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import (
    NormalizedAlertOccurrence,
    RepairWorkflowRunSnapshot,
)
from k8s_incident_agent.execution.api import ExecutionEndpoint
from k8s_incident_agent.execution.contracts import ExecutionReceipt, ExecutionResult
from k8s_incident_agent.internal_auth import NonceReplayCache
from k8s_incident_agent.persistence.database import BusinessDatabase
from k8s_incident_agent.persistence.models import (
    ApprovalRow,
    ExecutionRow,
    OperatorSessionRow,
    RepairProposalRow,
)
from k8s_incident_agent.persistence.repositories import (
    ExecutionReportConflictError,
    IncidentRepository,
)
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.runtime.retention import confirm_prune
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import build_incident_graph

ORIGIN = "https://console.example.test"


class MissedNotification:
    async def schedule(self, run_id: UUID) -> None:
        raise RuntimeError("Notification delivery interrupted")


@dataclass
class ApprovalHarness:
    repository: IncidentRepository
    database: BusinessDatabase
    saver: AsyncSqliteSaver
    app: FastAPI
    client: httpx.AsyncClient
    sessions: OperatorSessions
    clock: list[datetime]
    headers: dict[str, str]
    incident_id: UUID
    run_id: UUID
    body: dict[str, str]

    @property
    def path(self) -> str:
        return f"/api/v1/incidents/{self.incident_id}/approvals"

    def now(self) -> datetime:
        return self.clock[0]

    async def approve(self) -> dict[str, object]:
        response = await self.client.post(
            self.path, json=self.body, headers=self.headers
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def another_proposal(self) -> tuple[UUID, dict[str, str]]:
        incident_id, source_id = await seed_source(self.repository)
        run = await create_preparation(self.repository, incident_id, source_id)
        graph = build_incident_graph(
            dependencies(self.repository, self.saver, KubernetesFixture(), self.now),
            run,
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            {"configurable": {"thread_id": str(run.id)}},
            durability="sync",
        )
        detail = await self.repository.get_incident_detail(
            incident_id, run_id=run.id, event_limit=100
        )
        assert detail is not None and detail.repair is not None
        return incident_id, {
            "runId": str(run.id),
            "proposalId": str(detail.repair.proposal.id),
            "proposalDigest": detail.repair.proposal.digest,
            "decision": "approve",
        }


@asynccontextmanager
async def approval_harness(
    tmp_path: Path,
    credential: tuple[str, str],
    *,
    enabled: bool = True,
    executor_key: bytes | None = None,
    occurrence: NormalizedAlertOccurrence | None = None,
    public_demo: bool = False,
) -> AsyncGenerator[ApprovalHarness]:
    password, encoded = credential
    clock = [FRESH_NOW]
    async with (
        _database(tmp_path) as database,
        open_checkpoint_store(
            RuntimePaths.prepare(tmp_path / "runtime").checkpoint_database
        ) as saver,
    ):
        repository = IncidentRepository(
            database.session_factory,
            sandbox_execution_enabled=enabled,
            execution_cluster="k8s-incident-agent",
            now=lambda: clock[0],
        )
        incident_id, source_id = await seed_source(repository, occurrence)
        run = await create_preparation(repository, incident_id, source_id)
        graph = build_incident_graph(
            dependencies(repository, saver, KubernetesFixture(), lambda: clock[0]), run
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            {"configurable": {"thread_id": str(run.id)}},
            durability="sync",
        )
        detail = await repository.get_incident_detail(
            incident_id, run_id=run.id, event_limit=100
        )
        assert detail is not None and detail.repair is not None
        service = IncidentApplicationService(
            catalog=(),
            repository=repository,
            supervisor=MissedNotification(),
            credential=diagnostic_credential(),
            model=lambda: None,
            budget=BUDGET,
            now=lambda: clock[0],
        )
        sessions = OperatorSessions(
            sessions=database.session_factory,
            verifier=PasswordVerifier(encoded),
            origin=ORIGIN,
            now=lambda: clock[0].timestamp(),
            access_mode="public_demo" if public_demo else "private",
        )
        await sessions.start()

        @asynccontextmanager
        async def context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
            yield RuntimeContainer(
                incidents=service,
                events=IncidentEventService(
                    EventDependencies(
                        repository=repository, notifier=RunEventNotifier()
                    )
                ),
                alerts=None,
                monitoring=monitoring_health_service_stub(),
                diagnostic_model=diagnostic_model_stub(),
                operator=sessions,
                execution=(
                    ExecutionEndpoint(
                        repository,
                        executor_key,
                        NonceReplayCache(freshness_seconds=30),
                        lambda: clock[0],
                    )
                    if executor_key is not None
                    else None
                ),
            )

        settings = Settings(
            RUNTIME_DATA_DIR=RuntimePaths.prepare(tmp_path / "api"),  # pyright: ignore[reportCallIssue]
            sandbox_execution_enabled=enabled,
            console_access_mode="public_demo" if public_demo else "private",
            public_demo_data_approved=public_demo,
            executor_hmac_key_file=(
                tmp_path / "executor-key" if executor_key is not None else None
            ),
            _env_file=None,  # pyright: ignore[reportCallIssue]
        )
        app = create_app(settings=settings, runtime_context_factory=context)
        try:
            async with (
                app.router.lifespan_context(app),
                httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                    base_url=ORIGIN,
                ) as client,
            ):
                login = await client.post(
                    "/api/v1/operator/login",
                    json={"password": password},
                    headers={"Origin": ORIGIN},
                )
                assert login.status_code == 200
                yield ApprovalHarness(
                    repository,
                    database,
                    saver,
                    app,
                    client,
                    sessions,
                    clock,
                    {"Origin": ORIGIN, "X-CSRF-Token": login.json()["csrfToken"]},
                    incident_id,
                    run.id,
                    {
                        "runId": str(run.id),
                        "proposalId": str(detail.repair.proposal.id),
                        "proposalDigest": detail.repair.proposal.digest,
                        "decision": "approve",
                    },
                )
        finally:
            await sessions.close()


async def applied_result(harness: ApprovalHarness) -> ExecutionResult:
    command = await harness.repository.claim_execution(now=harness.now)
    assert command is not None
    return ExecutionResult(
        outcome="APPLIED",
        receipt=ExecutionReceipt(
            uid=command.change.target_uid,
            resource_version="patched-rv",
            generation=4,
            before_generation=3,
        ),
    )


async def test_operator_exact_decision_is_atomic_idempotent_and_model_independent(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        extras: tuple[dict[str, object], ...] = (
            {"actor": "forged"},
            {"patch": []},
            {"expiresAt": "2099-01-01"},
        )
        for extra in extras:
            assert (
                await harness.client.post(
                    harness.path,
                    json={**harness.body, **extra},
                    headers=harness.headers,
                )
            ).status_code == 422
        assert (
            await harness.client.post(harness.path, json=harness.body)
        ).status_code == 403
        for change in (
            {"proposalDigest": "sha256:" + "0" * 64},
            {"runId": str(uuid4())},
            {"proposalId": str(uuid4())},
        ):
            assert (
                await harness.client.post(
                    harness.path,
                    json={**harness.body, **change},
                    headers=harness.headers,
                )
            ).status_code == 409
        first = await harness.approve()
        harness.clock[0] += timedelta(seconds=1)
        assert await harness.approve() == first
        assert (
            await harness.client.post(
                harness.path,
                json={**harness.body, "decision": "reject"},
                headers=harness.headers,
            )
        ).status_code == 409
        async with harness.database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(ApprovalRow)) == 1
            )
            assert (
                await session.scalar(select(func.count()).select_from(ExecutionRow))
                == 1
            )
        response = await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        assert response.status_code == 200, response.text
        detail = response.json()
        assert detail["incident"]["status"] == "APPLYING"
        assert detail["selectedRun"]["status"] == "RUNNING"
        assert detail["approval"] == first
        assert first["actor"] == "sandbox-operator"
        assert (
            await harness.client.post(
                f"/api/v1/incidents/{harness.incident_id}/repair-runs",
                json={"sourceRunId": str(harness.run_id)},
                headers=harness.headers,
            )
        ).status_code == 409


@pytest.mark.parametrize("decision", ["approve", "reject"])
async def test_disabled_endpoint_is_not_registered(
    tmp_path: Path, credential: tuple[str, str], decision: str
) -> None:
    async with approval_harness(tmp_path, credential, enabled=False) as harness:
        assert (
            await harness.client.post(
                harness.path,
                json={**harness.body, "decision": decision},
                headers=harness.headers,
            )
        ).status_code == 404
        assert await harness.repository.claim_execution(now=harness.now) is None
        assert (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).status_code == 200


async def test_rejection_is_a_completed_decision_without_execution(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        harness.body["decision"] = "reject"
        first = await harness.approve()
        assert first["execution"] is None
        assert await harness.approve() == first
        assert await harness.repository.claim_execution(now=harness.now) is None
        detail = (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).json()
        assert detail["incident"]["status"] == "REJECTED"
        assert detail["selectedRun"]["status"] == "COMPLETED"
        assert detail["selectedRun"]["endReason"] == "rejected"


async def test_claim_only_once_and_trusted_receipt_only_enters_verifying(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        claims = await asyncio.gather(
            *(harness.repository.claim_execution(now=harness.now) for _ in range(2))
        )
        command = next(value for value in claims if value is not None)
        assert sum(value is not None for value in claims) == 1
        result = ExecutionResult(
            outcome="APPLIED",
            receipt=ExecutionReceipt(
                uid=command.change.target_uid,
                resource_version="patched-rv",
                generation=4,
                before_generation=3,
            ),
        )
        first = await harness.repository.report_execution(
            command.execution_id, result, now=harness.now
        )
        assert first == await harness.repository.report_execution(
            command.execution_id, result, now=harness.now
        )
        with pytest.raises(ExecutionReportConflictError):
            await harness.repository.report_execution(
                command.execution_id,
                ExecutionResult(outcome="UNKNOWN", error="outcome_unknown"),
                now=harness.now,
            )
        detail = (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).json()
        assert detail["incident"]["status"] == "VERIFYING"
        assert detail["selectedRun"]["status"] == "RUNNING"
        assert detail["approval"]["execution"]["status"] == "APPLIED"


async def test_claim_loss_unknown_remains_occupied_after_late_success(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        snapshot = await harness.repository.get_workflow_run_snapshot(harness.run_id)
        assert (
            isinstance(snapshot, RepairWorkflowRunSnapshot)
            and snapshot.execution is not None
        )
        harness.clock[0] += timedelta(seconds=41)
        await harness.repository.reconcile_executions(harness.now())
        assert await harness.repository.claim_execution(now=harness.now) is None
        late = await harness.repository.report_execution(
            snapshot.execution.id, result, now=harness.now
        )
        assert late.status == "UNKNOWN" and late.late_result == result
        assert late == await harness.repository.report_execution(
            snapshot.execution.id, result, now=harness.now
        )
        assert (
            await harness.repository.list_prune_targets(
                FRESH_NOW + timedelta(days=8), tmp_path / "artifacts"
            )
            == ()
        )
        detail = (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).json()
        assert detail["incident"]["status"] == "FAILED"
        assert detail["approval"]["execution"]["status"] == "UNKNOWN"
        assert detail["selectedRun"]["error"]["retryable"] is False
        assert detail["actions"]["rerun"] == "execution_held"
        assert detail["actions"]["refresh"] is not None
        assert detail["actions"]["edit"] is not None
        assert detail["actions"]["rollback"] is not None
        source = snapshot.source_run_id
        history = (
            await harness.client.get(
                f"/api/v1/incidents/{harness.incident_id}?runId={source}"
            )
        ).json()
        assert (
            history["approval"] is None
            and history["actions"]["rerun"] == "execution_held"
        )
        paths = RuntimePaths.prepare(tmp_path / "runtime")
        artifact = paths.run_artifact_directory(harness.run_id)
        paths.run_artifacts.mkdir(mode=0o700)
        artifact.mkdir(mode=0o700)
        (artifact / "trace.json").write_text("{}")
        settings = Settings(RUNTIME_DATA_DIR=paths, _env_file=None)  # pyright: ignore[reportCallIssue]
        assert (
            await confirm_prune(settings, FRESH_NOW + timedelta(days=8))
        ).deleted_targets == ()
        assert (artifact / "trace.json").read_text() == "{}"
        assert (
            await harness.saver.aget_tuple(
                {"configurable": {"thread_id": str(harness.run_id)}}
            )
            is not None
        )


async def test_unclaimed_expiry_releases_target_and_expired_wait_cannot_authorize(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        harness.clock[0] += timedelta(seconds=30)
        assert await harness.repository.claim_execution(now=harness.now) is None
        detail = (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).json()
        assert detail["approval"]["execution"]["status"] == "EXPIRED"
        assert detail["selectedRun"]["endReason"] == "execution_expired"
        targets = await harness.repository.list_prune_targets(
            FRESH_NOW + timedelta(days=8), tmp_path / "artifacts"
        )
        assert len(targets) == 1
        assert targets[0].approval_rows == targets[0].execution_rows == 1
        assert await harness.repository.delete_prune_target(
            targets[0], FRESH_NOW + timedelta(days=8), tmp_path / "artifacts"
        )


async def test_revoked_session_cannot_commit_a_decision(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        principal = await harness.sessions.authenticate(
            [
                harness.client.headers.get("cookie", "")
                or f"__Host-k8s-incident-session={harness.client.cookies.get('__Host-k8s-incident-session')}"
            ]
        )
        async with harness.database.session_factory.begin() as session:
            await session.execute(update(OperatorSessionRow).values(revoked=True))
        from k8s_incident_agent.auth.sessions import OperatorAuthenticationError

        with pytest.raises(OperatorAuthenticationError):
            await harness.repository.decide_approval(
                harness.incident_id,
                harness.run_id,
                UUID(harness.body["proposalId"]),
                harness.body["proposalDigest"],
                "approve",
                operator_ref=principal.operator_ref,
                operator_token_hash=principal.token_hash,
                now=harness.now,
            )
        assert await harness.repository.claim_execution(now=harness.now) is None


async def test_unauthenticated_expired_and_source_proposals_never_authorize(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=harness.app), base_url=ORIGIN
        ) as anonymous:
            assert (
                await anonymous.post(
                    harness.path, json=harness.body, headers=harness.headers
                )
            ).status_code == 401
        snapshot = await harness.repository.get_workflow_run_snapshot(harness.run_id)
        assert isinstance(snapshot, RepairWorkflowRunSnapshot)
        source = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=snapshot.source_run_id, event_limit=100
        )
        assert source is not None and source.repair is not None
        body = {
            **harness.body,
            "runId": str(snapshot.source_run_id),
            "proposalId": str(source.repair.proposal.id),
            "proposalDigest": source.repair.proposal.digest,
        }
        assert (
            await harness.client.post(harness.path, json=body, headers=harness.headers)
        ).status_code == 409
        harness.clock[0] += timedelta(minutes=15)
        assert (
            await harness.client.post(
                harness.path, json=harness.body, headers=harness.headers
            )
        ).status_code == 409
        assert await harness.repository.claim_execution(now=harness.now) is None


async def test_concurrent_target_decisions_and_readonly_preparation_are_separate(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        other_id, other_body = await harness.another_proposal()
        paths = (harness.path, f"/api/v1/incidents/{other_id}/approvals")
        responses = await asyncio.gather(
            *(
                harness.client.post(path, json=body, headers=harness.headers)
                for path, body in zip(paths, (harness.body, other_body), strict=True)
            )
        )
        assert sorted(response.status_code for response in responses) == [200, 409]
        async with harness.database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(ApprovalRow)) == 1
            )
            assert (
                await session.scalar(select(func.count()).select_from(ExecutionRow))
                == 1
            )
        # A separate Incident can still diagnose and prepare the occupied target.
        third_id, third_body = await harness.another_proposal()
        assert (
            await harness.client.get(f"/api/v1/incidents/{third_id}")
        ).status_code == 200
        assert (
            await harness.client.post(
                f"/api/v1/incidents/{third_id}/approvals",
                json=third_body,
                headers=harness.headers,
            )
        ).status_code == 409


async def test_transaction_failure_leaves_no_partial_authorization(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:

        def fail_audit(
            _connection: object,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _many: bool,
        ) -> None:
            if statement.startswith("INSERT INTO run_events"):
                raise OperationalError(
                    statement, None, RuntimeError("test audit failure")
                )

        event.listen(
            harness.database.engine.sync_engine, "before_cursor_execute", fail_audit
        )
        try:
            assert (
                await harness.client.post(
                    harness.path, json=harness.body, headers=harness.headers
                )
            ).status_code == 500
        finally:
            event.remove(
                harness.database.engine.sync_engine, "before_cursor_execute", fail_audit
            )
        assert await harness.repository.claim_execution(now=harness.now) is None
        async with harness.database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(ApprovalRow)) == 0
            )
            assert (
                await session.scalar(select(func.count()).select_from(ExecutionRow))
                == 0
            )
        assert (await harness.approve())["decision"] == "approve"


@pytest.mark.parametrize("opposite", [False, True])
async def test_competing_same_run_decisions_do_not_extend_authorization(
    tmp_path: Path, credential: tuple[str, str], opposite: bool
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        responses = await asyncio.gather(
            harness.client.post(
                harness.path, json=harness.body, headers=harness.headers
            ),
            harness.client.post(
                harness.path,
                json={**harness.body, "decision": "reject" if opposite else "approve"},
                headers=harness.headers,
            ),
        )
        assert sorted(response.status_code for response in responses) == (
            [200, 409] if opposite else [200, 200]
        )
        if not opposite:
            assert responses[0].json() == responses[1].json()


async def test_near_expiry_deadline_and_disabled_reconciliation_keep_original_grant(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        harness.clock[0] += timedelta(minutes=14, seconds=50)
        await harness.approve()
        command = await harness.repository.claim_execution(now=harness.now)
        assert command is not None and command.start_before == FRESH_NOW + timedelta(
            minutes=15
        )
        disabled = IncidentRepository(harness.database.session_factory)
        assert await disabled.claim_execution(now=harness.now) is None
        harness.clock[0] += timedelta(seconds=21)
        await disabled.reconcile_executions(harness.now())
        result = ExecutionResult(
            outcome="APPLIED",
            receipt=ExecutionReceipt(
                uid=command.change.target_uid,
                resource_version="late-rv",
                generation=4,
                before_generation=3,
            ),
        )
        assert (
            await disabled.report_execution(
                command.execution_id, result, now=harness.now
            )
        ).status == "UNKNOWN"


@pytest.mark.parametrize(
    "result",
    [
        ExecutionResult(outcome="REJECTED", error="permission_denied"),
        ExecutionResult(outcome="STALE_RESOURCE", error="precondition_failed"),
        ExecutionResult(outcome="UNKNOWN", error="outcome_unknown"),
    ],
)
async def test_typed_negative_reports_keep_failure_and_occupancy_semantics(
    tmp_path: Path, credential: tuple[str, str], result: ExecutionResult
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        command = await harness.repository.claim_execution(now=harness.now)
        assert command is not None
        record = await harness.repository.report_execution(
            command.execution_id, result, now=harness.now
        )
        assert record == await harness.repository.report_execution(
            command.execution_id, result, now=harness.now
        )
        assert record.status == result.outcome
        detail = (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).json()
        assert detail["selectedRun"]["status"] == "FAILED"
        assert (detail["actions"]["rerun"] == "execution_held") is (
            result.outcome == "UNKNOWN"
        )


async def test_cancelled_claim_delivery_cannot_reissue_the_committed_command(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()

        async def lost_delivery(_run_id: UUID) -> None:
            raise asyncio.CancelledError

        claimant = IncidentRepository(
            harness.database.session_factory,
            sandbox_execution_enabled=True,
            execution_cluster="k8s-incident-agent",
            on_event_committed=lost_delivery,
        )
        with pytest.raises(asyncio.CancelledError):
            await claimant.claim_execution(now=harness.now)
        assert await harness.repository.claim_execution(now=harness.now) is None
        harness.clock[0] += timedelta(seconds=41)
        await harness.repository.reconcile_executions(harness.now())
        detail = (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).json()
        assert detail["approval"]["execution"]["status"] == "UNKNOWN"


async def test_changed_validation_cannot_be_claimed_under_an_old_approval(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        async with harness.database.session_factory.begin() as session:
            row = await session.scalar(
                select(RepairProposalRow).where(
                    RepairProposalRow.run_id == str(harness.run_id)
                )
            )
            assert row is not None
            row.validation_json = row.validation_json.replace('"passed"', '"failed"')
        from k8s_incident_agent.persistence.repositories import RecoveryConsistencyError

        with pytest.raises(RecoveryConsistencyError):
            await harness.repository.claim_execution(now=harness.now)
        async with harness.database.session_factory() as session:
            execution = await session.scalar(select(ExecutionRow))
            assert (
                execution is not None
                and execution.status == "PENDING"
                and execution.claimed_at is None
            )
