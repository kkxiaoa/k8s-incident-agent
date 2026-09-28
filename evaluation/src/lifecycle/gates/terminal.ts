import type { EvaluationCase } from "../../contracts/dataset.ts";
import type { ObservedRun, RepairCheck } from "../../contracts/records.ts";
import type { IncidentDetail } from "../../contracts/runtime-api.ts";
import { contractError, upstreamContractError } from "../../shared/errors.ts";
import { isNormalizedString, isPlainObject, isUuid } from "../../shared/guards.ts";
import { validateTerminalRepair } from "./repair.ts";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "FAILED"]);
export const FAILED_INCIDENT_STATUSES: ReadonlySet<string> = new Set(["FAILED", "STALE_RESOURCE"]);
const ROOT_CAUSE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONFIDENCES: ReadonlySet<unknown> = new Set(["low", "medium", "high"]);

type Evidence = IncidentDetail["evidence"][number];

interface EvidenceIndex {
  evidenceById: Map<string, Evidence>;
  evidenceKinds: string[];
}

export interface DiagnosisSummary {
  evidenceKinds: string[];
  uncitedExpectedEvidence: string[];
  diagnosisCodes: string[];
  repair: RepairCheck | undefined;
}

type ExpectedTerminal = EvaluationCase["expectedTerminal"];

// The Runtime's own terminal values, kept before any expectation is applied to them.
export function observedRun(detail: IncidentDetail): ObservedRun {
  const run = detail.selectedRun;
  return {
    attempt: run.attempt,
    status: run.status,
    errorCode: run.error?.code ?? null,
    retryable: run.error?.retryable ?? null,
    outcome: detail.diagnosis?.outcome ?? null,
  };
}

function terminalMatches(expected: ExpectedTerminal, observed: ObservedRun): boolean {
  if (expected.outcome === "failed") {
    return observed.status === "FAILED" && observed.errorCode === expected.errorCode;
  }
  return observed.status === "COMPLETED" && observed.errorCode === null && observed.outcome === expected.outcome;
}

function safeToken(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "invalid";
}

export function assessTerminal(scenario: EvaluationCase, detail: IncidentDetail): DiagnosisSummary {
  const expected = scenario.expectedTerminal;
  const observed = observedRun(detail);
  if (!terminalMatches(expected, observed)) {
    const actual = `${safeToken(observed.status)}/${safeToken(observed.outcome ?? observed.errorCode ?? "none")}`;
    const wanted = expected.outcome === "failed" ? `failed/${expected.errorCode}` : expected.outcome;
    throw contractError("terminal_outcome_mismatch", `The Run ended ${actual} while the case expects ${wanted}`);
  }
  if (expected.outcome === "diagnosed") return validateTerminalDiagnosis(scenario, detail);
  if (expected.outcome === "insufficient_evidence") return validateInsufficientDiagnosis(scenario, detail);
  return validateFailedRun(scenario, detail);
}

function indexEvidence(scenario: EvaluationCase, detail: IncidentDetail): EvidenceIndex {
  const evidenceById = new Map<string, Evidence>();
  for (const item of detail.evidence) {
    if (
      !isPlainObject(item) ||
      !isUuid(item.id) ||
      !isNormalizedString(item.evidenceKind) ||
      !isNormalizedString(item.toolName) ||
      evidenceById.has(item.id)
    ) {
      throw upstreamContractError();
    }
    evidenceById.set(item.id, item as Evidence);
  }
  const evidenceKinds = [...new Set([...evidenceById.values()].map((item) => item.evidenceKind))].sort();
  const tools = new Set(detail.evidence.map((item) => item.toolName));
  if ([...tools].some((tool) => !scenario.allowedTools.includes(tool) || scenario.forbiddenTools.includes(tool))) {
    throw contractError("diagnosis_tools_invalid", "Diagnosis used a tool the scenario does not permit");
  }
  return { evidenceById, evidenceKinds };
}

// The contract read guarantees the document header and a selectedRun object; the Run's own
// fields are still the Runtime's to get wrong.
function isDiagnosisRun(detail: IncidentDetail): boolean {
  const run: unknown = detail.selectedRun;
  return isPlainObject(run) && run.kind === "diagnosis" && run.operation === null && run.attempt === 1;
}

function validateTerminalDiagnosis(scenario: EvaluationCase, detail: IncidentDetail): DiagnosisSummary {
  const diagnosis: unknown = detail.diagnosis;
  const run: unknown = detail.selectedRun;
  if (
    !isDiagnosisRun(detail) ||
    !isPlainObject(run) ||
    run.status !== "COMPLETED" ||
    run.error !== null ||
    !Array.isArray(detail.evidence) ||
    !isPlainObject(diagnosis) ||
    diagnosis.outcome !== "diagnosed" ||
    typeof diagnosis.summary !== "string" ||
    diagnosis.summary.length === 0 ||
    !Array.isArray(diagnosis.rootCauses) ||
    diagnosis.rootCauses.length === 0 ||
    diagnosis.rootCauses.length > 5
  ) {
    throw contractError("diagnosis_invalid", "The alert-driven diagnosis did not complete successfully");
  }
  const { evidenceById, evidenceKinds } = indexEvidence(scenario, detail);
  const uncollected = scenario.requiredEvidence.filter((kind) => !evidenceKinds.includes(kind));
  if (uncollected.length > 0) {
    throw contractError("diagnosis_evidence_missing", `Diagnosis did not collect ${uncollected.join(", ")}`);
  }
  const diagnosisCodes: string[] = [];
  const citedEvidenceKinds = new Set<string>();
  for (const rootCause of diagnosis.rootCauses as unknown[]) {
    const cause = isPlainObject(rootCause) ? rootCause : undefined;
    if (
      typeof cause?.statement !== "string" ||
      cause.statement.length === 0 ||
      !CONFIDENCES.has(cause.confidence)
    ) {
      throw contractError("diagnosis_invalid", "Diagnosis statement or confidence is invalid");
    }
    const evidenceIds = cause.evidenceIds;
    if (
      typeof cause.code !== "string" ||
      !ROOT_CAUSE_CODE_PATTERN.test(cause.code) ||
      cause.code === "unknown" ||
      !Array.isArray(evidenceIds) ||
      evidenceIds.length === 0 ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      evidenceIds.some((evidenceId) => !isUuid(evidenceId) || !evidenceById.has(evidenceId))
    ) {
      throw contractError(
        "diagnosis_evidence_links_invalid",
        "Diagnosis root causes do not reference persisted Run Evidence",
      );
    }
    diagnosisCodes.push(cause.code);
    for (const evidenceId of evidenceIds as string[]) {
      citedEvidenceKinds.add(evidenceById.get(evidenceId)!.evidenceKind);
    }
  }
  diagnosisCodes.sort();
  // The Runtime requires the target's identity Evidence to be cited and tells
  // the model so; the scenario's remaining kinds were never put to the model,
  // so they stay an observation rather than a gate.
  if (!citedEvidenceKinds.has(scenario.identityEvidence)) {
    throw contractError(
      "diagnosis_evidence_links_invalid",
      `Diagnosis does not reference ${scenario.identityEvidence}`,
    );
  }
  const repair = validateTerminalRepair(scenario, detail, evidenceById);
  return {
    evidenceKinds,
    // Collected and expected by the scenario, yet left out of every root cause.
    // The reviewer reading the diagnosis decides whether that weakens it.
    uncitedExpectedEvidence: scenario.requiredEvidence.filter((kind) => !citedEvidenceKinds.has(kind)),
    diagnosisCodes,
    repair,
  };
}

function validateInsufficientDiagnosis(scenario: EvaluationCase, detail: IncidentDetail): DiagnosisSummary {
  const diagnosis: unknown = detail.diagnosis;
  const incident: unknown = detail.incident;
  if (
    !isDiagnosisRun(detail) ||
    !isPlainObject(incident) ||
    incident.status !== "INSUFFICIENT_EVIDENCE" ||
    detail.repair !== null ||
    !Array.isArray(detail.evidence) ||
    !isPlainObject(diagnosis) ||
    typeof diagnosis.summary !== "string" ||
    diagnosis.summary.length === 0 ||
    !Array.isArray(diagnosis.rootCauses) ||
    diagnosis.rootCauses.length !== 0 ||
    !Array.isArray(diagnosis.missingInformation) ||
    diagnosis.missingInformation.length === 0 ||
    diagnosis.missingInformation.some((item) => !isNormalizedString(item))
  ) {
    throw contractError(
      "diagnosis_invalid",
      "The insufficient-evidence diagnosis did not satisfy the Runtime contract",
    );
  }
  const { evidenceKinds } = indexEvidence(scenario, detail);
  return {
    evidenceKinds,
    // Nothing is cited without a root cause; the reviewer judges whether stopping was right.
    uncitedExpectedEvidence: scenario.requiredEvidence.filter((kind) => evidenceKinds.includes(kind)),
    diagnosisCodes: [],
    repair: undefined,
  };
}

function validateFailedRun(scenario: EvaluationCase, detail: IncidentDetail): DiagnosisSummary {
  const run: unknown = detail.selectedRun;
  const incident: unknown = detail.incident;
  const error = isPlainObject(run) ? run.error : undefined;
  if (
    !isDiagnosisRun(detail) ||
    !isPlainObject(error) ||
    typeof error.retryable !== "boolean" ||
    !isPlainObject(incident) ||
    !FAILED_INCIDENT_STATUSES.has(String(incident.status)) ||
    detail.repair !== null ||
    !Array.isArray(detail.evidence) ||
    (detail.diagnosis !== null && !isPlainObject(detail.diagnosis))
  ) {
    throw contractError("run_failure_invalid", "The failed Run did not satisfy the Runtime contract");
  }
  const { evidenceKinds } = indexEvidence(scenario, detail);
  return {
    evidenceKinds,
    uncitedExpectedEvidence: scenario.requiredEvidence.filter((kind) => evidenceKinds.includes(kind)),
    diagnosisCodes: [],
    repair: undefined,
  };
}
