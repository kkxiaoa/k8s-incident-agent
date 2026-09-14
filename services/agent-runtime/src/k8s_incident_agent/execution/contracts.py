from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationResponse,
)

type ApprovalDecision = Literal["approve", "reject"]
type ExecutionStatus = Literal[
    "PENDING", "CLAIMED", "APPLIED", "EXPIRED", "STALE_RESOURCE", "REJECTED", "UNKNOWN"
]


class _ExecutionContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ApprovalRecord(_ExecutionContract):
    id: UUID
    run_id: UUID
    proposal_id: UUID
    proposal_digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    validation_digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    decision: ApprovalDecision
    actor: str = Field(min_length=1)
    decided_at: AwareDatetime
    expires_at: AwareDatetime


class ExecutionReceipt(_ExecutionContract):
    uid: str = Field(min_length=1, max_length=253)
    resource_version: str = Field(min_length=1, max_length=253)
    generation: int = Field(ge=1)
    before_generation: int = Field(ge=1)


class ExecutionResult(_ExecutionContract):
    outcome: Literal["APPLIED", "STALE_RESOURCE", "REJECTED", "UNKNOWN"]
    receipt: ExecutionReceipt | None = None
    error: (
        Literal[
            "permission_denied",
            "admission_denied",
            "precondition_failed",
            "upstream_failed",
            "outcome_unknown",
        ]
        | None
    ) = None

    @model_validator(mode="after")
    def require_result_shape(self) -> Self:
        if self.outcome == "APPLIED":
            valid = self.receipt is not None and self.error is None
        elif self.outcome == "UNKNOWN":
            valid = self.receipt is None and self.error == "outcome_unknown"
        elif self.outcome == "STALE_RESOURCE":
            valid = self.receipt is None and self.error == "precondition_failed"
        else:
            valid = self.receipt is None and self.error in (
                "permission_denied",
                "admission_denied",
                "precondition_failed",
                "upstream_failed",
            )
        if not valid:
            raise ValueError("Execution result has inconsistent evidence")
        return self


class ExecutionRecord(_ExecutionContract):
    id: UUID
    approval_id: UUID
    status: ExecutionStatus
    start_before: AwareDatetime
    claimed_at: AwareDatetime | None
    reported_at: AwareDatetime | None
    result: ExecutionResult | None
    late_result: ExecutionResult | None


class ExecutionCommand(_ExecutionContract):
    execution_id: UUID
    approval: ApprovalRecord
    change: EvidenceBoundImageChange
    validation: PatchValidationResponse
    start_before: AwareDatetime
