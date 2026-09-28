import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CAMPAIGN_ID_PATTERN,
  hasCatalogArtifactHeader,
  RECORD_LIMIT_BYTES,
  type Campaign,
  type CatalogArtifact,
  type OnlineArtifact,
} from "../contracts/records.ts";
import type { TrialPackageWriter } from "../lifecycle/review-package.ts";
import { contractError, invalidArguments } from "../shared/errors.ts";
import { isPlainObject } from "../shared/guards.ts";
import { readBoundedJson } from "../shared/json.ts";

export interface CampaignRequest {
  retryOf?: string;
}

export interface DatasetIdentity {
  id: string;
  version: number;
}

function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

// A campaign is named by its start instant plus a random suffix; a retry names the sibling
// record it continues, which must exist here and have evaluated the same dataset.
export async function planCampaign(
  request: CampaignRequest,
  profile: string,
  dataset: DatasetIdentity,
  startedAt: string,
  repositoryRoot: string,
  campaignSuffix: () => string = randomSuffix,
): Promise<Campaign> {
  const id = `${startedAt.replaceAll(/[-:]/g, "").replace(/\.[0-9]{3}Z$/, "Z")}-${campaignSuffix()}`;
  let retryOf: string | null = null;
  if (request.retryOf !== undefined) {
    if (!CAMPAIGN_ID_PATTERN.test(request.retryOf)) throw invalidArguments();
    const previous = await readCampaignArtifact(repositoryRoot, profile, request.retryOf);
    const campaign = isPlainObject(previous) && isPlainObject(previous.campaign) ? previous.campaign : undefined;
    const recorded = isPlainObject(previous) && isPlainObject(previous.dataset) ? previous.dataset : undefined;
    if (
      !hasCatalogArtifactHeader(previous) ||
      previous.profile !== profile ||
      campaign?.id !== request.retryOf ||
      recorded?.id !== dataset.id ||
      recorded?.version !== dataset.version
    ) {
      throw contractError(
        "evaluation_retry_target_invalid",
        "The campaign to retry is missing or evaluated a different dataset or profile",
      );
    }
    retryOf = request.retryOf;
  }
  return { id, startedAt, retryOf };
}

async function readCampaignArtifact(repositoryRoot: string, profile: string, id: string): Promise<unknown> {
  const read = await readBoundedJson(path.join(repositoryRoot, ".runtime", "evaluation", profile, `${id}.json`), RECORD_LIMIT_BYTES);
  return "value" in read ? read.value : undefined;
}

export async function writeEvaluationArtifact(
  repositoryRoot: string,
  profile: string,
  artifact: CatalogArtifact | OnlineArtifact,
): Promise<string> {
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if ("campaign" in artifact) {
    const campaignDirectory = await requireRecordDirectory(repositoryRoot, profile);
    const output = path.join(campaignDirectory, `${artifact.campaign.id}.json`);
    await writeExclusive(output, serialized);
    return output;
  }
  const directory = await requireRecordDirectory(repositoryRoot);
  const output = path.join(directory, `${profile}.json`);
  const temporary = path.join(directory, `.${profile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, output);
    await chmod(output, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return output;
}

export const writeTrialPackage: TrialPackageWriter = async (repositoryRoot, profile, campaignId, scenarioId, serialized) => {
  const directory = await requireRecordDirectory(repositoryRoot, profile, campaignId, "trials");
  await writeExclusive(path.join(directory, `${scenarioId}.json`), serialized);
  return path.posix.join("trials", `${scenarioId}.json`);
};

async function writeExclusive(file: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as { code?: string })?.code === "EEXIST") {
      throw contractError(
        "evaluation_artifact_exists",
        "An evaluation record with this identity already exists and is never overwritten",
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

// Every level under .runtime is created private and must be a real directory before anything is written below it.
async function requireRecordDirectory(repositoryRoot: string, ...segments: string[]): Promise<string> {
  let directory = path.join(repositoryRoot, ".runtime");
  await requireDirectoryNotSymlink(directory);
  await mkdir(directory, { mode: 0o700 }).catch((error: { code?: string }) => {
    if (error?.code !== "EEXIST") throw error;
  });
  for (const segment of ["evaluation", ...segments]) {
    directory = path.join(directory, segment);
    await mkdir(directory, { mode: 0o700 }).catch((error: { code?: string }) => {
      if (error?.code !== "EEXIST") throw error;
    });
    await requireDirectoryNotSymlink(directory);
    await chmod(directory, 0o700);
  }
  return directory;
}

async function requireDirectoryNotSymlink(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw contractError("artifact_directory_invalid", "Evaluation artifact directory is unsafe");
    }
  } catch (error) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }
}
