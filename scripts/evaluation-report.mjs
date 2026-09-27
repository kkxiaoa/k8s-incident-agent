// Reads one evaluation campaign's records together with the maintainer's review files and
// reports what they establish. It runs no command and writes nothing.
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACT_SCHEMA_VERSION = 4;
const REVIEW_SCHEMA_VERSION = 1;
const REPORT_SCHEMA_VERSION = 1;
const RECORD_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_CHAIN_LENGTH = 10;
const MAX_REVIEW_FILES = 200;
const CAMPAIGN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE_PATH_PATTERN = /^trials\/[a-z0-9-]+\.json$/;
const VERDICTS = new Set(["pass", "fail", "insufficient_to_score"]);
const REVIEW_KEYS = [
  "campaignId", "evidenceIds", "reasons", "reviewedAt", "reviewer", "rulesVersion", "runId", "scenarioId", "schemaVersion",
  "trial", "verdict",
];

export class EvaluationReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvaluationReportError";
    this.code = code;
  }
}

function reportError(code, message) {
  return new EvaluationReportError(code, message);
}

function isNormalizedString(value, limit = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readRecord(file, code) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw reportError(code, `Cannot read ${path.basename(file)}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > RECORD_LIMIT_BYTES) {
      throw reportError(code, `${path.basename(file)} is not a bounded regular file`);
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof EvaluationReportError) throw error;
    throw reportError(code, `${path.basename(file)} is not valid JSON`);
  } finally {
    await handle.close();
  }
}

function requireArtifact(artifact, file) {
  if (
    !isPlainObject(artifact) ||
    artifact.kind !== "catalog-evaluation" ||
    artifact.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
    !isPlainObject(artifact.campaign) ||
    !CAMPAIGN_ID_PATTERN.test(artifact.campaign.id ?? "") ||
    (artifact.campaign.retryOf !== null && !CAMPAIGN_ID_PATTERN.test(artifact.campaign.retryOf ?? "")) ||
    path.basename(file) !== `${artifact.campaign.id}.json` ||
    !isNormalizedString(artifact.profile) ||
    !isPlainObject(artifact.dataset) ||
    !Array.isArray(artifact.scenarios) ||
    !isPlainObject(artifact.coverage) ||
    !Array.isArray(artifact.coverage.mechanisms)
  ) {
    throw reportError(
      "evaluation_artifact_invalid",
      `${path.basename(file)} is not a campaign record this report understands`,
    );
  }
}

function requireReview(review, file) {
  if (
    !isPlainObject(review) ||
    JSON.stringify(Object.keys(review).sort()) !== JSON.stringify(REVIEW_KEYS) ||
    review.schemaVersion !== REVIEW_SCHEMA_VERSION ||
    !CAMPAIGN_ID_PATTERN.test(review.campaignId ?? "") ||
    !isNormalizedString(review.scenarioId, 128) ||
    !Number.isSafeInteger(review.trial) || review.trial < 1 ||
    !UUID_PATTERN.test(review.runId ?? "") ||
    !isNormalizedString(review.rulesVersion, 64) ||
    !isNormalizedString(review.reviewer, 64) ||
    !isNormalizedString(review.reviewedAt, 64) || Number.isNaN(Date.parse(review.reviewedAt)) ||
    !VERDICTS.has(review.verdict) ||
    !Array.isArray(review.reasons) || review.reasons.length > 20 ||
    review.reasons.some((reason) => !isNormalizedString(reason, 1024)) ||
    !Array.isArray(review.evidenceIds) || review.evidenceIds.length > 64 ||
    review.evidenceIds.some((id) => !UUID_PATTERN.test(id ?? ""))
  ) {
    throw reportError("evaluation_review_invalid", `${path.basename(file)} is not a valid review record`);
  }
}

async function loadReviews(directory) {
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw reportError("evaluation_review_invalid", "The reviews directory cannot be listed");
  }
  if (names.length > MAX_REVIEW_FILES) throw reportError("evaluation_review_invalid", "Too many review files");
  const reviews = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const review = await readRecord(file, "evaluation_review_invalid");
    requireReview(review, file);
    reviews.push({ ...review, file: name });
  }
  return reviews;
}

async function loadPackage(directory, result) {
  if (!PACKAGE_PATH_PATTERN.test(result.reviewPackage ?? "")) return { status: "missing" };
  const file = path.join(directory, result.reviewPackage);
  let record;
  try {
    record = await readRecord(file, "evaluation_review_package_invalid");
  } catch {
    // Nothing on disk means the package was never written; anything else there is a package the report cannot trust.
    return { status: await lstat(file).then(() => "invalid", () => "missing") };
  }
  if (
    !isPlainObject(record) ||
    record.schemaVersion !== 1 ||
    record.scenarioId !== result.scenarioId ||
    record.runId !== result.runId ||
    !isPlainObject(record.incident) ||
    !Array.isArray(record.incident.evidence)
  ) {
    return { status: "invalid" };
  }
  return {
    status: "present",
    evidenceIds: new Set(record.incident.evidence.map((item) => item?.id)),
    truncated: record.truncated === true,
  };
}

function reviewOutcome(result, reviews, pkg, campaignId, rulesAgree) {
  if (result.status === "not_run") return { status: "not_run" };
  const reviewers = reviews.map((review) => ({
    reviewer: review.reviewer, verdict: review.verdict, rulesVersion: review.rulesVersion, reviewedAt: review.reviewedAt, file: review.file,
  }));
  // No manual verdict promotes a Trial whose automated gates failed.
  if (result.status !== "pending_manual_review") return { status: "not_applicable", reviewers };
  if (reviews.length === 0) return { status: "pending_manual_review", reviewers };
  const reasons = new Set();
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
  return { status: reviews[0].verdict, rulesVersion: reviews[0].rulesVersion, reviewers };
}

async function followChain(file, artifact) {
  const campaigns = [artifact.campaign.id];
  let previous = artifact.campaign.retryOf;
  while (previous !== null && campaigns.length < MAX_CHAIN_LENGTH) {
    let record;
    try {
      record = await readRecord(path.join(path.dirname(file), `${previous}.json`), "evaluation_artifact_invalid");
    } catch {
      return { campaigns, complete: false };
    }
    if (!isPlainObject(record) || record.campaign?.id !== previous || campaigns.includes(previous)) {
      return { campaigns, complete: false };
    }
    campaigns.push(previous);
    previous = record.campaign.retryOf ?? null;
    if (previous !== null && !CAMPAIGN_ID_PATTERN.test(previous)) return { campaigns, complete: false };
  }
  return { campaigns, complete: previous === null };
}

function count(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export async function buildCampaignReport(artifactPath) {
  const file = path.resolve(artifactPath);
  const artifact = await readRecord(file, "evaluation_artifact_invalid");
  requireArtifact(artifact, file);
  const directory = path.join(path.dirname(file), artifact.campaign.id);
  const reviews = await loadReviews(path.join(directory, "reviews"));
  // Scores taken under different rules cannot be aggregated, so one campaign holds one rules version.
  const rulesAgree = new Set(reviews.map((review) => review.rulesVersion)).size <= 1;
  const scenarios = [];
  for (const result of artifact.scenarios) {
    const own = reviews.filter((review) => review.scenarioId === result.scenarioId);
    const pkg = result.status === "not_run" ? { status: "missing" } : await loadPackage(directory, result);
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

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  try {
    const [artifactPath, ...rest] = process.argv.slice(2);
    if (!isNormalizedString(artifactPath, 4096) || artifactPath.startsWith("-") || rest.length > 0) {
      throw reportError("invalid_arguments", "Usage: evaluation-report.mjs <campaign-artifact.json>");
    }
    process.stdout.write(`${JSON.stringify(await buildCampaignReport(artifactPath), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof EvaluationReportError ? error.code : "evaluation_report_failed";
    const message = error instanceof EvaluationReportError ? error.message : "The report could not be produced";
    console.error(`FAIL ${code} ${message}`);
    process.exitCode = 1;
  }
}
