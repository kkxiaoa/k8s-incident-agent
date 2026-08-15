import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { load, loadAll } from "js-yaml";

import {
  buildClusterCommand,
  buildDiagnosticKubeconfig,
  loadKindContract,
  parseTokenRequest,
  resolveRuntimePaths,
  runClusterCommand,
} from "./kind-cluster.mjs";

const FIXED_CLUSTER_NAME = "k8s-incident-agent";
const FIXED_CONTEXT_NAME = "kind-k8s-incident-agent";
const FIXED_NAMESPACE = "k8s-incident-scenarios";
const FIXED_SERVICE_ACCOUNT = "diagnostic-agent";
const FIXED_KUBERNETES_VERSION = "1.36.1";
const FIXED_NODE_IMAGE =
  "kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const execFileAsync = promisify(execFile);

function createRepository(t, versions = {}) {
  const repositoryRoot = mkdtempSync(
    path.join(os.tmpdir(), "k8s-incident-agent-kind-test-"),
  );
  t.after(async () => {
    await rm(repositoryRoot, { recursive: true, force: true });
  });

  mkdirSync(path.join(repositoryRoot, "deploy", "kind", "rbac"), {
    recursive: true,
  });
  writeFileSync(
    path.join(repositoryRoot, "deploy", "kind", "versions.json"),
    JSON.stringify({
      kind: "v0.32.0",
      kubernetes: "v1.36.1",
      kubectl: "v1.36.2",
      nodeImage: FIXED_NODE_IMAGE,
      ...versions,
    }),
  );
  writeFileSync(
    path.join(repositoryRoot, "deploy", "kind", "config.yaml"),
    "kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\n",
  );
  writeFileSync(
    path.join(
      repositoryRoot,
      "deploy",
      "kind",
      "rbac",
      "diagnostic.yaml",
    ),
    "apiVersion: v1\nkind: List\nitems: []\n",
  );

  return repositoryRoot;
}

function encodeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
    .toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.test-signature`;
}

function tokenRequest(token, expirationTimestamp) {
  return JSON.stringify({
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenRequest",
    status: { token, expirationTimestamp },
  });
}

function clusterSettingsProjection(
  certificateAuthorityData = "test-ca-data",
  server = "https://127.0.0.1:61443",
) {
  return JSON.stringify([
    {
      server,
      "certificate-authority-data": certificateAuthorityData,
    },
  ]);
}

function matchingClusterOutputs(overrides = {}) {
  return {
    kindVersion: "kind v0.32.0 go1.24.4 darwin/arm64\n",
    kubectlClientVersion: JSON.stringify({
      clientVersion: { gitVersion: "v1.36.2" },
    }),
    clusterSettings: clusterSettingsProjection(),
    clusters: `${FIXED_CLUSTER_NAME}\n`,
    nodes: `${FIXED_CLUSTER_NAME}-control-plane\n`,
    image: `${FIXED_NODE_IMAGE}\n`,
    version: JSON.stringify({
      serverVersion: { gitVersion: `v${FIXED_KUBERNETES_VERSION}` },
    }),
    ...overrides,
  };
}

function createExecutor(outputs = matchingClusterOutputs()) {
  const calls = [];
  const execute = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], options: { ...options } });

    if (command === "kind" && args.join(" ") === "version") {
      return outputs.kindVersion;
    }
    if (
      command === "kubectl" &&
      args.includes("version") &&
      args.includes("--client")
    ) {
      return outputs.kubectlClientVersion;
    }
    if (command === "kind" && args.join(" ") === "get clusters") {
      return outputs.clusters;
    }
    if (command === "kind" && args.slice(0, 2).join(" ") === "get nodes") {
      return outputs.nodes;
    }
    if (command === "docker" && args[0] === "inspect") {
      return outputs.image;
    }
    if (command === "kubectl" && args.includes("version")) {
      return outputs.version;
    }
    if (command === "kubectl" && args.includes("apply")) {
      return "rbac applied\n";
    }
    if (command === "kubectl" && args.includes("config")) {
      return outputs.clusterSettings;
    }
    if (command === "kubectl" && args.includes("--raw")) {
      return outputs.tokenRequest;
    }
    if (command === "kubectl" && args.includes("can-i")) {
      return outputs.selfSubjectAccessReview ?? "yes\n";
    }
    if (command === "kind" && args.slice(0, 2).join(" ") === "create cluster") {
      return "cluster created\n";
    }
    if (command === "kind" && args.slice(0, 2).join(" ") === "delete cluster") {
      return "cluster deleted\n";
    }

    throw new Error(`Unexpected command in test: ${command} ${args.join(" ")}`);
  };
  return { calls, execute };
}

function runClusterAction(action, repositoryRoot, execute, dependencies = {}) {
  return runClusterCommand(action, {
    repositoryRoot,
    environment: {},
    execute,
    logger: { info() {}, error() {} },
    ...dependencies,
  });
}

function bootstrapOutputs(now, overrides = {}) {
  const exp = Math.floor(now.getTime() / 1000) + 3600;
  const token = encodeJwt({ exp, sub: "diagnostic-test" });
  const expirationTimestamp = new Date(exp * 1000).toISOString();
  return {
    ...matchingClusterOutputs(),
    clusterSettings: clusterSettingsProjection(),
    token,
    tokenRequest: tokenRequest(token, expirationTimestamp),
    selfSubjectAccessReview: "yes\n",
    ...overrides,
  };
}

function createFakeCliDirectory(t) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "k8s-incident-agent-cli-test-"),
  );
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  for (const binary of ["kind", "kubectl", "docker"]) {
    writeFileSync(
      path.join(directory, binary),
      `#!/usr/bin/env node
const binary = ${JSON.stringify(binary)};
const args = process.argv.slice(2);
const key = [binary, ...args].join(" ");
const outputs = new Map([
  ["kind version", "kind v0.32.0 go1.24.4 darwin/arm64\\n"],
  ["kind get clusters", ${JSON.stringify(`${FIXED_CLUSTER_NAME}\n`)}],
  ["kind get nodes --name ${FIXED_CLUSTER_NAME}", ${JSON.stringify(`${FIXED_CLUSTER_NAME}-control-plane\n`)}],
  ["docker inspect --format {{.Config.Image}} ${FIXED_CLUSTER_NAME}-control-plane", ${JSON.stringify(`${FIXED_NODE_IMAGE}\n`)}],
  ["kubectl version --client --output=json", ${JSON.stringify(JSON.stringify({ clientVersion: { gitVersion: "v1.36.2" } }))}],
  ["kubectl --context ${FIXED_CONTEXT_NAME} config view --minify --output=jsonpath-as-json={.clusters[0].cluster}", ${JSON.stringify(clusterSettingsProjection())}],
  ["kubectl --context ${FIXED_CONTEXT_NAME} version --output=json", ${JSON.stringify(JSON.stringify({ serverVersion: { gitVersion: `v${FIXED_KUBERNETES_VERSION}` } }))}],
]);
if (!outputs.has(key)) {
  process.stderr.write("unexpected fake CLI command");
  process.exitCode = 1;
} else {
  process.stdout.write(outputs.get(key));
}
`,
      { mode: 0o755 },
    );
  }
  return directory;
}

test("Kind config keeps the fixed single-control-plane loopback topology", () => {
  const config = load(
    readFileSync(path.join(REPOSITORY_ROOT, "deploy", "kind", "config.yaml"), "utf8"),
  );

  assert.deepEqual(config, {
    kind: "Cluster",
    apiVersion: "kind.x-k8s.io/v1alpha4",
    networking: { apiServerAddress: "127.0.0.1" },
    nodes: [{ role: "control-plane" }],
  });
});

test("diagnostic RBAC grants only the Stage 1 read contract", () => {
  const documents = [];
  loadAll(
    readFileSync(
      path.join(REPOSITORY_ROOT, "deploy", "kind", "rbac", "diagnostic.yaml"),
      "utf8",
    ),
    (document) => documents.push(document),
  );
  assert.equal(documents.length, 4);

  const byKind = new Map(documents.map((document) => [document.kind, document]));
  const namespace = byKind.get("Namespace");
  const serviceAccount = byKind.get("ServiceAccount");
  const role = byKind.get("Role");
  const roleBinding = byKind.get("RoleBinding");

  assert.equal(namespace.metadata.name, FIXED_NAMESPACE);
  assert.deepEqual(
    {
      name: serviceAccount.metadata.name,
      namespace: serviceAccount.metadata.namespace,
      automountServiceAccountToken: serviceAccount.automountServiceAccountToken,
    },
    {
      name: FIXED_SERVICE_ACCOUNT,
      namespace: FIXED_NAMESPACE,
      automountServiceAccountToken: false,
    },
  );
  assert.deepEqual(
    { name: role.metadata.name, namespace: role.metadata.namespace },
    { name: "diagnostic-agent-read", namespace: FIXED_NAMESPACE },
  );
  assert.deepEqual(
    role.rules
      .map(({ apiGroups, resources, verbs }) => ({
        apiGroups: [...apiGroups].sort(),
        resources: [...resources].sort(),
        verbs: [...verbs].sort(),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [
      { apiGroups: [""], resources: ["pods"], verbs: ["list"] },
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["list"] },
      { apiGroups: ["events.k8s.io"], resources: ["events"], verbs: ["list"] },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
  assert.deepEqual(roleBinding.subjects, [
    {
      kind: "ServiceAccount",
      name: FIXED_SERVICE_ACCOUNT,
      namespace: FIXED_NAMESPACE,
    },
  ]);
  assert.deepEqual(
    {
      name: roleBinding.metadata.name,
      namespace: roleBinding.metadata.namespace,
    },
    { name: "diagnostic-agent-read", namespace: FIXED_NAMESPACE },
  );
  assert.deepEqual(roleBinding.roleRef, {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "Role",
    name: "diagnostic-agent-read",
  });
});

test("loadKindContract rejects a missing pinned version field", async (t) => {
  const repositoryRoot = createRepository(t, { kubernetes: undefined });

  await assert.rejects(
    loadKindContract(repositoryRoot),
    /kubernetes|semantic version|version contract/i,
  );
});

test("loadKindContract only depends on the Kind version contract", async (t) => {
  const repositoryRoot = createRepository(t);

  const contract = await loadKindContract(repositoryRoot);

  assert.equal(contract.kindVersion, "0.32.0");
  assert.equal(contract.kubernetesVersion, FIXED_KUBERNETES_VERSION);
  assert.equal(contract.kubectlVersion, "1.36.2");
  assert.equal(contract.nodeImage, FIXED_NODE_IMAGE);
});

test("cluster commands reject attempts to replace fixed identities", async (t) => {
  const repositoryRoot = createRepository(t);
  const contract = await loadKindContract(repositoryRoot);

  assert.equal(contract.clusterName, FIXED_CLUSTER_NAME);
  assert.equal(contract.contextName, FIXED_CONTEXT_NAME);
  assert.equal(contract.scenarioNamespace, FIXED_NAMESPACE);
  assert.equal(contract.serviceAccountName, FIXED_SERVICE_ACCOUNT);
  assert.throws(
    () =>
      buildClusterCommand(
        "up",
        { ...contract, clusterName: "user-selected-cluster" },
      ),
    /fixed|cluster.*identity|contract/i,
  );
  assert.throws(
    () =>
      buildClusterCommand(
        "bootstrap-access",
        { ...contract, scenarioNamespace: "default" },
      ),
    /fixed|namespace|contract/i,
  );
});

test("up fails closed when a same-name cluster uses a different node image", async (t) => {
  const repositoryRoot = createRepository(t);
  const { calls, execute } = createExecutor(
    matchingClusterOutputs({
      image:
        "kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95\n",
    }),
  );

  await assert.rejects(
    runClusterAction("up", repositoryRoot, execute),
    /node image|baseline|incompatible/i,
  );
  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kind" && ["create", "delete"].includes(args[0]),
    ),
    false,
    "an incompatible same-name cluster must never be recreated implicitly",
  );
});

test("up fails closed when a same-name cluster reports another Kubernetes minor", async (t) => {
  const repositoryRoot = createRepository(t);
  const { calls, execute } = createExecutor(
    matchingClusterOutputs({
      version: JSON.stringify({
        serverVersion: { gitVersion: "v1.35.5" },
      }),
    }),
  );

  await assert.rejects(
    runClusterAction("up", repositoryRoot, execute),
    /Kubernetes minor|baseline|incompatible/i,
  );
  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kind" && ["create", "delete"].includes(args[0]),
    ),
    false,
  );
});

test("up creates an absent fixed cluster once and verifies it", async (t) => {
  const repositoryRoot = createRepository(t);
  const { calls, execute } = createExecutor(
    matchingClusterOutputs({ clusters: "" }),
  );

  await runClusterAction("up", repositoryRoot, execute);

  const createCalls = calls.filter(
    ({ command, args }) =>
      command === "kind" && args.slice(0, 2).join(" ") === "create cluster",
  );
  assert.equal(createCalls.length, 1);
  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kind" && args.slice(0, 2).join(" ") === "delete cluster",
    ),
    false,
  );
});

test("up leaves an existing matching cluster unchanged", async (t) => {
  const repositoryRoot = createRepository(t);
  const { calls, execute } = createExecutor();

  await runClusterAction("up", repositoryRoot, execute);

  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kind" && ["create", "delete"].includes(args[0]),
    ),
    false,
  );
});

test("down only requires the pinned Kind CLI", async (t) => {
  const repositoryRoot = createRepository(t);
  rmSync(path.join(repositoryRoot, "deploy", "kind", "config.yaml"));
  rmSync(
    path.join(repositoryRoot, "deploy", "kind", "rbac", "diagnostic.yaml"),
  );
  const executor = createExecutor();
  const execute = async (command, args, options) => {
    if (command === "kubectl") {
      throw new Error("kubectl must not be called by cluster down");
    }
    return executor.execute(command, args, options);
  };

  await runClusterAction("down", repositoryRoot, execute);

  const deleteCalls = executor.calls.filter(
    ({ command, args }) =>
      command === "kind" && args.slice(0, 2).join(" ") === "delete cluster",
  );
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0].args, [
    "delete",
    "cluster",
    "--name",
    FIXED_CLUSTER_NAME,
  ]);
});

test("down leaves an absent fixed cluster unchanged", async (t) => {
  const repositoryRoot = createRepository(t);
  const { calls, execute } = createExecutor(
    matchingClusterOutputs({ clusters: "" }),
  );

  await runClusterAction("down", repositoryRoot, execute);

  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kind" && args.slice(0, 2).join(" ") === "delete cluster",
    ),
    false,
  );
});

test("status projects only non-sensitive cluster settings", async (t) => {
  const repositoryRoot = createRepository(t);
  const { calls, execute } = createExecutor();

  await runClusterAction("status", repositoryRoot, execute);

  const projectionCall = calls.find(
    ({ command, args }) => command === "kubectl" && args.includes("config"),
  );
  assert.ok(projectionCall);
  assert.equal(projectionCall.args.includes("--raw"), false);
  assert.ok(
    projectionCall.args.includes(
      "--output=jsonpath-as-json={.clusters[0].cluster}",
    ),
  );
  assert.equal(projectionCall.args.includes("--output=json"), false);
});

test("CLI entrypoint executes status through the real process adapter", async (t) => {
  const fakeCliDirectory = createFakeCliDirectory(t);

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(REPOSITORY_ROOT, "scripts", "kind-cluster.mjs"), "status"],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PATH: `${fakeCliDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 5_000,
    },
  );

  assert.equal(stderr, "");
  assert.equal(stdout, "Kind cluster matches the pinned baseline\n");
});

test("resolveRuntimePaths rejects broad, external, and symlink-backed targets", (t) => {
  const repositoryRoot = createRepository(t);
  const outside = mkdtempSync(
    path.join(os.tmpdir(), "k8s-incident-agent-outside-test-"),
  );
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });
  const ignoredRuntimeRoot = path.join(repositoryRoot, ".runtime");
  mkdirSync(ignoredRuntimeRoot);
  const linkedDirectory = path.join(ignoredRuntimeRoot, "runtime-link");
  const danglingLink = path.join(
    ignoredRuntimeRoot,
    "dangling-runtime-link",
  );
  symlinkSync(outside, linkedDirectory, "dir");
  symlinkSync(path.join(outside, "missing-target"), danglingLink, "dir");

  assert.throws(
    () =>
      resolveRuntimePaths(repositoryRoot, {
        RUNTIME_DATA_DIR: repositoryRoot,
      }),
    /broad|repository root|runtime/i,
  );
  assert.throws(
    () =>
      resolveRuntimePaths(repositoryRoot, {
        RUNTIME_DATA_DIR: outside,
      }),
    /inside|outside|repository/i,
  );
  assert.throws(
    () =>
      resolveRuntimePaths(repositoryRoot, {
        RUNTIME_DATA_DIR: path.join(repositoryRoot, "runtime-data"),
      }),
    /ignored|\.runtime/i,
  );
  assert.throws(
    () =>
      resolveRuntimePaths(repositoryRoot, {
        RUNTIME_DATA_DIR: linkedDirectory,
      }),
    /symbolic link|symlink/i,
  );
  assert.throws(
    () =>
      resolveRuntimePaths(repositoryRoot, {
        RUNTIME_DATA_DIR: danglingLink,
      }),
    /symbolic link|symlink/i,
  );
});

test("parseTokenRequest rejects incomplete or inconsistent credentials", async (t) => {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const cases = [
    {
      name: "missing token",
      raw: JSON.stringify({
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenRequest",
        status: { expirationTimestamp: "2026-08-14T13:00:00.000Z" },
      }),
      error: /status\.token|token/i,
    },
    {
      name: "missing authoritative expiration",
      raw: JSON.stringify({
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenRequest",
        status: { token: encodeJwt({ exp: 1_786_712_400 }) },
      }),
      error: /expirationTimestamp|expiration/i,
    },
    {
      name: "JWT missing exp",
      raw: tokenRequest(
        encodeJwt({ sub: "diagnostic-test" }),
        "2026-08-14T13:00:00.000Z",
      ),
      error: /JWT.*exp|exp/i,
    },
    {
      name: "JWT exp drifts by more than sixty seconds",
      raw: tokenRequest(
        encodeJwt({ exp: 1_786_712_461 }),
        "2026-08-14T13:00:00.000Z",
      ),
      error: /60 seconds|expiration.*mismatch|JWT.*exp/i,
    },
    {
      name: "JWT is expired within the drift tolerance",
      raw: tokenRequest(
        encodeJwt({ exp: 1_786_708_770 }),
        "2026-08-14T12:00:30.000Z",
      ),
      error: /JWT.*expir|JWT.*future/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      assert.throws(
        () => parseTokenRequest(scenario.raw, now),
        scenario.error,
      );
    });
  }
});

test("buildDiagnosticKubeconfig only accepts a loopback HTTPS cluster projection", () => {
  assert.throws(
    () =>
      buildDiagnosticKubeconfig(
        {
          server: "http://127.0.0.1:61443",
          certificateAuthorityData: "test-ca-data",
        },
        "test-token",
      ),
    /HTTPS/i,
  );
  assert.throws(
    () =>
      buildDiagnosticKubeconfig(
        {
          server: "https://cluster.example.com:6443",
          certificateAuthorityData: "test-ca-data",
        },
        "test-token",
      ),
    /loopback/i,
  );
});

test("bootstrap-access preserves the old credential when atomic replacement fails", async (t) => {
  const repositoryRoot = createRepository(t);
  const runtimeDirectory = path.join(repositoryRoot, ".runtime");
  const credentialPath = path.join(runtimeDirectory, "diagnostic.kubeconfig");
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  writeFileSync(credentialPath, "old-credential", { mode: 0o600 });
  chmodSync(credentialPath, 0o600);
  const now = new Date("2026-08-14T12:00:00.000Z");
  const outputs = bootstrapOutputs(now);
  const { execute } = createExecutor(outputs);

  await assert.rejects(
    runClusterAction("bootstrap-access", repositoryRoot, execute, {
      now: () => now,
      renameFile: async () => {
        throw new Error("simulated rename failure");
      },
    }),
    /replace|rename|credential/i,
  );

  assert.equal(readFileSync(credentialPath, "utf8"), "old-credential");
  assert.deepEqual(readdirSync(runtimeDirectory), ["diagnostic.kubeconfig"]);
});

test("bootstrap-access validates the management endpoint before applying RBAC", async (t) => {
  const repositoryRoot = createRepository(t);
  const now = new Date("2026-08-14T12:00:00.000Z");
  const outputs = bootstrapOutputs(now, {
    clusterSettings: clusterSettingsProjection(
      "test-ca-data",
      "https://cluster.example.com:6443",
    ),
  });
  const { calls, execute } = createExecutor(outputs);

  await assert.rejects(
    runClusterAction("bootstrap-access", repositoryRoot, execute, {
      now: () => now,
    }),
    /loopback/i,
  );

  assert.equal(
    calls.some(
      ({ command, args }) => command === "kubectl" && args.includes("apply"),
    ),
    false,
    "RBAC must not be applied until the fixed context endpoint is validated",
  );
  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kubectl" &&
        args.includes("create") &&
        args.includes("--raw"),
    ),
    false,
    "TokenRequest must not run against an untrusted endpoint",
  );
  assert.equal(
    calls.some(
      ({ command, args }) =>
        command === "kubectl" &&
        args.includes("version") &&
        !args.includes("--client"),
    ),
    false,
    "even a read-only API call must wait until the endpoint is validated",
  );
});

test("bootstrap-access writes one restricted kubeconfig without logging credentials", async (t) => {
  const repositoryRoot = createRepository(t);
  const now = new Date("2026-08-14T12:00:00.000Z");
  const certificateAuthorityData = "sensitive-ca-data";
  const outputs = bootstrapOutputs(now, {
    clusterSettings: clusterSettingsProjection(certificateAuthorityData),
  });
  const { calls, execute } = createExecutor(outputs);
  const logLines = [];
  const logger = {
    info(...values) {
      logLines.push(values.join(" "));
    },
    error(...values) {
      logLines.push(values.join(" "));
    },
  };

  await runClusterAction("bootstrap-access", repositoryRoot, execute, {
    logger,
    now: () => now,
  });

  const runtimeDirectory = path.join(repositoryRoot, ".runtime");
  const credentialPath = path.join(runtimeDirectory, "diagnostic.kubeconfig");
  const kubeconfigRaw = readFileSync(credentialPath, "utf8");
  const kubeconfig = JSON.parse(kubeconfigRaw);
  assert.equal(statSync(runtimeDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(credentialPath).mode & 0o777, 0o600);
  assert.equal(kubeconfig["current-context"], FIXED_CONTEXT_NAME);
  assert.equal(kubeconfig.clusters.length, 1);
  assert.equal(kubeconfig.contexts.length, 1);
  assert.equal(kubeconfig.users.length, 1);
  assert.equal(kubeconfig.users[0].user.token, outputs.token);
  assert.equal(
    kubeconfig.clusters[0].cluster["certificate-authority-data"],
    certificateAuthorityData,
  );

  const projectionCall = calls.find(
    ({ command, args }) => command === "kubectl" && args.includes("config"),
  );
  assert.ok(projectionCall);
  assert.ok(projectionCall.args.includes("--raw"));
  assert.ok(
    projectionCall.args.includes(
      "--output=jsonpath-as-json={.clusters[0].cluster}",
    ),
  );
  assert.equal(projectionCall.args.includes("--output=json"), false);

  const accessCheck = calls.find(
    ({ command, args }) => command === "kubectl" && args.includes("can-i"),
  );
  assert.ok(accessCheck, "bootstrap must verify SelfSubjectAccessReview access");
  assert.ok(
    accessCheck.args.includes(
      "selfsubjectaccessreviews.authorization.k8s.io",
    ),
  );
  assert.notEqual(
    accessCheck.args[accessCheck.args.indexOf("--kubeconfig") + 1],
    credentialPath,
    "the access gate must use the temporary credential before replacement",
  );
  const tokenCall = calls.find(
    ({ command, args }) =>
      command === "kubectl" &&
      args.includes("create") &&
      args.includes("--raw"),
  );
  assert.ok(tokenCall, "bootstrap must use the TokenRequest subresource");
  assert.ok(
    tokenCall.args.includes(
      `/api/v1/namespaces/${FIXED_NAMESPACE}/serviceaccounts/${FIXED_SERVICE_ACCOUNT}/token`,
    ),
  );
  assert.deepEqual(JSON.parse(tokenCall.options.input), {
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenRequest",
    spec: { expirationSeconds: 28_800 },
  });

  const logs = logLines.join("\n");
  assert.equal(logs.includes(outputs.token), false);
  assert.equal(logs.includes(certificateAuthorityData), false);
  assert.equal(logs.includes(kubeconfigRaw), false);
});

test("bootstrap-access fails closed when default SelfSubjectAccessReview access is absent", async (t) => {
  const repositoryRoot = createRepository(t);
  const runtimeDirectory = path.join(repositoryRoot, ".runtime");
  const credentialPath = path.join(runtimeDirectory, "diagnostic.kubeconfig");
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  writeFileSync(credentialPath, "old-credential", { mode: 0o600 });
  const now = new Date("2026-08-14T12:00:00.000Z");
  const outputs = bootstrapOutputs(now, {
    selfSubjectAccessReview: "no\n",
  });
  const { execute } = createExecutor(outputs);

  await assert.rejects(
    runClusterAction("bootstrap-access", repositoryRoot, execute, {
      now: () => now,
    }),
    /SelfSubjectAccessReview|access review|permission/i,
  );
  assert.equal(readFileSync(credentialPath, "utf8"), "old-credential");
  assert.deepEqual(readdirSync(runtimeDirectory), ["diagnostic.kubeconfig"]);
});
