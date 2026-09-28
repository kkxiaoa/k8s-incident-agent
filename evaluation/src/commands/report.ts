import type { CampaignReport } from "../contracts/records.ts";
import { buildCampaignReport } from "../review/report.ts";
import { invalidArguments } from "../shared/errors.ts";
import { isNormalizedString } from "../shared/guards.ts";

const MAX_PATH_LENGTH = 4096;

// Reads one campaign's records and reports what they establish; it runs no command and writes nothing.
export async function runReportCommand(artifactPath: unknown): Promise<CampaignReport> {
  if (!isNormalizedString(artifactPath) || artifactPath.length > MAX_PATH_LENGTH || artifactPath.startsWith("-")) {
    throw invalidArguments();
  }
  return buildCampaignReport(artifactPath);
}
