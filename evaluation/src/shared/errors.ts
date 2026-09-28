// Every code the evaluator itself raises. Codes forwarded from the release, deployment and
// scenario scripts keep their producer's vocabulary and are typed separately below.
export const EVALUATION_ERROR_CODES = [
  "invalid_arguments",
  "evaluation_catalog_invalid",
  "evaluation_dataset_invalid",
  "evaluation_holdout_unavailable",
  "evaluation_retry_target_invalid",
  "artifact_directory_invalid",
  "evaluation_artifact_exists",
  "evaluation_artifact_invalid",
  "evaluation_review_invalid",
  "evaluation_review_package_invalid",
  "evaluation_report_failed",
  "cluster_command_failed",
  "http_request_failed",
  "http_unavailable",
  "port_forward_failed",
  "port_forward_not_ready",
  "response_too_large",
  "operator_authentication_failed",
  "monitoring_not_healthy",
  "alert_firing_timeout",
  "alert_clear_timeout",
  "alert_resolution_not_persisted",
  "alert_repeat_not_deduplicated",
  "alertmanager_repeat_not_observed",
  "incident_not_created",
  "diagnosis_not_terminal",
  "post_resolution_panel_not_settled",
  "metric_probe_not_observable",
  "metric_state_not_observed",
  "rotated_webhook_not_observed",
  "healthy_control_alerted",
  "healthy_control_incident_created",
  "duplicate_target_incident",
  "terminal_outcome_mismatch",
  "run_failure_invalid",
  "diagnosis_invalid",
  "diagnosis_tools_invalid",
  "diagnosis_evidence_missing",
  "diagnosis_evidence_links_invalid",
  "repair_validation_invalid",
  "incident_resolution_invalid",
  "firing_panel_invalid",
  "trigger_panel_not_firing",
  "console_incident_incomplete",
  "sse_replay_failed",
  "sse_replay_incomplete",
  "sse_replay_invalid",
  "online_route_set_invalid",
  "online_existing_incident_required",
  "online_rerun_boundary_invalid",
  "online_console_invalid",
  "upstream_contract_invalid",
  "evaluation_failed",
] as const;

export type EvaluationErrorCode = (typeof EVALUATION_ERROR_CODES)[number];

// Only the normalization of script errors (producerError) may mint one of these.
export type ProducerErrorCode = string & { readonly producer: "scripts" };

export class EvaluationError extends Error {
  readonly code: EvaluationErrorCode | ProducerErrorCode;

  constructor(code: EvaluationErrorCode | ProducerErrorCode, message: string) {
    super(message);
    this.name = "EvaluationError";
    this.code = code;
  }
}

export class TransientEvaluationError extends EvaluationError {}

export function contractError(
  code: EvaluationErrorCode,
  message: string,
): EvaluationError {
  return new EvaluationError(code, message);
}

// A release, deployment or scenario script error keeps its own code and message.
export function producerError(code: string, message: string): EvaluationError {
  return new EvaluationError(code as ProducerErrorCode, message);
}

export function upstreamContractError(): EvaluationError {
  return contractError(
    "upstream_contract_invalid",
    "An evaluation producer returned an invalid contract",
  );
}

export function invalidArguments(): EvaluationError {
  return contractError(
    "invalid_arguments",
    "Evaluation arguments do not match the supported usage",
  );
}

export interface SafeFailure {
  code: EvaluationErrorCode | ProducerErrorCode;
  message: string;
}

// Unknown errors may carry upstream content, so only evaluation errors keep their message.
export function safeFailure(error: unknown): SafeFailure {
  if (error instanceof EvaluationError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "evaluation_failed",
    message: "Scenario evaluation failed without exposing upstream content",
  };
}
