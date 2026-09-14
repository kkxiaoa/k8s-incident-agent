from __future__ import annotations

import asyncio
import gzip
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from aiohttp.client_proto import ResponseHandler

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.execution import kubernetes as boundary
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import EvidenceBoundImageChange, RepairProposal
from tests.execution.test_worker import (
    KubernetesTransport,
    RawResponse,
    adapter,
    deployment,
)

NOW = datetime(2026, 9, 14, tzinfo=UTC)


@pytest.fixture
def proposal() -> RepairProposal:
    change = EvidenceBoundImageChange(
        run_id=uuid4(),
        action="set_container_image",
        target=KubernetesTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="sample",
        ),
        target_uid="uid",
        target_resource_version="rv-opaque",
        container_index=0,
        container_name="workload",
        current_image="registry.invalid/sample:v2",
        replacement_image="registry.k8s.io/example:v1",
        evidence_ids=sorted([uuid4(), uuid4()], key=str),
    )
    return compile_repair_proposal(
        change, schema_checked_at=NOW, policy_checked_at=NOW, diff_checked_at=NOW
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("uid", "different"),
        ("resourceVersion", "different"),
        ("image", "different"),
        ("container", "different"),
        ("index", []),
    ],
)
async def test_get_drift_safely_stops_before_patch(
    proposal: RepairProposal, field: str, value: Any
) -> None:
    before = deployment(proposal)
    containers = before["spec"]["template"]["spec"]["containers"]
    if field in ("uid", "resourceVersion"):
        before["metadata"][field] = value
    elif field == "index":
        before["spec"]["template"]["spec"]["containers"] = value
    else:
        containers[0]["image" if field == "image" else "name"] = value
    raw = RawResponse(before)
    transport = KubernetesTransport(raw, RuntimeError("must not write"))
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    assert result.outcome == "STALE_RESOURCE"
    assert [call["method"] for call in transport.calls] == ["GET"]
    assert raw.released


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["GET", "PATCH"])
@pytest.mark.parametrize(
    "status", [400, 401, 403, 404, 409, 422, 429, 500, 503, 504, 307]
)
async def test_status_producer_has_conservative_phase_specific_results(
    proposal: RepairProposal, phase: str, status: int
) -> None:
    rejection = RawResponse(
        {
            "apiVersion": "v1",
            "kind": "Status",
            "status": "Failure",
            "code": status,
            "message": "untrusted admission content",
        },
        status,
    )
    transport = KubernetesTransport(
        rejection if phase == "GET" else RawResponse(deployment(proposal)), rejection
    )
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    expected = (
        "UNKNOWN" if phase == "PATCH" and status in (500, 503, 504, 307) else "REJECTED"
    )
    if phase == "GET" and status == 404:
        expected = "STALE_RESOURCE"
    assert result.outcome == expected
    assert "untrusted" not in result.model_dump_json()
    assert len(transport.calls) == (1 if phase == "GET" else 2)
    assert rejection.released


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("generation", True),
        ("generation", 4.5),
        ("generation", "4"),
        ("generation", 3),
        ("generation", 5),
        ("generation", 2**63),
        ("uid", 123),
        ("uid", "foreign"),
        ("resourceVersion", "rv-opaque"),
        ("resourceVersion", ""),
        ("image", "unapproved"),
        ("index", []),
    ],
)
async def test_untrusted_patch_success_is_unknown_not_applied_or_rejected(
    proposal: RepairProposal, field: str, value: Any
) -> None:
    after = deployment(proposal, patched=True)
    if field == "image":
        after["spec"]["template"]["spec"]["containers"][0]["image"] = value
    elif field == "index":
        after["spec"]["template"]["spec"]["containers"] = value
    else:
        after["metadata"][field] = value
    transport = KubernetesTransport(
        RawResponse(deployment(proposal)), RawResponse(after)
    )
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    assert result.outcome == "UNKNOWN" and result.receipt is None
    assert len(transport.calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["GET", "PATCH"])
@pytest.mark.parametrize(
    "failure", ["disconnect", "invalid_json", "budget", "untrusted_status"]
)
async def test_missing_or_unusable_response_is_not_invented_evidence(
    proposal: RepairProposal, phase: str, failure: str
) -> None:
    bad: object
    if failure == "disconnect":
        bad = OSError("synthetic disconnected socket")
    else:
        bad = RawResponse(deployment(proposal, patched=True))
        if failure == "invalid_json":
            bad.raw = b"not json"
        elif failure == "budget":
            bad.raw = b"x" * (1024 * 1024 + 1)
        else:
            bad.status = 403  # A Deployment body is not a Kubernetes failure Status.
    transport = KubernetesTransport(
        bad if phase == "GET" else RawResponse(deployment(proposal)), bad
    )
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    assert result.outcome == ("UNKNOWN" if phase == "PATCH" else "REJECTED")
    assert len(transport.calls) == (1 if phase == "GET" else 2)


@pytest.mark.asyncio
async def test_write_start_deadline_is_rechecked_after_get(
    proposal: RepairProposal,
) -> None:
    transport = KubernetesTransport(
        RawResponse(deployment(proposal)), RuntimeError("must not write")
    )
    async with adapter(transport) as client:
        result = await client.apply(proposal, start_before=NOW, now=lambda: NOW)
    assert result.outcome == "REJECTED" and result.error == "precondition_failed"
    assert len(transport.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["GET", "PATCH"])
async def test_total_timeout_includes_receiving_body(
    proposal: RepairProposal, phase: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    class SlowBody(RawResponse):
        async def iter_chunked(self, size: int):
            yield b"{"
            await asyncio.sleep(60)

    # Shorten only the test clock budget; exercise the production asyncio timeout.
    monkeypatch.setattr(boundary, "KUBERNETES_TIMEOUT_SECONDS", 0.01)
    slow = SlowBody({})
    transport = KubernetesTransport(
        slow if phase == "GET" else RawResponse(deployment(proposal)), slow
    )
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    assert result.outcome == ("UNKNOWN" if phase == "PATCH" else "REJECTED")
    assert slow.released


async def parsed_response(
    document: object, *, compressed: bool, truncated: bool = False
) -> object:
    raw = json.dumps(document).encode()
    wire = gzip.compress(raw) if compressed else raw
    headers = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
    if compressed:
        headers += b"Content-Encoding: gzip\r\n"
    headers += f"Content-Length: {len(wire)}\r\n\r\n".encode()
    protocol = ResponseHandler(asyncio.get_running_loop())
    protocol.set_response_params(auto_decompress=True)
    protocol.data_received(headers + (wire[:-1] if truncated else wire))
    message, payload = await protocol.read()
    protocol.connection_lost(None)
    return SimpleNamespace(
        status=message.code,
        headers=message.headers,
        content=payload,
        release=lambda: None,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["GET", "PATCH"])
async def test_locked_parser_compressed_response_is_valid_execution_evidence(
    proposal: RepairProposal, phase: str
) -> None:
    document = deployment(proposal, patched=phase == "PATCH")
    document["metadata"]["annotations"] = {"padding": "x" * 200000}
    response = await parsed_response(document, compressed=True)
    transport = KubernetesTransport(
        response if phase == "GET" else RawResponse(deployment(proposal)),
        response
        if phase == "PATCH"
        else RawResponse(deployment(proposal, patched=True)),
    )
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    assert result.outcome == "APPLIED"
    assert [call["method"] for call in transport.calls] == ["GET", "PATCH"]
    assert "padding" not in result.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["GET", "PATCH"])
@pytest.mark.parametrize("compressed", [False, True])
async def test_locked_parser_rejects_wire_truncation_with_phase_specific_outcome(
    proposal: RepairProposal, phase: str, compressed: bool
) -> None:
    response = await parsed_response(
        deployment(proposal, patched=phase == "PATCH"),
        compressed=compressed,
        truncated=True,
    )
    transport = KubernetesTransport(
        response if phase == "GET" else RawResponse(deployment(proposal)), response
    )
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    assert result.outcome == ("REJECTED" if phase == "GET" else "UNKNOWN")
    assert len(transport.calls) == (1 if phase == "GET" else 2)


@pytest.mark.asyncio
async def test_compressed_response_still_obeys_decoded_byte_budget(
    proposal: RepairProposal,
) -> None:
    document = deployment(proposal)
    document["metadata"]["annotations"] = {"padding": "x" * (1024 * 1024)}
    response = await parsed_response(document, compressed=True)
    transport = KubernetesTransport(response, RuntimeError("must not write"))
    async with adapter(transport) as client:
        result = await client.apply(
            proposal, start_before=NOW + timedelta(seconds=30), now=lambda: NOW
        )
    assert result.outcome == "REJECTED"
    assert len(transport.calls) == 1
