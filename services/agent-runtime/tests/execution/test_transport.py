from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable
from contextlib import asynccontextmanager
from typing import Protocol, cast

import pytest
from aiohttp import ClientResponse
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    Configuration,
)

from k8s_incident_agent.execution.kubernetes import configure_executor_transport


class AppsApi(Protocol):
    def patch_namespaced_deployment(
        self, name: str, namespace: str, body: list[object], **kwargs: object
    ) -> Awaitable[ClientResponse]: ...
    def read_namespaced_deployment(
        self, name: str, namespace: str, **kwargs: object
    ) -> Awaitable[ClientResponse]: ...


@asynccontextmanager
async def server(
    *, redirect: int | None = None
) -> AsyncGenerator[tuple[str, list[str]]]:
    calls: list[str] = []

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            while True:
                headers = await reader.readuntil(b"\r\n\r\n")
                calls.append(headers.split(b"\r\n", 1)[0].decode())
                length = next(
                    (
                        int(line.split(b":", 1)[1])
                        for line in headers.split(b"\r\n")
                        if line.lower().startswith(b"content-length:")
                    ),
                    0,
                )
                if length:
                    await reader.readexactly(length)
                if redirect is not None:
                    writer.write(
                        f"HTTP/1.1 {redirect} Redirect\r\nLocation: /redirected\r\nContent-Length: 0\r\n\r\n".encode()
                    )
                elif len(calls) == 1:
                    writer.write(
                        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
                    )
                else:
                    return
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    listener = await asyncio.start_server(handle, "127.0.0.1", 0)
    address = cast(tuple[str, int], listener.sockets[0].getsockname())
    async with listener:
        yield f"http://127.0.0.1:{address[1]}", calls


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
async def test_locked_sdk_never_redirects_patch(status: int) -> None:
    async with server(redirect=status) as (url, calls):
        configuration = Configuration()
        configuration.host = url
        async with ApiClient(configuration) as client:
            await configure_executor_transport(client)
            response = await cast(
                AppsApi, AppsV1Api(client)
            ).patch_namespaced_deployment(
                "sample",
                "k8s-incident-scenarios",
                [],
                _content_type="application/json-patch+json",
                _preload_content=False,
                _request_timeout=10,
            )
            try:
                assert response.status == status
                assert calls == [
                    "PATCH /apis/apps/v1/namespaces/k8s-incident-scenarios/deployments/sample HTTP/1.1"
                ]
            finally:
                response.release()


@pytest.mark.asyncio
async def test_locked_sdk_does_not_retry_broken_persistent_get() -> None:
    from aiohttp import ServerDisconnectedError

    async with server() as (url, calls):
        configuration = Configuration()
        configuration.host = url
        async with ApiClient(configuration) as client:
            await configure_executor_transport(client)
            apps = cast(AppsApi, AppsV1Api(client))
            first = await apps.read_namespaced_deployment(
                "sample", "k8s-incident-scenarios", _preload_content=False
            )
            await first.read()
            first.release()
            with pytest.raises(ServerDisconnectedError):
                await apps.read_namespaced_deployment(
                    "sample", "k8s-incident-scenarios", _preload_content=False
                )
            assert len(calls) == 2
