from __future__ import annotations

import json
import secrets
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    Configuration,
)

from k8s_incident_agent.execution.auth import CLAIM_CHANNEL
from k8s_incident_agent.execution.client import ExecutionClient, ExecutionExchangeError
from k8s_incident_agent.execution.contracts import ExecutionCommand
from k8s_incident_agent.execution.kubernetes import ExecutorKubernetes
from k8s_incident_agent.execution.worker import (
    ExecutionCommandInvalid,
    ExecutionWorker,
    validate_execution_command,
)
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.repair.contracts import RepairProposal
from tests.unit.routes.test_approvals import ApprovalHarness, approval_harness
from tests.unit.routes.test_operator import credential as credential


class RawResponse:
    def __init__(self, document: object, status: int = 200) -> None:
        self.status = status
        self.headers = {"Content-Type": "application/json"}
        self.raw = json.dumps(document).encode()
        self.content = self
        self.released = False

    async def iter_chunked(self, size: int) -> AsyncIterator[bytes]:
        yield self.raw

    def release(self) -> None:
        self.released = True


def deployment(proposal: RepairProposal, *, patched: bool = False) -> dict[str, Any]:
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": proposal.target.name,
            "namespace": proposal.target.namespace,
            "uid": proposal.target_uid,
            "resourceVersion": "opaque:patched"
            if patched
            else proposal.target_resource_version,
            "generation": 4 if patched else 3,
        },
        "spec": {
            "template": {
                "spec": {
                    "containers": [
                        {
                            "name": proposal.container_name,
                            "image": proposal.replacement_image
                            if patched
                            else proposal.current_image,
                        },
                    ]
                }
            }
        },
    }


class KubernetesTransport:
    """Only replaces network I/O; the real locked AppsV1Api/REST serializer runs."""

    def __init__(self, before: object, after: object) -> None:
        self.before, self.after = before, after
        self.calls: list[dict[str, Any]] = []

    async def request(self, **kwargs: Any) -> object:
        self.calls.append(kwargs)
        response = self.before if kwargs["method"] == "GET" else self.after
        if isinstance(response, BaseException):
            raise response
        return response

    async def close(self) -> None:
        pass


@asynccontextmanager
async def adapter(transport: KubernetesTransport) -> AsyncGenerator[ExecutorKubernetes]:
    configuration = Configuration()
    configuration.host = "https://kubernetes.invalid"
    api = ApiClient(configuration)
    await api.rest_client.pool_manager.close()
    cast(Any, api.rest_client).pool_manager = transport
    try:
        yield ExecutorKubernetes(AppsV1Api(api))
    finally:
        await api.close()


async def proposal_for(harness: ApprovalHarness) -> RepairProposal:
    detail = await harness.repository.get_incident_detail(
        harness.incident_id, run_id=harness.run_id, event_limit=100
    )
    assert detail is not None and detail.repair is not None
    return detail.repair.proposal


async def execution_for(harness: ApprovalHarness):
    detail = await harness.repository.get_incident_detail(
        harness.incident_id, run_id=harness.run_id, event_limit=100
    )
    assert (
        detail is not None
        and detail.repair is not None
        and detail.repair.execution is not None
    )
    return detail.repair.execution


@pytest.mark.asyncio
async def test_real_approval_worker_signed_exchange_and_exact_single_patch(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    key = secrets.token_bytes(32)
    async with approval_harness(tmp_path, credential, executor_key=key) as harness:
        proposal = await proposal_for(harness)
        before, after = (
            RawResponse(deployment(proposal)),
            RawResponse(deployment(proposal, patched=True)),
        )
        transport = KubernetesTransport(before, after)
        async with (
            adapter(transport) as kubernetes,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=harness.app)) as http,
        ):
            client = ExecutionClient(http=http, key=key, now=harness.now)
            worker = ExecutionWorker(
                client=client,
                kubernetes=kubernetes,
                cluster_id="k8s-incident-agent",
                now=harness.now,
            )
            await worker.step()
            assert transport.calls == []  # No operator approval, no command or GET.
            await harness.approve()
            await worker.step()
            await worker.step()
            assert [call["method"] for call in transport.calls] == ["GET", "PATCH"]
            patch = transport.calls[1]
            assert (
                patch["url"]
                == f"https://kubernetes.invalid/apis/apps/v1/namespaces/k8s-incident-scenarios/deployments/{proposal.target.name}"
            )
            assert patch["headers"]["Content-Type"] == "application/json-patch+json"
            assert json.loads(patch["data"]) == [
                operation.model_dump() for operation in proposal.patch
            ]
            assert before.released and after.released
            execution = await execution_for(harness)
            assert execution.status == "APPLIED" and execution.result is not None
            assert execution.result.receipt is not None
            assert execution.result.receipt.model_dump() == {
                "uid": proposal.target_uid,
                "resource_version": "opaque:patched",
                "generation": 4,
                "before_generation": 3,
            }
            snapshot = await harness.repository.get_workflow_run_snapshot(
                harness.run_id
            )
            assert snapshot is not None and snapshot.run_status.value == "RUNNING"


@pytest.mark.asyncio
@pytest.mark.parametrize("lost", ["claim", "report"])
async def test_lost_runtime_receipt_never_repeats_patch(
    tmp_path: Path, credential: tuple[str, str], lost: str
) -> None:
    key = secrets.token_bytes(32)
    async with approval_harness(tmp_path, credential, executor_key=key) as harness:
        await harness.approve()
        proposal = await proposal_for(harness)
        transport = KubernetesTransport(
            RawResponse(deployment(proposal)),
            RawResponse(deployment(proposal, patched=True)),
        )
        underlying = httpx.ASGITransport(app=harness.app)
        dropped = False

        async def drop_once(request: httpx.Request) -> httpx.Response:
            nonlocal dropped
            response = await underlying.handle_async_request(request)
            if not dropped and request.url.path.endswith(lost):
                dropped = True
                await response.aclose()
                raise httpx.ReadError("synthetic lost response")
            return response

        async with (
            adapter(transport) as kubernetes,
            httpx.AsyncClient(transport=httpx.MockTransport(drop_once)) as http,
        ):
            client = ExecutionClient(http=http, key=key, now=harness.now)
            worker = ExecutionWorker(
                client=client,
                kubernetes=kubernetes,
                cluster_id="k8s-incident-agent",
                now=harness.now,
            )
            with pytest.raises(ExecutionExchangeError) as error:
                await worker.step()
            assert error.value.retryable
            restarted = ExecutionWorker(
                client=client,
                kubernetes=kubernetes,
                cluster_id="k8s-incident-agent",
                now=harness.now,
            )
            await restarted.step()
            await worker.step()
            assert sum(call["method"] == "PATCH" for call in transport.calls) == (
                1 if lost == "report" else 0
            )
            if lost == "claim":
                harness.clock[0] += timedelta(seconds=41)
                await harness.repository.reconcile_executions(harness.now())
                assert (await execution_for(harness)).status == "UNKNOWN"
            else:
                assert (await execution_for(harness)).status == "APPLIED"


@pytest.mark.asyncio
async def test_execution_disable_still_accepts_inflight_report(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    key = secrets.token_bytes(32)
    async with approval_harness(tmp_path, credential, executor_key=key) as harness:
        await harness.approve()
        endpoint = harness.app.state.container.execution
        assert endpoint is not None
        original = endpoint.repository
        disabled = IncidentRepository(
            harness.database.session_factory,
            sandbox_execution_enabled=False,
            execution_cluster="k8s-incident-agent",
        )
        proposal = await proposal_for(harness)
        transport = KubernetesTransport(
            RawResponse(deployment(proposal)),
            RawResponse(deployment(proposal, patched=True)),
        )
        underlying = httpx.ASGITransport(app=harness.app)

        async def disable_after_claim(request: httpx.Request) -> httpx.Response:
            response = await underlying.handle_async_request(request)
            if request.url.path == CLAIM_CHANNEL.path:
                harness.app.state.container = replace(
                    harness.app.state.container,
                    execution=replace(endpoint, repository=disabled),
                )
            return response

        async with (
            adapter(transport) as kubernetes,
            httpx.AsyncClient(
                transport=httpx.MockTransport(disable_after_claim)
            ) as http,
        ):
            worker = ExecutionWorker(
                client=ExecutionClient(http=http, key=key, now=harness.now),
                kubernetes=kubernetes,
                cluster_id="k8s-incident-agent",
                now=harness.now,
            )
            await worker.step()
            await worker.step()
            assert (await execution_for(harness)).status == "APPLIED"
            assert await disabled.claim_execution(now=harness.now) is None
            assert original is harness.repository


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["write_response_lost", "claim_expired"])
async def test_worker_persists_unknown_or_known_not_started_without_retry(
    tmp_path: Path,
    credential: tuple[str, str],
    failure: str,
) -> None:
    key = secrets.token_bytes(32)
    async with approval_harness(tmp_path, credential, executor_key=key) as harness:
        await harness.approve()
        proposal = await proposal_for(harness)
        transport = KubernetesTransport(
            RawResponse(deployment(proposal)),
            TimeoutError("synthetic lost write receipt"),
        )
        underlying = httpx.ASGITransport(app=harness.app)

        async def delayed_claim(request: httpx.Request) -> httpx.Response:
            response = await underlying.handle_async_request(request)
            if failure == "claim_expired" and request.url.path == CLAIM_CHANNEL.path:
                harness.clock[0] += timedelta(seconds=31)
            return response

        async with (
            adapter(transport) as kubernetes,
            httpx.AsyncClient(transport=httpx.MockTransport(delayed_claim)) as http,
        ):
            client = ExecutionClient(http=http, key=key, now=harness.now)
            worker = ExecutionWorker(
                client=client,
                kubernetes=kubernetes,
                cluster_id="k8s-incident-agent",
                now=harness.now,
            )
            await worker.step()
            execution = await execution_for(harness)
            assert execution.status == (
                "UNKNOWN" if failure == "write_response_lost" else "REJECTED"
            )
            restarted = ExecutionWorker(
                client=client,
                kubernetes=kubernetes,
                cluster_id="k8s-incident-agent",
                now=harness.now,
            )
            await restarted.step()
            assert [call["method"] for call in transport.calls] == (
                ["GET", "PATCH"] if failure == "write_response_lost" else []
            )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field",
    ["run", "proposal", "digest", "validation", "scope", "approval", "deadline"],
)
async def test_worker_independently_rejects_command_binding_tampering(
    tmp_path: Path, credential: tuple[str, str], field: str
) -> None:
    from uuid import uuid4

    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        command = await harness.repository.claim_execution(now=harness.now)
        assert command is not None
        document = command.model_dump(mode="json")
        if field == "run":
            document["approval"]["run_id"] = str(uuid4())
        elif field == "proposal":
            document["approval"]["proposal_id"] = str(uuid4())
        elif field == "digest":
            document["approval"]["proposal_digest"] = "sha256:" + "0" * 64
        elif field == "validation":
            document["validation"]["checked_at"] = (
                harness.now() - timedelta(seconds=1)
            ).isoformat()
        elif field == "scope":
            document["change"]["target"]["namespace"] = "k8s-yaml-assistant-prod"
        elif field == "approval":
            document["approval"]["decision"] = "reject"
        else:
            document["start_before"] = (
                harness.now() + timedelta(minutes=1)
            ).isoformat()
        tampered = ExecutionCommand.model_validate_json(json.dumps(document))
        with pytest.raises(ExecutionCommandInvalid):
            validate_execution_command(
                tampered, cluster_id="k8s-incident-agent", now=harness.now()
            )
