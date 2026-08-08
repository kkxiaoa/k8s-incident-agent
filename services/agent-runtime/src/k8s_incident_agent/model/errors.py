from enum import StrEnum


class ModelErrorCode(StrEnum):
    CONFIGURATION_INVALID = "configuration_invalid"
    AUTHENTICATION_FAILED = "authentication_failed"
    MODEL_NOT_FOUND = "model_not_found"
    PROVIDER_RATE_LIMITED = "provider_rate_limited"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    PROVIDER_CONTRACT_INVALID = "provider_contract_invalid"
    TOOL_ARGUMENTS_INVALID = "tool_arguments_invalid"
    STRUCTURED_OUTPUT_INVALID = "structured_output_invalid"
    REASONING_ROUNDTRIP_FAILED = "reasoning_roundtrip_failed"


class ModelError(RuntimeError):
    def __init__(self, code: ModelErrorCode, message: str) -> None:
        self.code = code
        super().__init__(message)
