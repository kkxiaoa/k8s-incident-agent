from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from k8s_incident_agent.diagnosis.contracts import ValidatedDiagnosis
from k8s_incident_agent.domain.contracts import RepairHistorySelection
from k8s_incident_agent.repair.compiler import require_exact_repair_proposal
from k8s_incident_agent.repair.contracts import (
    PatchValidationResponse,
    RepairProposal,
)


@dataclass(frozen=True, slots=True)
class PreparedRepairRecord:
    run_id: UUID
    recorded_at: datetime
    proposal: RepairProposal | None
    validation: PatchValidationResponse | None
    selection: RepairHistorySelection | None
    error_code: str | None
    error_retryable: bool | None

    def __post_init__(self) -> None:
        if self.recorded_at.tzinfo is None or self.recorded_at.utcoffset() is None:
            raise ValueError("Preparation requires an aware timestamp")
        if (self.error_code is None) != (self.error_retryable is None):
            raise ValueError("Preparation error is incomplete")
        if self.proposal is None:
            if self.validation is not None or self.error_code is None:
                raise ValueError("Preparation without a proposal must fail")
            return
        if (
            self.proposal.run_id != self.run_id
            or self.selection is None
            or self.validation is None
            or self.validation.proposal_id != self.proposal.id
            or self.validation.run_id != self.run_id
            or self.validation.proposal_digest != self.proposal.digest
            or self.validation.checked_at < self.proposal.diff_checked_at
            or self.recorded_at < self.validation.checked_at
        ):
            raise ValueError("Preparation does not match its proposal and validation")
        if self.validation.outcome == "passed":
            if self.error_code is not None:
                raise ValueError("Passed preparation cannot contain an error")
        elif (
            self.validation.error is None
            or self.error_code != self.validation.error.code
            or self.error_retryable != self.validation.error.retryable
        ):
            raise ValueError("Preparation must preserve the validation failure")


@dataclass(frozen=True, slots=True)
class RepairTerminalRecord:
    run_id: UUID
    diagnosis_completed_at: datetime
    completed_at: datetime
    diagnosis: ValidatedDiagnosis
    proposal: RepairProposal | None
    validation: PatchValidationResponse | None
    error_code: str | None
    error_retryable: bool | None
    model_calls: int
    tool_calls: int
    input_tokens: int | None = None
    output_tokens: int | None = None

    def __post_init__(self) -> None:
        timestamps = (self.diagnosis_completed_at, self.completed_at)
        if (
            self.diagnosis.outcome != "diagnosed"
            or any(
                value.tzinfo is None or value.utcoffset() is None
                for value in timestamps
            )
            or self.diagnosis_completed_at > self.completed_at
            or self.model_calls < 0
            or self.tool_calls < 0
            or any(
                value is not None and value < 0
                for value in (self.input_tokens, self.output_tokens)
            )
            or (self.error_code is None) is not (self.error_retryable is None)
        ):
            raise ValueError("Repair terminal record is invalid")
        if self.proposal is None:
            if self.validation is not None or self.error_code is None:
                raise ValueError(
                    "Failed repair preparation must not contain a proposal"
                )
            return
        require_exact_repair_proposal(self.proposal)
        if (
            self.proposal.run_id != self.run_id
            or self.proposal.schema_checked_at < self.diagnosis_completed_at
            or self.validation is None
            or self.validation.proposal_id != self.proposal.id
            or self.validation.run_id != self.run_id
            or self.validation.proposal_digest != self.proposal.digest
            or self.validation.checked_at < self.proposal.diff_checked_at
            or self.completed_at < self.validation.checked_at
        ):
            raise ValueError("Repair proposal terminal identity is invalid")
        intent = self.diagnosis.repair_intent
        if (
            intent is None
            or intent.action != self.proposal.action
            or intent.target != self.proposal.target
            or intent.container_name != self.proposal.container_name
            or intent.replacement_image != self.proposal.replacement_image
            or set(intent.evidence_ids) != set(self.proposal.evidence_ids)
        ):
            raise ValueError("Repair proposal does not match the diagnosis intent")
        if self.validation.outcome == "passed":
            if self.error_code is not None:
                raise ValueError("Passed repair validation cannot contain an error")
            return
        if (
            self.validation.error is None
            or self.error_code != self.validation.error.code
            or self.error_retryable is not self.validation.error.retryable
        ):
            raise ValueError("Failed repair validation must preserve its error")
