import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { load } from "js-yaml";

import { runScenarioCommand } from "./scenario.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCENARIO_ID = "image-pull-backoff";
const CLUSTER_NAME = "k8s-incident-agent";
const CONTEXT_NAME = "kind-k8s-incident-agent";
const NAMESPACE = "k8s-incident-scenarios";
const NODE_IMAGE =
  "kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";

function validScenario() {
  return {
    schema_version: 1,
    scenario_id: SCENARIO_ID,
    scenario_version: 1,
    display_name: "Image pull failure",
    description: "A Deployment cannot pull its configured image.",
    trigger: {
      type: "manual",
      summary: "The target Deployment is unavailable.",
    },
    target: {
      cluster: CLUSTER_NAME,
      namespace: NAMESPACE,
      api_version: "apps/v1",
      kind: "Deployment",
      name: SCENARIO_ID,
    },
    fixture_manifests: ["manifests/deployment.yaml"],
    expected_root_causes: ["image_pull_failure"],
    required_evidence: [
      "workload_image",
      "pod_waiting_state",
      "warning_event",
    ],
    allowed_tools: ["get_workload", "get_pods", "get_events"],
    forbidden_tools: ["get_logs", "apply_patch", "execute_shell"],
    deterministic_verifier: {
      kind: "image_pull_backoff",
      timeout_seconds: 120,
      poll_interval_seconds: 2,
    },
  };
}

function validManifest(overrides = {}) {
  const apiVersion = overrides.apiVersion ?? "apps/v1";
  const kind = overrides.kind ?? "Deployment";
  const name = overrides.name ?? SCENARIO_ID;
  const namespace = overrides.namespace ?? NAMESPACE;
  const selector = overrides.selector ?? `matchLabels:\n      app: ${SCENARIO_ID}`;
  return `apiVersion: ${apiVersion}
kind: ${kind}
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  replicas: 1
  selector:
    ${selector}
  template:
    metadata:
      labels:
        app: ${SCENARIO_ID}
    spec:
      containers:
        - name: workload
          image: registry.invalid/k8s-incident-agent/missing:v1
          imagePullPolicy: Always
`;
}

function createCatalog(t, options = {}) {
  const catalogDirectory = mkdtempSync(
    path.join(os.tmpdir(), "k8s-incident-agent-scenario-test-"),
  );
  t.after(async () => {
    await rm(catalogDirectory, { recursive: true, force: true });
  });
  const scenarioDirectory = path.join(catalogDirectory, SCENARIO_ID);
  const manifestDirectory = path.join(scenarioDirectory, "manifests");
  mkdirSync(manifestDirectory, { recursive: true });

  const scenario = options.scenario ?? validScenario();
  writeFileSync(
    path.join(scenarioDirectory, "scenario.json"),
    JSON.stringify(scenario),
  );
  const manifestPath = path.join(manifestDirectory, "deployment.yaml");
  if (options.symlinkManifest) {
    const externalManifest = path.join(catalogDirectory, "external.yaml");
    writeFileSync(externalManifest, options.manifest ?? validManifest());
    symlinkSync(externalManifest, manifestPath);
  } else {
    writeFileSync(manifestPath, options.manifest ?? validManifest());
  }

  return {
    manifestPath,
    environment: { SCENARIO_CATALOG_DIR: catalogDirectory },
  };
}

function deployment() {
  return JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: SCENARIO_ID,
      namespace: NAMESPACE,
      uid: "deployment-uid",
    },
    spec: { selector: { matchLabels: { app: SCENARIO_ID } } },
  });
}

function replicaSetList(items = [
  {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: {
      name: `${SCENARIO_ID}-7d9f6c8b5`,
      namespace: NAMESPACE,
      uid: "replicaset-uid",
      ownerReferences: [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: SCENARIO_ID,
          uid: "deployment-uid",
          controller: true,
        },
      ],
    },
  },
]) {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items,
  });
}

function podList(waitingReason = "ImagePullBackOff", ownerUid = "replicaset-uid") {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: `${SCENARIO_ID}-7d9f6c8b5-abcde`,
          namespace: NAMESPACE,
          uid: "pod-uid",
          ownerReferences: [
            {
              apiVersion: "apps/v1",
              kind: "ReplicaSet",
              name: `${SCENARIO_ID}-7d9f6c8b5`,
              uid: ownerUid,
              controller: true,
            },
          ],
        },
        status: {
          containerStatuses: [
            {
              name: "workload",
              state: { waiting: { reason: waitingReason } },
            },
          ],
        },
      },
    ],
  });
}

function eventList(type = "Warning", regardingUid = "pod-uid") {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "events.k8s.io/v1",
        kind: "Event",
        metadata: { name: "image-pull-event", namespace: NAMESPACE },
        type,
        reason: "Failed",
        note: "private-registry-detail-must-not-be-returned",
        regarding: {
          apiVersion: "v1",
          kind: "Pod",
          name: `${SCENARIO_ID}-7d9f6c8b5-abcde`,
          namespace: NAMESPACE,
          uid: regardingUid,
        },
      },
    ],
  });
}

function mutateFirstListItem(rawJson, mutate) {
  const document = JSON.parse(rawJson);
  mutate(document.items[0]);
  return JSON.stringify(document);
}

function createExecutor(options = {}) {
  const calls = [];
  const outputs = {
    deployment: deployment(),
    replicaSets: replicaSetList(),
    pods: podList(),
    events: eventList(),
    ...options.outputs,
  };
  const execute = async (command, args) => {
    calls.push({ command, args: [...args] });

    const getIndex = args.indexOf("get");
    const resource = getIndex === -1 ? undefined : args[getIndex + 1];
    const injectedFailure = options.failure?.({ command, args, resource });
    if (injectedFailure !== undefined) throw injectedFailure;

    if (command === "kind" && args.join(" ") === "version") {
      return "kind v0.32.0 go1.24.4 darwin/arm64\n";
    }
    if (command === "kubectl" && args.includes("--client")) {
      return JSON.stringify({ clientVersion: { gitVersion: "v1.36.2" } });
    }
    if (command === "kind" && args.join(" ") === "get clusters") {
      return `${CLUSTER_NAME}\n`;
    }
    if (command === "kind" && args.slice(0, 2).join(" ") === "get nodes") {
      return `${CLUSTER_NAME}-control-plane\n`;
    }
    if (command === "docker" && args[0] === "inspect") {
      return `${NODE_IMAGE}\n`;
    }
    if (command === "kubectl" && args.includes("config")) {
      return JSON.stringify([{ server: "https://127.0.0.1:61443" }]);
    }
    if (
      command === "kubectl" &&
      args.includes("version") &&
      !args.includes("--client")
    ) {
      return JSON.stringify({ serverVersion: { gitVersion: "v1.36.1" } });
    }
    if (command === "kubectl" && args.includes("apply")) {
      return "deployment.apps/image-pull-backoff configured\n";
    }
    if (command === "kubectl" && args.includes("delete")) {
      return "deployment.apps/image-pull-backoff deleted\n";
    }
    if (command === "kubectl" && resource === "deployment.apps") {
      return outputs.deployment;
    }
    if (command === "kubectl" && resource === "replicasets.apps") {
      return outputs.replicaSets;
    }
    if (command === "kubectl" && resource === "pods") {
      return outputs.pods;
    }
    if (command === "kubectl" && resource === "events.events.k8s.io") {
      return outputs.events;
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, execute };
}

async function verifyWithClock(t, executorOptions = {}) {
  const { environment } = createCatalog(t);
  const executor = createExecutor(executorOptions);
  let nowMilliseconds = 0;
  const sleeps = [];
  const promise = runScenarioCommand("verify", SCENARIO_ID, {
    repositoryRoot: REPOSITORY_ROOT,
    environment,
    execute: executor.execute,
    now: () => nowMilliseconds,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      nowMilliseconds += milliseconds;
    },
  });
  return { promise, executor, sleeps, now: () => nowMilliseconds };
}

test("the versioned fixture exposes only the public scenario contract", async () => {
  const publicItems = await runScenarioCommand("list", undefined, {
    repositoryRoot: REPOSITORY_ROOT,
    environment: {},
  });
  assert.deepEqual(publicItems, [{
    scenario_id: SCENARIO_ID,
    scenario_version: 1,
    display_name: "Image pull failure",
    description: "A Deployment cannot pull its configured image.",
    trigger: {
      type: "manual",
      summary: "The target Deployment is unavailable.",
    },
    target: {
      cluster: CLUSTER_NAME,
      namespace: NAMESPACE,
      api_version: "apps/v1",
      kind: "Deployment",
      name: SCENARIO_ID,
    },
  }]);
  const serialized = JSON.stringify(publicItems);
  for (const privateField of [
    "expected_root_causes",
    "required_evidence",
    "allowed_tools",
    "forbidden_tools",
    "deterministic_verifier",
    "fixture_manifests",
  ]) {
    assert.equal(serialized.includes(privateField), false);
  }
});

test("catalog rejects incompatible versions, extra fields, and target drift", async (t) => {
  const cases = [
    ["schema version", (scenario) => { scenario.schema_version = 2; }],
    ["scenario version", (scenario) => { scenario.scenario_version = 0; }],
    ["extra field", (scenario) => { scenario.unconsumed = "value"; }],
    ["cluster", (scenario) => { scenario.target.cluster = "production"; }],
    ["namespace", (scenario) => { scenario.target.namespace = "default"; }],
    ["apiVersion", (scenario) => { scenario.target.api_version = "v1"; }],
    ["kind", (scenario) => { scenario.target.kind = "Pod"; }],
    ["name", (scenario) => { scenario.target.name = "another-name"; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const scenario = validScenario();
      mutate(scenario);
      const { environment } = createCatalog(subtest, { scenario });

      await assert.rejects(
        runScenarioCommand("list", undefined, {
          repositoryRoot: REPOSITORY_ROOT,
          environment,
        }),
        (error) => error?.code === "scenario_contract_invalid",
      );
    });
  }
});

test("catalog rejects path traversal and symlink manifests", async (t) => {
  await t.test("path traversal", async (subtest) => {
    const scenario = validScenario();
    scenario.fixture_manifests = ["../external.yaml"];
    const { environment } = createCatalog(subtest, { scenario });
    await assert.rejects(
      runScenarioCommand("list", undefined, {
        repositoryRoot: REPOSITORY_ROOT,
        environment,
      }),
      (error) => error?.code === "scenario_contract_invalid",
    );
  });

  await t.test("symlink manifest", async (subtest) => {
    const { environment } = createCatalog(subtest, { symlinkManifest: true });
    await assert.rejects(
      runScenarioCommand("list", undefined, {
        repositoryRoot: REPOSITORY_ROOT,
        environment,
      }),
      (error) => error?.code === "scenario_contract_invalid",
    );
  });
});

test("catalog rejects a repository root even when it contains a valid scenario", async (t) => {
  const { environment } = createCatalog(t);
  const catalogDirectory = environment.SCENARIO_CATALOG_DIR;

  await assert.rejects(
    runScenarioCommand("list", undefined, {
      repositoryRoot: catalogDirectory,
      environment,
    }),
    (error) => error?.code === "scenario_contract_invalid",
  );
});

test("catalog rejects unsafe Deployment manifest identities and selectors", async (t) => {
  const cases = [
    ["apiVersion", validManifest({ apiVersion: "extensions/v1beta1" })],
    ["kind", validManifest({ kind: "Pod" })],
    ["name", validManifest({ name: "another-name" })],
    ["namespace", validManifest({ namespace: "default" })],
    ["empty matchLabels", validManifest({ selector: "matchLabels: {}" })],
    [
      "matchExpressions",
      validManifest({
        selector: `matchLabels:\n      app: ${SCENARIO_ID}\n    matchExpressions:\n      - key: tier\n        operator: Exists`,
      }),
    ],
  ];

  for (const [name, manifest] of cases) {
    await t.test(name, async (subtest) => {
      const { environment } = createCatalog(subtest, { manifest });
      await assert.rejects(
        runScenarioCommand("list", undefined, {
          repositoryRoot: REPOSITORY_ROOT,
          environment,
        }),
        (error) => error?.code === "scenario_contract_invalid",
      );
    });
  }
});

test("apply and cleanup use only the catalog manifest and fixed target", async (t) => {
  const { environment, manifestPath } = createCatalog(t);
  const { calls, execute } = createExecutor();
  const dependencies = {
    repositoryRoot: REPOSITORY_ROOT,
    environment,
    execute,
  };

  await runScenarioCommand("apply", SCENARIO_ID, dependencies);
  await runScenarioCommand("cleanup", SCENARIO_ID, dependencies);

  const mutations = calls.filter(
    ({ command, args }) =>
      command === "kubectl" &&
      (args.includes("apply") || args.includes("delete")),
  );
  assert.equal(mutations.length, 2);
  for (const call of mutations) {
    assert.ok(call.args.includes("--context"));
    assert.ok(call.args.includes(CONTEXT_NAME));
    assert.ok(call.args.includes("--namespace"));
    assert.ok(call.args.includes(NAMESPACE));
    assert.equal(call.args[call.args.indexOf("--filename") + 1], manifestPath);
    assert.equal(call.args.includes("--all"), false);
  }
  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kind" && args.slice(0, 2).join(" ") === "delete cluster",
    ),
    false,
  );
  assert.equal(
    mutations.some(({ args }) => args.includes("namespace")),
    false,
  );
});

test("scenario selection cannot become a path or arbitrary kubectl arguments", async (t) => {
  const { environment } = createCatalog(t);
  const { calls, execute } = createExecutor();

  await assert.rejects(
    runScenarioCommand("apply", "../image-pull-backoff", {
      repositoryRoot: REPOSITORY_ROOT,
      environment,
      execute,
    }),
    (error) => error?.code === "scenario_not_found",
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        path.join(REPOSITORY_ROOT, "scripts", "scenario.mjs"),
        "apply",
        SCENARIO_ID,
        "--namespace",
        "default",
      ],
      { cwd: REPOSITORY_ROOT, timeout: 5_000 },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /exactly one|arguments|action/i);
      return true;
    },
  );
});

test("verifier proves the Deployment to ReplicaSet to Pod owner chain", async (t) => {
  const { promise, executor } = await verifyWithClock(t);

  const result = await promise;

  assert.equal(result.status, "verified");
  assert.equal(result.scenario_id, SCENARIO_ID);
  assert.equal(result.pod.name, `${SCENARIO_ID}-7d9f6c8b5-abcde`);
  assert.equal(result.pod.waiting_reason, "ImagePullBackOff");
  assert.equal(result.event.reason, "Failed");
  assert.equal(
    JSON.stringify(result).includes("private-registry-detail-must-not-be-returned"),
    false,
  );
  const selectorCalls = executor.calls.filter(
    ({ args }) => args.includes("--selector"),
  );
  assert.equal(selectorCalls.length, 2);
  assert.equal(
    selectorCalls.every(
      ({ args }) => args[args.indexOf("--selector") + 1] === `app=${SCENARIO_ID}`,
    ),
    true,
  );
});

test("verifier reports the unmet condition without accepting unrelated objects", async (t) => {
  const cases = [
    {
      name: "Deployment missing",
      outputs: { deployment: "" },
      reason: "deployment_not_found",
    },
    {
      name: "no owner-linked ReplicaSet",
      outputs: { replicaSets: replicaSetList([]) },
      reason: "owner_linked_replicaset_not_found",
    },
    {
      name: "no owner-linked Pod",
      outputs: { pods: podList("ImagePullBackOff", "unrelated-uid") },
      reason: "owner_linked_pod_not_found",
    },
    {
      name: "wrong waiting reason",
      outputs: { pods: podList("ContainerCreating") },
      reason: "image_pull_waiting_state_not_observed",
    },
    {
      name: "no associated Warning Event",
      outputs: { events: eventList("Normal") },
      reason: "warning_event_not_observed",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const { promise } = await verifyWithClock(subtest, {
        outputs: scenario.outputs,
      });
      await assert.rejects(promise, (error) => {
        assert.equal(error?.code, "verification_failed");
        assert.equal(
          error?.message,
          `Scenario did not reach its deterministic evidence condition: ${scenario.reason}`,
        );
        return true;
      });
    });
  }
});

test("verifier polls every two seconds and stops at the 120 second deadline", async (t) => {
  const { promise, sleeps, now } = await verifyWithClock(t, {
    outputs: { deployment: "" },
  });

  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error?.code, "verification_failed");
      assert.equal(
        error?.message,
        "Scenario did not reach its deterministic evidence condition: deployment_not_found",
      );
      return true;
    },
  );
  assert.equal(now(), 120_000);
  assert.equal(sleeps.length, 60);
  assert.equal(sleeps.every((milliseconds) => milliseconds === 2_000), true);
});

test("verifier includes kubectl execution in the absolute 120 second deadline", async (t) => {
  const { environment } = createCatalog(t);
  const baseExecutor = createExecutor({ outputs: { deployment: "" } });
  const commandTimeouts = [];
  const sleeps = [];
  let nowMilliseconds = 0;

  const execute = async (command, args, options = {}) => {
    const resource = args[args.indexOf("get") + 1];
    if (command === "kubectl" && resource === "deployment.apps") {
      commandTimeouts.push(options.timeoutMilliseconds);
      const elapsed = Math.min(29_000, options.timeoutMilliseconds);
      nowMilliseconds += elapsed;
      if (elapsed < 29_000) {
        throw Object.assign(new Error("bounded command timeout"), {
          timedOut: true,
        });
      }
    }
    return baseExecutor.execute(command, args, options);
  };

  const promise = runScenarioCommand("verify", SCENARIO_ID, {
    repositoryRoot: REPOSITORY_ROOT,
    environment,
    execute,
    now: () => nowMilliseconds,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      nowMilliseconds += milliseconds;
    },
  });

  await assert.rejects(
    promise,
    (error) => error?.code === "verification_failed",
  );
  assert.equal(nowMilliseconds, 120_000);
  assert.deepEqual(commandTimeouts, [30_000, 30_000, 30_000, 27_000]);
  assert.deepEqual(sleeps, [2_000, 2_000, 2_000]);
});

test("deadline failure reports the current verification phase", async (t) => {
  const { environment } = createCatalog(t);
  const baseExecutor = createExecutor();
  let deploymentCalls = 0;
  let nowMilliseconds = 0;

  const execute = async (command, args, options = {}) => {
    const resource = args[args.indexOf("get") + 1];
    if (command === "kubectl" && resource === "deployment.apps") {
      deploymentCalls += 1;
      const duration = deploymentCalls <= 3 ? 29_000 : 26_000;
      nowMilliseconds += Math.min(duration, options.timeoutMilliseconds);
      return deploymentCalls <= 3 ? "" : deployment();
    }
    if (command === "kubectl" && resource === "replicasets.apps") {
      nowMilliseconds += options.timeoutMilliseconds;
      throw Object.assign(new Error("bounded command timeout"), {
        timedOut: true,
      });
    }
    return baseExecutor.execute(command, args, options);
  };

  const promise = runScenarioCommand("verify", SCENARIO_ID, {
    repositoryRoot: REPOSITORY_ROOT,
    environment,
    execute,
    now: () => nowMilliseconds,
    sleep: async (milliseconds) => {
      nowMilliseconds += milliseconds;
    },
  });

  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, "verification_failed");
    assert.equal(
      error?.message,
      "Scenario did not reach its deterministic evidence condition: owner_linked_replicaset_not_found",
    );
    return true;
  });
  assert.equal(nowMilliseconds, 120_000);
});

test("verifier rejects malformed kubectl JSON as an upstream contract error", async (t) => {
  const { promise } = await verifyWithClock(t, {
    outputs: { deployment: "not-json" },
  });

  await assert.rejects(
    promise,
    (error) => error?.code === "upstream_contract_invalid",
  );
});

test("verifier rejects list items with an incompatible Kubernetes type", async (t) => {
  const cases = [
    {
      name: "ReplicaSet item",
      output: "replicaSets",
      value: mutateFirstListItem(replicaSetList(), (item) => {
        item.kind = "StatefulSet";
      }),
    },
    {
      name: "Pod item",
      output: "pods",
      value: mutateFirstListItem(podList(), (item) => {
        item.kind = "Service";
      }),
    },
    {
      name: "Event item",
      output: "events",
      value: mutateFirstListItem(eventList(), (item) => {
        item.apiVersion = "v1";
      }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const { promise } = await verifyWithClock(subtest, {
        outputs: { [scenario.output]: scenario.value },
      });

      await assert.rejects(
        promise,
        (error) => error?.code === "upstream_contract_invalid",
      );
    });
  }
});

test("kubectl timeout and permission failures keep distinct safe codes", async (t) => {
  const cases = [
    {
      name: "timeout",
      failure: Object.assign(new Error("timeout-private-detail"), {
        timedOut: true,
        stderr: "timeout-private-detail",
      }),
      code: "request_timeout",
      secret: "timeout-private-detail",
    },
    {
      name: "permission",
      failure: Object.assign(new Error("permission-private-detail"), {
        exitCode: 1,
        stderr: "Error from server (Forbidden): permission-private-detail",
      }),
      code: "permission_denied",
      secret: "permission-private-detail",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const { promise } = await verifyWithClock(subtest, {
        failure: ({ resource }) =>
          resource === "deployment.apps" ? scenario.failure : undefined,
      });
      await assert.rejects(promise, (error) => {
        assert.equal(error?.code, scenario.code);
        assert.equal(String(error).includes(scenario.secret), false);
        return true;
      });
    });
  }
});

test("fixture image contract uses a deterministic non-latest pull failure", () => {
  const manifest = load(readFileSync(
    path.join(
      REPOSITORY_ROOT,
      "scenarios",
      SCENARIO_ID,
      "manifests",
      "deployment.yaml",
    ),
    "utf8",
  ));
  const container = manifest.spec.template.spec.containers[0];

  assert.equal(
    container.image,
    "registry.invalid/k8s-incident-agent/missing:v1",
  );
  assert.equal(container.imagePullPolicy, "Always");
  assert.equal(container.image.endsWith(":latest"), false);
});
