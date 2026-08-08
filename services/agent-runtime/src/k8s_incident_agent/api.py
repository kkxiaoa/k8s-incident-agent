from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from k8s_incident_agent.config import Settings
from k8s_incident_agent.model.discovery import discover_models

ModelDiscovery = Callable[[Settings], Awaitable[tuple[str, ...]]]


def create_app(
    *,
    settings: Settings | None = None,
    discovery: ModelDiscovery = discover_models,
) -> FastAPI:
    resolved_settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        resolved_settings.require_deepseek_api_key()
        await discovery(resolved_settings)
        app.state.ready = True
        try:
            yield
        finally:
            app.state.ready = False

    app = FastAPI(
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.ready = False

    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.add_api_route("/healthz", healthz, methods=["GET"])
    return app


def main() -> None:
    uvicorn.run("k8s_incident_agent.api:create_app", factory=True)
