from collections.abc import Callable
from datetime import datetime

from k8s_incident_agent.monitoring.alertmanager import parse_alertmanager_webhook
from k8s_incident_agent.monitoring.auth import AlertmanagerWebhookAuthenticator
from k8s_incident_agent.monitoring.catalog import AlertCatalog
from k8s_incident_agent.persistence.repositories import IncidentRepository


class AlertmanagerApplicationService:
    def __init__(
        self,
        *,
        catalog: AlertCatalog,
        authenticator: AlertmanagerWebhookAuthenticator,
        repository: IncidentRepository,
        cluster_id: str,
        diagnostic_namespace: str,
        now: Callable[[], datetime],
    ) -> None:
        self._catalog = catalog
        self._authenticator = authenticator
        self._repository = repository
        self._cluster_id = cluster_id
        self._diagnostic_namespace = diagnostic_namespace
        self._now = now

    def require_authentication(self, credentials: str | None) -> None:
        self._authenticator.require(credentials)

    async def ingest(self, payload: bytes) -> None:
        parsed = parse_alertmanager_webhook(
            payload,
            catalog=self._catalog,
            cluster_id=self._cluster_id,
            diagnostic_namespace=self._diagnostic_namespace,
        )
        received_at = self._now()
        await self._repository.apply_alert_occurrences(
            parsed.occurrences,
            received_at=received_at,
            watchdog_received_at=(received_at if parsed.watchdog_firing else None),
        )
