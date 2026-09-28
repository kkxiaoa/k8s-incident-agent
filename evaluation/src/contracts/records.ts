import type { ReleaseManifest } from "../../../scripts/release.mjs";
import type { SafeFailure } from "../shared/errors.ts";
import { isPlainObject } from "../shared/guards.ts";
import type { DatasetSplit, ExecutionProfile, ExpectedTerminal } from "./dataset.ts";
import type { components } from "./runtime-api.generated.ts";
import type { IncidentDetail, RunEvent } from "./runtime-api.ts";

type Schemas = components["schemas"];

export const CATALOG_ARTIFACT_SCHEMA_VERSION = 4;
export const ONLINE_ARTIFACT_SCHEMA_VERSION = 2;
export const REVIEW_PACKAGE_SCHEMA_VERSION = 1;
export const REVIEW_SCHEMA_VERSION = 1;
export const REPORT_SCHEMA_VERSION = 1;
// One bound for what the evaluator writes per Trial and for any record it reads back.
export const RECORD_LIMIT_BYTES = 4 * 1024 * 1024;
export const CAMPAIGN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
export const PACKAGE_PATH_PATTERN = /^trials\/[a-z0-9-]+\.json$/;
export const VERDICTS = ["pass", "fail", "insufficient_to_score"] as const;
export const REVIEW_KEYS = [
  "campaignId",
  "evidenceIds",
  "reasons",
  "reviewedAt",
  "reviewer",
  "rulesVersion",
  "runId",
  "scenarioId",
  "schemaVersion",
  "trial",
  "verdict",
] as const;

export type Verdict = (typeof VERDICTS)[number];
export type ScenarioStatus = "pending_manual_review" | "failed" | "not_run";
export type OutcomeClass =
  | "infrastructure_invalid"
  | "intake_failed"
  | "run_not_terminal"
  | "outcome_mismatch"
  | "contract_failed"
  | "pending_manual_review"
  | "not_run";
export type NotRunReason = "not_selected" | "profile_not_supported" | "evaluation_aborted";

export interface Campaign {
  id: string;
  startedAt: string;
  retryOf: string | null;
}

export interface Trial {
  index: number;
  startedAt: string;
  completedAt: string | null;
}

// The Runtime's own terminal values, kept before any expectation is applied to them.
export interface ObservedRun {
  attempt: number;
  status: Schemas["RunStatus"];
  errorCode: string | null;
  retryable: boolean | null;
  outcome: Schemas["DiagnosisOutcome"] | null;
}

export interface PanelCheck {
  panelId: string;
  signalRole: Schemas["MetricPanelSignalRole"];
  state: Schemas["MetricQueryState"];
  window: Schemas["MetricWindow"];
}

export interface PanelState {
  panelId: string;
  state: Schemas["MetricQueryState"];
}

export interface SseReplayCheck {
  events: number;
  eventTypes: string[];
  finalCursorMatched: true;
}

export interface RepairCheck {
  action: "set_container_image";
  proposalDigest: string;
  validation: "passed";
  terminalStatus: "WAITING_APPROVAL";
}

export interface ScenarioChecks {
  healthyBaseline: boolean;
  fixtureVerified: boolean;
  prometheusFiring: boolean;
  alertmanagerFiring: boolean;
  healthyControls: boolean;
  uniqueIncident: boolean;
  run: ObservedRun | undefined;
  evidenceKinds: string[];
  uncitedExpectedEvidence: string[];
  diagnosisCodes: string[];
  panels: PanelCheck[];
  sseReplay: SseReplayCheck | undefined;
  consoleDetail: boolean;
  repair: RepairCheck | undefined;
  repeatDeliveryDeduplicated: boolean;
  alertResolved: boolean;
  postResolutionPanelStates: PanelState[];
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioVersion: number;
  split: DatasetSplit;
  mechanism: string;
  sourceGroup: string;
  expectedTerminal: ExpectedTerminal;
  limitations: string[];
  alertId: string;
  status: ScenarioStatus;
  outcomeClass: OutcomeClass;
  cleanup: "passed" | "failed" | "not_run";
  reviewPackage: string | null;
  trial: Trial | null;
  checks: ScenarioChecks;
  incidentId?: string;
  runId?: string;
  failure?: SafeFailure;
  reason?: NotRunReason;
}

export interface InfrastructureChecks {
  kubeStateMetricsStale: boolean;
  prometheusUnavailable: boolean;
  secretRotation: boolean;
  workloadRecovery: boolean;
  persistedIncidentReplay: boolean;
}

export type InfrastructureResult =
  | { status: "not_run"; reason: "focused_evaluation" | "no_scenario_passed" }
  | { status: "failed"; failureCode: "panel_probe_unavailable" | "incident_probe_unavailable" }
  | { status: "failed"; failure: SafeFailure }
  | { status: "passed"; checks: InfrastructureChecks };

export interface FamilyCoverage {
  familyId: string;
  scenarios: number;
  status: ScenarioStatus;
}

export interface MechanismCoverage {
  mechanism: string;
  cases: number;
  status: ScenarioStatus;
}

export interface CoverageReport {
  families: FamilyCoverage[];
  coverage: { plannedCases: number; notRunCases: number; mechanisms: MechanismCoverage[] };
  scenarios: ScenarioResult[];
}

export interface CatalogArtifact extends CoverageReport {
  schemaVersion: typeof CATALOG_ARTIFACT_SCHEMA_VERSION;
  kind: "catalog-evaluation";
  profile: ExecutionProfile;
  release: ReleaseManifest;
  startedAt: string;
  completedAt: string;
  status: "pending_manual_review" | "failed";
  scope: "focused" | "full";
  selectedScenarioIds: string[];
  dataset: { id: string; version: number };
  campaign: Campaign;
  monitoring?: { initialState: Schemas["MonitoringOverallState"]; infrastructure: InfrastructureResult };
  failure?: SafeFailure;
}

export interface OnlineChecks {
  readRoutesAvailable: true;
  manualCreationAbsent: true;
  manualConsoleCreationAbsent: true;
  anonymousRerunDenied: true;
  authenticatedRerun: "accepted" | "active_run_exists" | "diagnosis_unavailable";
}

export interface OnlineArtifact {
  schemaVersion: typeof ONLINE_ARTIFACT_SCHEMA_VERSION;
  kind: "online-boundary-evaluation";
  profile: "k3s-public";
  release: ReleaseManifest;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  checks?: OnlineChecks;
  failure?: SafeFailure;
}

export interface ReviewPackage {
  schemaVersion: typeof REVIEW_PACKAGE_SCHEMA_VERSION;
  campaignId: string;
  scenarioId: string;
  trial: number;
  incidentId: string;
  runId: string;
  capturedAt: string;
  incident: IncidentDetail;
  events: RunEvent[];
  truncated: boolean;
}

export interface ReviewRecord {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  campaignId: string;
  scenarioId: string;
  trial: number;
  runId: string;
  rulesVersion: string;
  reviewer: string;
  reviewedAt: string;
  verdict: Verdict;
  reasons: string[];
  evidenceIds: string[];
}

export interface Reviewer {
  reviewer: string;
  verdict: Verdict;
  rulesVersion: string;
  reviewedAt: string;
  file: string;
}

export type ReviewOutcome =
  | { status: "not_run" }
  | { status: "not_applicable" | "pending_manual_review" | "disagreement"; reviewers: Reviewer[] }
  | { status: "incomplete"; reasons: string[]; reviewers: Reviewer[] }
  | { status: Verdict; rulesVersion: string; reviewers: Reviewer[] };

export interface ReportScenario {
  scenarioId: string;
  mechanism: string;
  expectedTerminal: ExpectedTerminal;
  automated: ScenarioStatus;
  outcomeClass: OutcomeClass;
  failure: SafeFailure | null;
  run: ObservedRun | null;
  reviewPackage: { truncated: boolean } | "missing" | "invalid";
  review: ReviewOutcome;
}

export interface CampaignReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  kind: "campaign-report";
  campaign: Campaign;
  chain: { campaigns: string[]; complete: boolean };
  profile: ExecutionProfile;
  dataset: { id: string; version: number };
  release: { sourceRevision: string | null };
  scope: "focused" | "full";
  automated: "pending_manual_review" | "failed";
  status: "failed" | "reviewed" | "pending_manual_review";
  outcomeClasses: Record<string, number>;
  review: { files: number; unbound: number; statuses: Record<string, number> };
  mechanisms: Array<MechanismCoverage & { review: Record<string, number> }>;
  scenarios: ReportScenario[];
}

// The header every reader of a campaign record checks before trusting anything else in it.
export function hasCatalogArtifactHeader(
  value: unknown,
): value is Record<string, unknown> & Pick<CatalogArtifact, "kind" | "schemaVersion"> {
  return (
    isPlainObject(value) &&
    value.kind === "catalog-evaluation" &&
    value.schemaVersion === CATALOG_ARTIFACT_SCHEMA_VERSION
  );
}
