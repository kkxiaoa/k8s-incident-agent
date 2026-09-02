from k8s_incident_agent.application.scheduling import (
    RunScheduler,
    schedule_committed_run,
)
from k8s_incident_agent.domain.models import ModelSnapshot, RunBudget
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
        supervisor: RunScheduler,
        model: ModelSnapshot,
        budget: RunBudget,
        cluster_id: str,
        diagnostic_namespace: str,
    ) -> None:
        self._catalog = catalog
        self._authenticator = authenticator
        self._repository = repository
        self._supervisor = supervisor
        self._model = model
        self._budget = budget
        self._cluster_id = cluster_id
        self._diagnostic_namespace = diagnostic_namespace

    def require_authentication(self, credentials: str | None) -> None:
        self._authenticator.require(credentials)

    async def ingest(self, payload: bytes) -> None:
        occurrences = parse_alertmanager_webhook(
            payload,
            catalog=self._catalog,
            cluster_id=self._cluster_id,
            diagnostic_namespace=self._diagnostic_namespace,
        )
        result = await self._repository.apply_alert_occurrences(
            occurrences,
            self._model,
            self._budget,
        )
        for run_id in result.created_run_ids:
            await schedule_committed_run(self._supervisor, run_id)
