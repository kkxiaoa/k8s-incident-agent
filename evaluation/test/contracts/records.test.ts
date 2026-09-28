import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CAMPAIGN_ID_PATTERN,
  CATALOG_ARTIFACT_SCHEMA_VERSION,
  hasCatalogArtifactHeader,
  ONLINE_ARTIFACT_SCHEMA_VERSION,
  PACKAGE_PATH_PATTERN,
  REPORT_SCHEMA_VERSION,
  REVIEW_KEYS,
  REVIEW_PACKAGE_SCHEMA_VERSION,
  VERDICTS,
} from "../../src/contracts/records.ts";

const GOLDEN_DIRECTORY = path.resolve(import.meta.dirname, "../fixtures/golden");

function golden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIRECTORY, `${name}.json`), "utf8"));
}

function keys(value: unknown): string[] {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.keys(value as object).sort();
}

const SCENARIO_KEYS = [
  "alertId", "checks", "cleanup", "expectedTerminal", "limitations", "mechanism", "outcomeClass", "reviewPackage",
  "scenarioId", "scenarioVersion", "sourceGroup", "split", "status", "trial",
];
const CHECK_KEYS = [
  "alertResolved", "alertmanagerFiring", "consoleDetail", "diagnosisCodes", "evidenceKinds", "fixtureVerified",
  "healthyBaseline", "healthyControls", "panels", "postResolutionPanelStates", "prometheusFiring",
  "repeatDeliveryDeduplicated", "uncitedExpectedEvidence", "uniqueIncident",
];
const CATALOG_KEYS = [
  "campaign", "completedAt", "coverage", "dataset", "families", "kind", "profile", "release", "scenarios",
  "schemaVersion", "scope", "selectedScenarioIds", "startedAt", "status",
];

test("the golden fixtures cover every record kind the module declares", () => {
  assert.deepEqual(readdirSync(GOLDEN_DIRECTORY).sort(), [
    "catalog-aborted.json",
    "catalog-focused.json",
    "catalog-full.json",
    "catalog-terminal-failed.json",
    "catalog-terminal-insufficient_evidence.json",
    "catalog-terminal-mismatch.json",
    "online.json",
    "report-pending.json",
    "report-reviewed.json",
    "review-package.json",
  ]);
});

test("catalog artifacts carry the declared header, campaign identity and result layout", () => {
  for (const name of ["catalog-full", "catalog-focused", "catalog-terminal-failed", "catalog-terminal-insufficient_evidence", "catalog-terminal-mismatch"]) {
    const artifact = golden(name);
    assert.ok(hasCatalogArtifactHeader(artifact), name);
    assert.deepEqual(keys(artifact), [...CATALOG_KEYS, "monitoring"].sort(), name);
    const campaign = artifact.campaign as Record<string, unknown>;
    assert.match(String(campaign.id), CAMPAIGN_ID_PATTERN);
    assert.equal(campaign.retryOf, null);
    for (const result of artifact.scenarios as Array<Record<string, unknown>>) {
      const own = keys(result).filter((key) => !["failure", "incidentId", "reason", "runId"].includes(key));
      assert.deepEqual(own, SCENARIO_KEYS, `${name}:${result.scenarioId}`);
      const checks = result.checks as Record<string, unknown>;
      const defined = keys(checks).filter((key) => !["repair", "run", "sseReplay"].includes(key));
      assert.deepEqual(defined, CHECK_KEYS, `${name}:${result.scenarioId}`);
      if (result.status === "not_run") {
        assert.equal(result.trial, null);
        assert.ok(["not_selected", "profile_not_supported"].includes(String(result.reason)));
      } else {
        assert.match(String(result.reviewPackage), PACKAGE_PATH_PATTERN);
        assert.equal(typeof result.trial, "object");
      }
    }
  }
  const aborted = golden("catalog-aborted");
  assert.ok(hasCatalogArtifactHeader(aborted));
  assert.deepEqual(keys(aborted), [...CATALOG_KEYS, "failure"].sort());
  assert.equal(aborted.status, "failed");
  assert.ok((aborted.scenarios as Array<Record<string, unknown>>).every((result) => result.reason === "evaluation_aborted"));
  assert.equal(hasCatalogArtifactHeader({ kind: "catalog-evaluation", schemaVersion: CATALOG_ARTIFACT_SCHEMA_VERSION - 1 }), false);
  assert.equal(hasCatalogArtifactHeader(golden("online")), false);
});

test("the online artifact, review package and reports keep their schema versions and key sets", () => {
  const online = golden("online");
  assert.equal(online.schemaVersion, ONLINE_ARTIFACT_SCHEMA_VERSION);
  assert.deepEqual(keys(online), ["checks", "completedAt", "kind", "profile", "release", "schemaVersion", "startedAt", "status"]);
  assert.deepEqual(keys(online.checks), ["anonymousRerunDenied", "authenticatedRerun", "manualConsoleCreationAbsent", "manualCreationAbsent", "readRoutesAvailable"]);

  const pkg = golden("review-package");
  assert.equal(pkg.schemaVersion, REVIEW_PACKAGE_SCHEMA_VERSION);
  assert.deepEqual(keys(pkg), ["campaignId", "capturedAt", "events", "incident", "incidentId", "runId", "scenarioId", "schemaVersion", "trial", "truncated"]);
  assert.equal((pkg.incident as Record<string, unknown>).schemaVersion, 5);

  for (const name of ["report-pending", "report-reviewed"]) {
    const report = golden(name);
    assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
    assert.equal(report.kind, "campaign-report");
    assert.deepEqual(keys(report), ["automated", "campaign", "chain", "dataset", "kind", "mechanisms", "outcomeClasses", "profile", "release", "review", "scenarios", "schemaVersion", "scope", "status"]);
    for (const scenario of report.scenarios as Array<Record<string, unknown>>) {
      assert.deepEqual(keys(scenario), ["automated", "expectedTerminal", "failure", "mechanism", "outcomeClass", "review", "reviewPackage", "run", "scenarioId"]);
    }
  }
  const reviewed = golden("report-reviewed").scenarios as Array<{ review: { status: string } }>;
  assert.ok((VERDICTS as readonly string[]).includes(reviewed[0].review.status));
  assert.deepEqual([...REVIEW_KEYS], [...REVIEW_KEYS].sort());
});
