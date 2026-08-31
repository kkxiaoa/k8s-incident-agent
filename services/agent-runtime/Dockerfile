# syntax=docker/dockerfile:1.7

FROM python:3.13.15-slim-bookworm@sha256:c45a22ea000adfd9cda29364bbe7edd23001ce5cc2ad15857cfbf7766943b9ca AS python-base

FROM ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc AS uv

FROM python-base AS builder

ENV UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

COPY --from=uv /uv /uvx /bin/

WORKDIR /workspace/services/agent-runtime

COPY services/agent-runtime/pyproject.toml services/agent-runtime/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY services/agent-runtime/alembic.ini ./
COPY services/agent-runtime/migrations ./migrations
COPY services/agent-runtime/src ./src
RUN uv sync --locked --no-dev

FROM python-base AS runner

ARG SOURCE_REVISION
ARG SOURCE_VERSION=0.1.0

RUN test -n "${SOURCE_REVISION}" \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/app app \
    && install -d --owner=10001 --group=10001 --mode=0700 \
        /var/lib/k8s-incident-agent/runtime

LABEL org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${SOURCE_VERSION}"

ENV PATH="/workspace/services/agent-runtime/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RUNTIME_DATA_DIR=/var/lib/k8s-incident-agent/runtime \
    SCENARIO_CATALOG_DIR=/workspace/scenarios

WORKDIR /workspace/services/agent-runtime

COPY --from=builder --chown=10001:10001 \
    /workspace/services/agent-runtime /workspace/services/agent-runtime
COPY --chown=10001:10001 scenarios /workspace/scenarios

USER 10001:10001

EXPOSE 8000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; response = urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2); raise SystemExit(0 if response.status == 200 else 1)"

CMD ["uvicorn", "k8s_incident_agent.api:create_runtime_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-graceful-shutdown", "5"]
