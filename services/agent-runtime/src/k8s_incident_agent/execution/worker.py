from __future__ import annotations

import argparse
import asyncio
import hashlib
import signal
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import cast

import httpx

from k8s_incident_agent.config import ExecutorSettings
from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.execution.client import ExecutionClient, ExecutionExchangeError
from k8s_incident_agent.execution.contracts import (
    ExecutionCommand,
    ExecutionReport,
    ExecutionResult,
)
from k8s_incident_agent.execution.kubernetes import (
    ExecutorKubernetes,
    create_executor_kubernetes,
)
from k8s_incident_agent.internal_auth import load_hmac_key
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import RepairProposal


class ExecutionCommandInvalid(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Execution authorization is invalid")


class _ExecutionStartExpired(ExecutionCommandInvalid):
    pass


def validate_execution_command(
    command: ExecutionCommand,
    *,
    cluster_id: str,
    now: datetime,
) -> RepairProposal:
    approval, change, validation = command.approval, command.change, command.validation
    proposal = compile_repair_proposal(
        change,
        schema_checked_at=validation.checked_at,
        policy_checked_at=validation.checked_at,
        diff_checked_at=validation.checked_at,
    )
    validation_json = canonical_json(
        cast(dict[str, JsonValue], validation.model_dump(mode="json"))
    )
    validation_digest = "sha256:" + hashlib.sha256(validation_json.encode()).hexdigest()
    if (
        cluster_id != "k8s-incident-agent"
        or change.target.cluster != cluster_id
        or change.target.namespace != "k8s-incident-scenarios"
        or approval.decision != "approve"
        or approval.run_id != change.run_id
        or approval.proposal_id != proposal.id
        or approval.proposal_digest != proposal.digest
        or validation.proposal_id != proposal.id
        or validation.run_id != change.run_id
        or validation.proposal_digest != proposal.digest
        or validation.outcome != "passed"
        or approval.validation_digest != validation_digest
        or approval.expires_at != validation.checked_at + timedelta(minutes=15)
        or not validation.checked_at <= approval.decided_at <= now
        or command.start_before
        != min(approval.decided_at + timedelta(seconds=30), approval.expires_at)
    ):
        raise ExecutionCommandInvalid
    if now >= command.start_before:
        raise _ExecutionStartExpired
    return proposal


class ExecutionWorker:
    def __init__(
        self,
        *,
        client: ExecutionClient,
        kubernetes: ExecutorKubernetes,
        cluster_id: str,
        now: Callable[[], datetime],
    ) -> None:
        self._client, self._kubernetes = client, kubernetes
        self._cluster_id, self._now = cluster_id, now
        self._pending_report: ExecutionReport | None = None

    async def step(self) -> None:
        if self._pending_report is None:
            command = await self._client.claim()
            if command is None:
                return
            try:
                proposal = validate_execution_command(
                    command, cluster_id=self._cluster_id, now=self._now()
                )
            except _ExecutionStartExpired:
                result = ExecutionResult(
                    outcome="REJECTED", error="precondition_failed"
                )
            else:
                result = await self._kubernetes.apply(
                    proposal,
                    start_before=command.start_before,
                    now=self._now,
                )
            self._pending_report = ExecutionReport(
                execution_id=command.execution_id, result=result
            )
        # A failed report retains only this result; it must never re-enter apply.
        await self._client.report(self._pending_report)
        self._pending_report = None

    async def run(self) -> None:
        while True:
            try:
                await self.step()
            except ExecutionExchangeError as error:
                if not error.retryable:
                    raise
            await asyncio.sleep(2)


async def run_executor(settings: ExecutorSettings) -> None:
    key = load_hmac_key(settings.executor_hmac_key_file)
    kubernetes = await create_executor_kubernetes()
    try:
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False) as http:

            def now() -> datetime:
                return datetime.now(UTC)

            worker = ExecutionWorker(
                client=ExecutionClient(http=http, key=key, now=now),
                kubernetes=kubernetes,
                cluster_id=settings.kubernetes_cluster_id,
                now=now,
            )
            task = asyncio.current_task()
            assert task is not None
            loop = asyncio.get_running_loop()
            loop.add_signal_handler(signal.SIGTERM, task.cancel)
            try:
                await worker.run()
            finally:
                loop.remove_signal_handler(signal.SIGTERM)
    finally:
        await kubernetes.close()


def main() -> None:
    argparse.ArgumentParser(
        description="Run the isolated fixed-sandbox Executor worker"
    ).parse_args()
    try:
        asyncio.run(run_executor(ExecutorSettings()))
    except (KeyboardInterrupt, asyncio.CancelledError):
        return
    except Exception:
        raise SystemExit(
            "Executor stopped: configuration or execution boundary failed"
        ) from None


if __name__ == "__main__":
    main()
