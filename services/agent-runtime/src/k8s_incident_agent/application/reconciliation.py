from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import CurrentTargetFacts
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.monitoring.contracts import (
    CurrentAlertObservation,
    CurrentAlertState,
    CurrentAlertSummary,
    ObservationReason,
)
from k8s_incident_agent.monitoring.errors import MonitoringBoundaryError
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import (
    AlertObservationRevision,
    IncidentRepository,
    RepositoryError,
)


class AlertReconciler:
    """Runtime-owned read loop that rechecks durable signals before diagnosis."""

    def __init__(
        self,
        *,
        repository: IncidentRepository,
        adapter: KubernetesEvidenceAdapter,
        prometheus: PrometheusQueryService,
        now: Callable[[], datetime],
        diagnose: Callable[
            [KubernetesTarget, datetime, AlertObservationRevision], Awaitable[None]
        ],
    ) -> None:
        self._repository = repository
        self._adapter = adapter
        self._prometheus = prometheus
        self._now = now
        self._diagnose = diagnose
        self._wake = asyncio.Event()
        self._pass = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._initialized = False
        self._interrupted_target: KubernetesTarget | None = None

    def request_reconciliation(self) -> None:
        self._wake.set()

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self._initialized = False
        self._interrupted_target = None

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            self._wake.clear()
            try:
                count = await self.reconcile()
            except RepositoryError:
                count = 1
            delay = max(0.0, 30.0 - (loop.time() - started))
            if count:
                # Repeated notifications coalesce without accelerating the read
                # cadence or overtaking older targets in the durable work order.
                await asyncio.sleep(delay)
            else:
                with suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), delay)

    async def reconcile(self) -> int:
        if self._pass.locked():
            return 0
        attempted = 0
        async with self._pass:
            if not self._initialized:
                await self._repository.interrupt_stable_health(self._interrupted_target)
                self._initialized = True
                self._interrupted_target = None
            unfinished: KubernetesTarget | None = None
            try:
                async with asyncio.timeout(20):
                    targets = await self._repository.reconciliation_targets()
                    if not targets:
                        return 0
                    rules = await self._prometheus.read_reconciliation_rules()
                    for target in targets:
                        at = self._clock()
                        sample_started_at = at
                        unfinished = target
                        previous = await self._repository.get_current_alert_observation(
                            target
                        )
                        observation = CurrentAlertObservation(
                            target=target,
                            catalog_version=self._prometheus.catalog_version,
                            facts=None,
                            summary=CurrentAlertSummary(
                                observed_at=at,
                                received_at=at,
                                reason=ObservationReason.BUDGET_EXCEEDED,
                            ),
                        )
                        # A crash after this point advances only this attempted
                        # target. Unattempted targets remain first for the next pass.
                        initial = await self._repository.save_current_alert_observation(
                            observation, sampling=True
                        )
                        attempted += 1
                        if previous is not None and any(
                            value is not None and value > at
                            for value in (
                                previous.summary.received_at,
                                previous.summary.last_known_at,
                            )
                        ):
                            await self._repository.save_current_alert_observation(
                                observation.model_copy(
                                    update={
                                        "summary": observation.summary.model_copy(
                                            update={
                                                "reason": ObservationReason.CLOCK_INVALID
                                            }
                                        ),
                                    }
                                )
                            )
                            unfinished = None
                            continue
                        try:
                            before = await self._adapter.read_current_target(target)
                            at = self._clock()
                            observed_rules = (
                                await self._prometheus.observe_current_alerts(
                                    target, before, rules, at=at
                                )
                            )
                            after = await self._adapter.read_current_target(target)
                            received = self._clock()
                            reason = None
                            if before.created_at is None or after.created_at is None:
                                reason = ObservationReason.IDENTITY_UNVERIFIED
                            elif not (
                                before.created_at
                                <= before.observed_at
                                <= at
                                <= after.observed_at
                                <= received
                                and received - before.observed_at
                                <= timedelta(seconds=60)
                            ):
                                reason = ObservationReason.CLOCK_INVALID
                            elif _comparable_facts(before) != _comparable_facts(after):
                                reason = ObservationReason.FACTS_CHANGED
                            if reason is not None:
                                observed_rules = tuple(
                                    rule.model_copy(
                                        update={
                                            "state": CurrentAlertState.UNKNOWN,
                                            "complete": False,
                                            "reason": reason,
                                        }
                                    )
                                    for rule in observed_rules
                                )
                            complete = reason is None and all(
                                rule.complete for rule in observed_rules
                            )
                            state = (
                                CurrentAlertState.UNKNOWN
                                if not complete
                                else CurrentAlertState.FIRING
                                if any(
                                    rule.state is CurrentAlertState.FIRING
                                    for rule in observed_rules
                                )
                                else CurrentAlertState.PENDING
                                if any(
                                    rule.state is CurrentAlertState.PENDING
                                    for rule in observed_rules
                                )
                                else CurrentAlertState.CLEAR
                            )
                            observation = observation.model_copy(
                                update={
                                    "facts": after,
                                    "summary": CurrentAlertSummary(
                                        state=state,
                                        complete=complete,
                                        observed_at=at,
                                        received_at=received,
                                        target_healthy=after.healthy
                                        if reason is None
                                        else None,
                                        reason=reason
                                        or next(
                                            (
                                                rule.reason
                                                for rule in observed_rules
                                                if rule.reason is not None
                                            ),
                                            None,
                                        ),
                                        rules=observed_rules,
                                    ),
                                }
                            )
                        except (
                            KubernetesBoundaryError,
                            MonitoringBoundaryError,
                        ) as error:
                            failure_reasons: dict[str, ObservationReason] = {
                                KubernetesErrorCode.PERMISSION_DENIED: ObservationReason.PERMISSION_DENIED,
                                KubernetesErrorCode.AUTHENTICATION_FAILED: ObservationReason.PERMISSION_DENIED,
                                KubernetesErrorCode.REQUEST_TIMEOUT: ObservationReason.REQUEST_TIMEOUT,
                                KubernetesErrorCode.RESULT_BUDGET_EXCEEDED: ObservationReason.BUDGET_EXCEEDED,
                            }
                            reason = failure_reasons.get(
                                error.code, ObservationReason.UNAVAILABLE
                            )
                            observation = observation.model_copy(
                                update={
                                    "summary": observation.summary.model_copy(
                                        update={
                                            "received_at": self._clock(),
                                            "reason": reason,
                                        }
                                    )
                                }
                            )
                        final = await self._repository.save_current_alert_observation(
                            observation
                        )
                        await self._diagnose(
                            target,
                            sample_started_at,
                            replace(
                                final,
                                signal_revision=initial.signal_revision,
                                verification_interruption_id=(
                                    initial.verification_interruption_id
                                ),
                            ),
                        )
                        unfinished = None
            except asyncio.CancelledError:
                # Do not acquire another SQLite write lock while a cancelled
                # database call is unwinding. The next pass clears continuity
                # before any source read or closure can use the old window.
                self._initialized = False
                self._interrupted_target = None
                raise
            except TimeoutError:
                self._initialized = False
                self._interrupted_target = unfinished
            except Exception:
                self._initialized = False
                self._interrupted_target = unfinished
                raise
        return attempted or 1

    def _clock(self) -> datetime:
        return self._now().astimezone(UTC)


def _comparable_facts(facts: CurrentTargetFacts) -> dict[str, object]:
    return facts.model_dump(
        exclude={
            "observed_at": True,
            "workload": {"resource_version": True},
            "pods": {"__all__": {"pod": {"resource_version": True}}},
            "service": {
                "service": {"resource_version": True},
                "candidate_pods": {"__all__": {"resource_version": True}},
                "endpoint_slices": {"__all__": {"resource_version": True}},
            },
            "claim": {"resource_version": True},
        }
    )
