import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  CAMPAIGN_ID_PATTERN,
  hasCatalogArtifactHeader,
  PACKAGE_PATH_PATTERN,
  RECORD_LIMIT_BYTES,
  REPORT_SCHEMA_VERSION,
  REVIEW_KEYS,
  REVIEW_PACKAGE_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  VERDICTS,
  type CampaignReport,
  type CatalogArtifact,
  type ReportScenario,
  type ReviewOutcome,
  type ReviewRecord,
  type Reviewer,
  type ScenarioResult,
  type Verdict,
} from "../contracts/records.ts";
import { contractError, type EvaluationErrorCode } from "../shared/errors.ts";
import { isUuid } from "../shared/guards.ts";
import { readBoundedJson } from "../shared/json.ts";

const MAX_CHAIN_LENGTH = 10;
const MAX_REVIEW_FILES = 200;

type ReviewFile = ReviewRecord & { file: string };

type PackageState =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "present"; evidenceIds: Set<string>; truncated: boolean };

// The report's own guards are looser than the evaluator's: reviews are hand-written files, so a
// bounded length matters more than control characters.
function isNormalizedText(value: unknown, limit = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readRecord(file: string, code: EvaluationErrorCode): Promise<unknown> {
  const read = await readBoundedJson(file, RECORD_LIMIT_BYTES);
  if ("value" in read) return read.value;
  const name = path.basename(file);
  const message = read.failure === "unreadable"
    ? `Cannot read ${name}`
    : read.failure === "unbounded"
      ? `${name} is not a bounded regular file`
      : `${name} is not valid JSON`;
  throw contractError(code, message);
}

function requireArtifact(artifact: unknown, file: string): CatalogArtifact {
  const campaign = isRecordObject(artifact) && isRecordObject(artifact.campaign) ? artifact.campaign : undefined;
  if (
    !hasCatalogArtifactHeader(artifact) ||
    campaign === undefined ||
    typeof campaign.id !== "string" ||
    !CAMPAIGN_ID_PATTERN.test(campaign.id) ||
    (campaign.retryOf !== null && (typeof campaign.retryOf !== "string" || !CAMPAIGN_ID_PATTERN.test(campaign.retryOf))) ||
    path.basename(file) !== `${campaign.id}.json` ||
    !isNormalizedText(artifact.profile) ||
    !isRecordObject(artifact.dataset) ||
    !Array.isArray(artifact.scenarios) ||
    !isRecordObject(artifact.coverage) ||
    !Array.isArray(artifact.coverage.mechanisms)
  ) {
    throw contractError("evaluation_artifact_invalid", `${path.basename(file)} is not a campaign record this report understands`);
  }
  return artifact as unknown as CatalogArtifact;
}

function requireReview(review: unknown, file: string): ReviewRecord {
  const candidate = isRecordObject(review) ? review : undefined;
  if (
    candidate === undefined ||
    JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify([...REVIEW_KEYS]) ||
    candidate.schemaVersion !== REVIEW_SCHEMA_VERSION ||
    typeof candidate.campaignId !== "string" ||
    !CAMPAIGN_ID_PATTERN.test(candidate.campaignId) ||
    !isNormalizedText(candidate.scenarioId, 128) ||
    !Number.isSafeInteger(candidate.trial) ||
    (candidate.trial as number) < 1 ||
    !isUuid(candidate.runId) ||
    !isNormalizedText(candidate.rulesVersion, 64) ||
    !isNormalizedText(candidate.reviewer, 64) ||
    !isNormalizedText(candidate.reviewedAt, 64) ||
    Number.isNaN(Date.parse(candidate.reviewedAt)) ||
    !(VERDICTS as readonly unknown[]).includes(candidate.verdict) ||
    !Array.isArray(candidate.reasons) ||
    candidate.reasons.length > 20 ||
    candidate.reasons.some((reason) => !isNormalizedText(reason, 1024)) ||
    !Array.isArray(candidate.evidenceIds) ||
    candidate.evidenceIds.length > 64 ||
    candidate.evidenceIds.some((id) => !isUuid(id))
  ) {
    throw contractError("evaluation_review_invalid", `${path.basename(file)} is not a valid review record`);
  }
  return candidate as unknown as ReviewRecord;
}

async function loadReviews(directory: string): Promise<ReviewFile[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return [];
    throw contractError("evaluation_review_invalid", "The reviews directory cannot be listed");
  }
  if (names.length > MAX_REVIEW_FILES) throw contractError("evaluation_review_invalid", "Too many review files");
  const reviews: ReviewFile[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const review = requireReview(await readRecord(file, "evaluation_review_invalid"), file);
    reviews.push({ ...review, file: name });
  }
  return reviews;
}

async function loadPackage(directory: string, result: ScenarioResult): Promise<PackageState> {
  if (typeof result.reviewPackage !== "string" || !PACKAGE_PATH_PATTERN.test(result.reviewPackage)) return { status: "missing" };
  const file = path.join(directory, result.reviewPackage);
  let record: unknown;
  try {
    record = await readRecord(file, "evaluation_review_package_invalid");
  } catch {
    // Nothing on disk means the package was never written; anything else there is a package the report cannot trust.
    return { status: await lstat(file).then(() => "invalid" as const, () => "missing" as const) };
  }
  const incident = isRecordObject(record) ? record.incident : undefined;
  if (
    !isRecordObject(record) ||
    record.schemaVersion !== REVIEW_PACKAGE_SCHEMA_VERSION ||
    record.scenarioId !== result.scenarioId ||
    record.runId !== result.runId ||
    !isRecordObject(incident) ||
    !Array.isArray(incident.evidence)
  ) {
    return { status: "invalid" };
  }
  return {
    status: "present",
    evidenceIds: new Set(incident.evidence.map((item) => (isRecordObject(item) ? item.id : undefined) as string)),
    truncated: record.truncated === true,
  };
}

function reviewOutcome(result: ScenarioResult, reviews: ReviewFile[], pkg: PackageState, campaignId: string, rulesAgree: boolean): ReviewOutcome {
  if (result.status === "not_run") return { status: "not_run" };
  const reviewers: Reviewer[] = reviews.map((review) => ({
    reviewer: review.reviewer, verdict: review.verdict, rulesVersion: review.rulesVersion, reviewedAt: review.reviewedAt, file: review.file,
  }));
  // No manual verdict promotes a Trial whose automated gates failed.
  if (result.status !== "pending_manual_review") return { status: "not_applicable", reviewers };
  if (reviews.length === 0) return { status: "pending_manual_review", reviewers };
  const reasons = new Set<string>();
  if (!rulesAgree) reasons.add("rules_version_mismatch");
  if (pkg.status === "missing") reasons.add("review_package_missing");
  if (pkg.status === "invalid") reasons.add("review_package_invalid");
  for (const review of reviews) {
    if (review.campaignId !== campaignId || review.trial !== result.trial?.index || review.runId !== result.runId) {
      reasons.add("trial_binding_mismatch");
    }
    if (pkg.status === "present" && review.evidenceIds.some((id) => !pkg.evidenceIds.has(id))) {
      reasons.add("evidence_not_in_package");
    }
  }
  if (reasons.size > 0) return { status: "incomplete", reasons: [...reasons].sort(), reviewers };
  const verdicts = new Set(reviews.map((review) => review.verdict));
  if (verdicts.size > 1) return { status: "disagreement", reviewers };
  return { status: reviews[0].verdict as Verdict, rulesVersion: reviews[0].rulesVersion, reviewers };
}

async function followChain(file: string, artifact: CatalogArtifact): Promise<CampaignReport["chain"]> {
  const campaigns = [artifact.campaign.id];
  let previous = artifact.campaign.retryOf;
  while (previous !== null && campaigns.length < MAX_CHAIN_LENGTH) {
    let record: unknown;
    try {
      record = await readRecord(path.join(path.dirname(file), `${previous}.json`), "evaluation_artifact_invalid");
    } catch {
      return { campaigns, complete: false };
    }
    const campaign = isRecordObject(record) && isRecordObject(record.campaign) ? record.campaign : undefined;
    if (campaign?.id !== previous || campaigns.includes(previous)) return { campaigns, complete: false };
    campaigns.push(previous);
    const next: unknown = campaign.retryOf ?? null;
    if (next !== null && (typeof next !== "string" || !CAMPAIGN_ID_PATTERN.test(next))) return { campaigns, complete: false };
    previous = next as string | null;
  }
  return { campaigns, complete: previous === null };
}

function count(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export async function buildCampaignReport(artifactPath: string): Promise<CampaignReport> {
  const file = path.resolve(artifactPath);
  const artifact = requireArtifact(await readRecord(file, "evaluation_artifact_invalid"), file);
  const directory = path.join(path.dirname(file), artifact.campaign.id);
  const reviews = await loadReviews(path.join(directory, "reviews"));
  // Scores taken under different rules cannot be aggregated, so one campaign holds one rules version.
  const rulesAgree = new Set(reviews.map((review) => review.rulesVersion)).size <= 1;
  const scenarios: ReportScenario[] = [];
  for (const result of artifact.scenarios) {
    const own = reviews.filter((review) => review.scenarioId === result.scenarioId);
    const pkg: PackageState = result.status === "not_run" ? { status: "missing" } : await loadPackage(directory, result);
    scenarios.push({
      scenarioId: result.scenarioId,
      mechanism: result.mechanism,
      expectedTerminal: result.expectedTerminal,
      automated: result.status,
      outcomeClass: result.outcomeClass,
      failure: result.failure ?? null,
      run: result.checks?.run ?? null,
      reviewPackage: pkg.status === "present" ? { truncated: pkg.truncated } : pkg.status,
      review: reviewOutcome(result, own, pkg, artifact.campaign.id, rulesAgree),
    });
  }
  const bound = reviews.filter((review) => artifact.scenarios.some((result) => result.scenarioId === review.scenarioId)).length;
  const reviewStatuses = scenarios.map((scenario) => scenario.review.status);
  const mechanisms = artifact.coverage.mechanisms.map((entry) => ({
    ...entry,
    review: count(scenarios.filter((scenario) => scenario.mechanism === entry.mechanism).map((scenario) => scenario.review.status)),
  }));
  const settled = scenarios.every((scenario) => !["pending_manual_review", "disagreement", "incomplete"].includes(scenario.review.status));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "campaign-report",
    campaign: artifact.campaign,
    chain: await followChain(file, artifact),
    profile: artifact.profile,
    dataset: artifact.dataset,
    release: { sourceRevision: artifact.release?.sourceRevision ?? null },
    scope: artifact.scope,
    automated: artifact.status,
    status: artifact.status === "failed" ? "failed" : settled ? "reviewed" : "pending_manual_review",
    outcomeClasses: count(scenarios.map((scenario) => scenario.outcomeClass)),
    review: { files: reviews.length, unbound: reviews.length - bound, statuses: count(reviewStatuses) },
    mechanisms,
    scenarios,
  };
}
