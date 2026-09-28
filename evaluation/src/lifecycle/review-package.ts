import type { Campaign, ReviewPackage } from "../contracts/records.ts";
import { RECORD_LIMIT_BYTES, REVIEW_PACKAGE_SCHEMA_VERSION } from "../contracts/records.ts";
import { readRunEvents, type IncidentDetail } from "../contracts/runtime-api.ts";
import { upstreamContractError } from "../shared/errors.ts";
import { requireDate } from "../shared/guards.ts";
import type { ReadJson } from "../shared/json.ts";

// Writes one Trial's serialized package and returns the path recorded in the result.
export type TrialPackageWriter = (
  repositoryRoot: string,
  profile: string,
  campaignId: string,
  scenarioId: string,
  serialized: string,
) => Promise<string>;

export interface ReviewPackageCapture {
  runtime: ReadJson;
  campaign: Campaign;
  profile: string;
  repositoryRoot: string;
  now: () => Date;
  writeTrialPackage: TrialPackageWriter;
}

function serializeReviewPackage(record: ReviewPackage): string {
  return `${JSON.stringify(record)}\n`;
}

// The reviewer's material is the Runtime's own safety projection of the Incident and the
// Run's event history, captured through the session that ran the Trial; nothing is added.
export async function captureReviewPackage(
  scenarioId: string,
  trialIndex: number,
  detail: IncidentDetail,
  capture: ReviewPackageCapture,
): Promise<string> {
  const { events, truncated } = await readRunEvents(capture.runtime, detail.incident.id, detail.selectedRun.id);
  const record: ReviewPackage = {
    schemaVersion: REVIEW_PACKAGE_SCHEMA_VERSION,
    campaignId: capture.campaign.id,
    scenarioId,
    trial: trialIndex,
    incidentId: detail.incident.id,
    runId: detail.selectedRun.id,
    capturedAt: requireDate(capture.now()).toISOString(),
    incident: detail,
    events,
    truncated,
  };
  // The bound applies to the exact bytes the package writer receives.
  let serialized = serializeReviewPackage(record);
  if (Buffer.byteLength(serialized) > RECORD_LIMIT_BYTES) {
    record.events = [];
    record.truncated = true;
    serialized = serializeReviewPackage(record);
  }
  // A bounded detail projection fits without its events; more than that is not the Runtime this evaluator verified.
  if (Buffer.byteLength(serialized) > RECORD_LIMIT_BYTES) throw upstreamContractError();
  return capture.writeTrialPackage(capture.repositoryRoot, capture.profile, capture.campaign.id, scenarioId, serialized);
}
