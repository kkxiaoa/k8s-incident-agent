import assert from "node:assert/strict";

import type { ReleaseManifest } from "../../../scripts/release.mjs";
import type { DeploymentStatusCheck, Execute, ScenarioRunner } from "../../src/environment/commands.ts";
import type { Tunnels } from "../../src/environment/tunnels.ts";
import type { HarnessCalls, HarnessContext } from "./harness.ts";

// kubectl as the evaluator drives it: scaling monitoring, listing and deleting fixed Pods,
// rotating the webhook credential; nothing else answers.
export function fakeExecute(context: HarnessContext, calls: HarnessCalls): Execute {
  return async (command, args) => {
    assert.equal(command, "kubectl");
    const { state, options } = context;
    const replicas = args.find((value) => value.startsWith("--replicas="));
    const deployment = args.find((value) => value.startsWith("deployment/"));
    if (replicas !== undefined && deployment !== undefined) {
      const available = replicas === "--replicas=1";
      if (deployment === "deployment/prometheus") state.prometheus = available;
      if (deployment === "deployment/kube-state-metrics") state.kubeStateMetrics = available;
    }
    if (args.includes("get") && args.includes("pods")) {
      const selector = args[args.indexOf("--selector") + 1];
      const name = selector.split("=").at(-1);
      return JSON.stringify({ apiVersion: "v1", kind: "List", items: [{ metadata: { name: `${name}-pod` } }] });
    }
    if (args.includes("delete") && args.includes("alertmanager-pod")) {
      calls.alertmanagerRestarts += 1;
      if (options.staleWatchdogAfterRotation !== true) state.watchdogLastReceivedAt = "2026-09-05T00:01:00.000Z";
    }
    if (args.includes("delete") && args.includes("agent-runtime-pod")) state.cookie = undefined;
    return "";
  };
}

export function fakeScenarioRunner(context: HarnessContext, calls: HarnessCalls, release: ReleaseManifest): ScenarioRunner {
  return async (action, scenarioId, dependencies) => {
    assert.deepEqual(dependencies?.release, release);
    const scenario = context.scenarioById.get(String(scenarioId));
    assert.ok(scenario);
    if (action === "apply") {
      calls.scenarioApply += 1;
      scenario.applied = true;
      scenario.resolved = false;
      scenario.repeated = false;
      scenario.updatedAt = "2026-09-05T00:00:00.000Z";
    } else if (action === "verify") {
      calls.scenarioVerify += 1;
      assert.equal(scenario.applied, true);
    } else if (action === "cleanup") {
      if (scenario.applied) scenario.resolved = true;
      scenario.applied = false;
    }
    return { status: "ok" };
  };
}

export function fakeDeploymentStatus(release: ReleaseManifest): DeploymentStatusCheck {
  return async (_profile, _context, dependencies) => {
    assert.deepEqual(dependencies?.release, release);
    return { deployments: "ready" };
  };
}

export function fakeTunnels(calls: HarnessCalls): () => Promise<Tunnels> {
  return async () => ({
    async restart() {
      calls.tunnelRestart += 1;
    },
    async close() {
      calls.tunnelClose += 1;
    },
  });
}
