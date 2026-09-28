import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewPackage } from "../../src/contracts/records.ts";
import type { IncidentDetail } from "../../src/contracts/runtime-api.ts";
import { captureReviewPackage, type ReviewPackageCapture } from "../../src/lifecycle/review-package.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import type { ReadJson } from "../../src/shared/json.ts";
import { CAMPAIGN } from "./support.ts";

const INCIDENT = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";

function detail(padding = 0): IncidentDetail {
  return {
    schemaVersion: 5,
    incident: { id: INCIDENT, displayName: "x".repeat(padding) },
    selectedRun: { id: RUN },
    evidence: [],
    diagnosis: null,
    repair: null,
  } as unknown as IncidentDetail;
}

function capture(events: unknown[], writes: string[]): ReviewPackageCapture {
  const runtime: ReadJson = async () => ({ schemaVersion: 5, items: events, nextCursor: null });
  return {
    runtime,
    campaign: CAMPAIGN,
    profile: "kind-evaluation",
    repositoryRoot: "/repository",
    now: () => new Date("2026-09-05T00:00:00.000Z"),
    writeTrialPackage: async (repositoryRoot, profile, campaignId, scenarioId, serialized) => {
      assert.deepEqual([repositoryRoot, profile, campaignId, scenarioId], ["/repository", "kind-evaluation", CAMPAIGN.id, "crash-loop-backoff"]);
      writes.push(serialized);
      return `trials/${scenarioId}.json`;
    },
  };
}

test("the package is the compact serialization of the Incident projection and its Run events", async () => {
  const writes: string[] = [];
  const events = [{ id: "1", event: "incident.created", data: { schemaVersion: 5 } }];
  assert.equal(await captureReviewPackage("crash-loop-backoff", 1, detail(), capture(events, writes)), "trials/crash-loop-backoff.json");
  const expected: ReviewPackage = {
    schemaVersion: 1,
    campaignId: CAMPAIGN.id,
    scenarioId: "crash-loop-backoff",
    trial: 1,
    incidentId: INCIDENT,
    runId: RUN,
    capturedAt: "2026-09-05T00:00:00.000Z",
    incident: detail(),
    events: events as ReviewPackage["events"],
    truncated: false,
  };
  assert.deepEqual(JSON.parse(writes[0]), expected);
  assert.equal(writes[0].endsWith("\n"), true);
  assert.equal(writes[0].includes("\n  "), false);
});

test("an oversized event history is dropped and said so; an oversized projection is refused", async () => {
  const writes: string[] = [];
  const events = Array.from({ length: 3 }, (_, index) => ({ id: String(index + 1), event: "tool.started", data: { padding: "x".repeat(1_500_000) } }));
  await captureReviewPackage("crash-loop-backoff", 1, detail(), capture(events, writes));
  const record = JSON.parse(writes[0]);
  assert.deepEqual({ truncated: record.truncated, events: record.events }, { truncated: true, events: [] });
  assert.ok(Buffer.byteLength(writes[0]) <= 4 * 1024 * 1024);

  await assert.rejects(
    captureReviewPackage("crash-loop-backoff", 1, detail(4 * 1024 * 1024), capture([], [])),
    (error: unknown) => error instanceof EvaluationError && error.code === "upstream_contract_invalid",
  );
});
