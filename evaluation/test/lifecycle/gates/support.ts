import assert from "node:assert/strict";

import { loadEvaluationDataset, type EvaluationCase, type ExpectedTerminal } from "../../../src/contracts/dataset.ts";
import {
  decodeSseFrame,
  readIncident,
  readIncidentSummaries,
  splitSseFrames,
  type IncidentDetail,
  type RunEvent,
} from "../../../src/contracts/runtime-api.ts";
import { bindJsonReader, readEventStream } from "../../../src/environment/http.ts";
import { operatorFetch } from "../../../src/environment/operator-session.ts";
import { endpointOrigin } from "../../../src/environment/tunnels.ts";
import { EvaluationError } from "../../../src/shared/errors.ts";
import { REPOSITORY_ROOT } from "../../support/fixtures.ts";
import { createHarness, type HarnessOptions } from "../../support/harness.ts";

export interface Trial {
  scenario: EvaluationCase;
  detail: IncidentDetail;
  events: RunEvent[];
}

const catalogCases = () => {
  const harness = createHarness();
  return loadEvaluationDataset(REPOSITORY_ROOT, harness.dependencies.scenarios).cases;
};

export function caseFor(scenarioId: string, expectedTerminal?: ExpectedTerminal): EvaluationCase {
  const entry = catalogCases().find((candidate) => candidate.scenarioId === scenarioId);
  assert.ok(entry, scenarioId);
  return expectedTerminal === undefined ? entry : { ...entry, expectedTerminal };
}

// One Trial's inputs exactly as the campaign will read them: the fake Runtime's Incident detail
// after the fixture is applied, and its persisted event replay.
export async function trialFor(scenarioId: string, options: HarnessOptions = {}, expectedTerminal?: ExpectedTerminal): Promise<Trial> {
  const harness = createHarness(options);
  await harness.dependencies.runScenarioCommand("apply", scenarioId, { release: harness.release.manifest });
  const authenticated = await operatorFetch(harness.dependencies.fetch, "kind-evaluation", harness.dependencies.environment);
  const runtime = endpointOrigin("runtime");
  const read = bindJsonReader(authenticated, runtime);
  const [incidentId] = [...(await readIncidentSummaries(read)).keys()];
  const detail = await readIncident(read, incidentId);
  const frames: string[] = [];
  let rest = "";
  await readEventStream(authenticated, runtime, `/api/v1/incidents/${incidentId}/events`, (chunk) => {
    const split = splitSseFrames(rest + chunk);
    frames.push(...split.frames);
    rest = split.rest;
    return false;
  });
  let previous: string | undefined;
  const events = frames.map((frame) => {
    const event = decodeSseFrame(frame, { incidentId, runId: detail.selectedRun.id }, previous);
    previous = event.id;
    return event;
  });
  return { scenario: caseFor(scenarioId, expectedTerminal), detail, events };
}

export function coded(code: string, message?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof EvaluationError, String(error));
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  };
}
