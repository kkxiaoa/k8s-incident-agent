import assert from "node:assert/strict";
import test from "node:test";

import {
  requireConsoleIncidentIdentity,
  requireConsoleIncidentPage,
  requireOnlineHomePage,
} from "../../src/contracts/console.ts";
import { EvaluationError } from "../../src/shared/errors.ts";

const INCIDENT = "10000000-0000-4000-8000-000000000001";

function coded(code: string) {
  return (error: unknown) => error instanceof EvaluationError && error.code === code;
}

test("the Console identity comes from the Runtime detail and must be stable text", () => {
  const detail = { incident: { id: INCIDENT, displayName: "CrashLoop", target: { name: "crash-loop-backoff" } } };
  assert.deepEqual(requireConsoleIncidentIdentity(detail), { incidentId: INCIDENT, displayName: "CrashLoop", targetName: "crash-loop-backoff" });
  for (const bad of [
    { incident: { id: "1", displayName: "CrashLoop", target: { name: "x" } } },
    { incident: { id: INCIDENT, displayName: " CrashLoop", target: { name: "x" } } },
    { incident: { id: INCIDENT, displayName: "CrashLoop", target: {} } },
    { incident: null },
    undefined,
  ]) {
    assert.throws(() => requireConsoleIncidentIdentity(bad), coded("upstream_contract_invalid"));
  }
});

test("the Incident page must contain the id, display name and target name, not just an echo", () => {
  const identity = { incidentId: INCIDENT, displayName: "CrashLoop", targetName: "crash-loop-backoff" };
  assert.doesNotThrow(() => requireConsoleIncidentPage(`<h1>CrashLoop</h1><p>${INCIDENT}</p><span>crash-loop-backoff</span>`, identity));
  assert.throws(() => requireConsoleIncidentPage(INCIDENT, identity), coded("console_incident_incomplete"));
  assert.throws(() => requireConsoleIncidentPage(`${INCIDENT} CrashLoop`, identity), coded("console_incident_incomplete"));
  assert.throws(() => requireConsoleIncidentPage(`${INCIDENT} crash-loop-backoff`, identity), coded("console_incident_incomplete"));
  assert.throws(() => requireConsoleIncidentPage("CrashLoop crash-loop-backoff", identity), coded("console_incident_incomplete"));
});

test("the online home page must not expose a manual intake control", () => {
  assert.doesNotThrow(() => requireOnlineHomePage("K8s Incident Agent 重新诊断"));
  assert.throws(() => requireOnlineHomePage("<a>离线评估入口</a>"), coded("online_console_invalid"));
  assert.throws(() => requireOnlineHomePage("<button>创建 Incident</button>"), coded("online_console_invalid"));
});
