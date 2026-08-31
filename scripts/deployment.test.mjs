import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadAll } from "js-yaml";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEPLOYMENT_SCRIPT = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "deployment.mjs",
);
const APPLICATION_ROOT = path.join(
  REPOSITORY_ROOT,
  "deploy",
  "application",
);
const KUBECTL_BINARY = process.env.KUBECTL_BINARY ?? "kubectl";
const REAL_KUBECTL =
  process.env.KUBECTL_BINARY ??
  execFileSync("sh", ["-c", "command -v kubectl"], {
    encoding: "utf8",
  }).trim();
const CONSOLE_IMAGE =
  "k8s-incident-agent-console@sha256:d17c795998baeaba9616c51bf097be196d46c1ba3350291273c32454c5ddaa2d";
const RUNTIME_IMAGE =
  "k8s-incident-agent-runtime@sha256:ac579e349eea2c3804f687013b9cc7b3c6e8e1d08d4d47f4f8a06249b8fb88e8";

function render(relativePath) {
  return execFileSync(
    KUBECTL_BINARY,
    ["kustomize", path.join(APPLICATION_ROOT, relativePath)],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
}

function documents(rawYaml) {
  const result = [];
  loadAll(rawYaml, (document) => {
    if (document !== undefined && document !== null) result.push(document);
  });
  return result;
}

function identity(document) {
  return [
    document.kind,
    document.metadata?.namespace ?? "",
    document.metadata?.name,
  ].join("/");
}

function indexDocuments(rawYaml) {
  const result = new Map();
  for (const document of documents(rawYaml)) {
    const key = identity(document);
    assert.equal(result.has(key), false, `duplicate rendered identity ${key}`);
    result.set(key, document);
  }
  return result;
}

function getResource(index, kind, name, namespace = "") {
  const key = [kind, namespace, name].join("/");
  assert.equal(index.has(key), true, `missing rendered resource ${key}`);
  return index.get(key);
}

test("all deployment profiles render byte-stably from the shared base", () => {
  const profiles = [
    "overlays/kind-evaluation",
    "overlays/k3s-evaluation",
    "overlays/k3s-online",
  ];
  for (const profile of profiles) {
    const first = render(profile);
    const second = render(profile);
    assert.equal(first, second);
    assert.notEqual(documents(first).length, 0);
    indexDocuments(first);
  }
});

test("profile overlays change only platform storage, ingress, and intake behavior", () => {
  const kind = indexDocuments(render("overlays/kind-evaluation"));
  const evaluation = indexDocuments(render("overlays/k3s-evaluation"));
  const online = indexDocuments(render("overlays/k3s-online"));

  const kindPvc = getResource(
    kind,
    "PersistentVolumeClaim",
    "runtime-data",
    "k8s-incident-agent",
  );
  assert.equal(kindPvc.spec.storageClassName, "k8s-incident-agent-kind");
  assert.equal(kindPvc.spec.volumeName, "k8s-incident-agent-runtime-data");
  const kindPv = getResource(
    kind,
    "PersistentVolume",
    "k8s-incident-agent-runtime-data",
  );
  assert.equal(kindPv.spec.persistentVolumeReclaimPolicy, "Retain");
  assert.equal(kindPv.spec.hostPath.path, "/var/local/k8s-incident-agent");
  assert.equal(
    [...kind.values()].some((resource) => resource.kind === "Ingress"),
    false,
  );
  assert.equal(
    kind.has(
      "NetworkPolicy/k8s-incident-agent/allow-traefik-to-console",
    ),
    false,
  );

  for (const profile of [evaluation, online]) {
    const pvc = getResource(
      profile,
      "PersistentVolumeClaim",
      "runtime-data",
      "k8s-incident-agent",
    );
    assert.equal(pvc.spec.storageClassName, "local-path");
    assert.equal(
      [...profile.values()].some((resource) => resource.kind === "PersistentVolume"),
      false,
    );
    const ingress = getResource(
      profile,
      "Ingress",
      "incident-console",
      "k8s-incident-agent",
    );
    assert.equal(ingress.spec.ingressClassName, "traefik");
    assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, "incident-console");
  }

  for (const [profile, expectedMode] of [
    [kind, "manual"],
    [evaluation, "manual"],
    [online, "online"],
  ]) {
    assert.equal(
      getResource(
        profile,
        "ConfigMap",
        "agent-runtime-config",
        "k8s-incident-agent",
      ).data.INCIDENT_INTAKE_MODE,
      expectedMode,
    );
    assert.equal(
      getResource(
        profile,
        "ConfigMap",
        "incident-console-config",
        "k8s-incident-agent",
      ).data.INCIDENT_INTAKE_MODE,
      expectedMode,
    );
  }
});

test("Runtime render preserves one-writer migration, storage, identity, and image contracts", () => {
  const resources = indexDocuments(render("overlays/k3s-evaluation"));
  const runtime = getResource(
    resources,
    "Deployment",
    "agent-runtime",
    "k8s-incident-agent",
  );
  assert.equal(runtime.spec.replicas, 1);
  assert.deepEqual(runtime.spec.strategy, { type: "Recreate" });
  const pod = runtime.spec.template.spec;
  assert.equal(pod.serviceAccountName, "agent-runtime");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(
    {
      fsGroup: pod.securityContext.fsGroup,
      fsGroupChangePolicy: pod.securityContext.fsGroupChangePolicy,
      runAsGroup: pod.securityContext.runAsGroup,
      runAsNonRoot: pod.securityContext.runAsNonRoot,
      runAsUser: pod.securityContext.runAsUser,
    },
    {
      fsGroup: 10001,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 10001,
      runAsNonRoot: true,
      runAsUser: 10001,
    },
  );
  assert.equal(pod.initContainers.length, 1);
  assert.deepEqual(pod.initContainers[0].command, ["alembic", "upgrade", "head"]);
  assert.equal(pod.initContainers[0].image, RUNTIME_IMAGE);
  assert.equal(pod.containers[0].image, RUNTIME_IMAGE);
  assert.deepEqual(pod.initContainers[0].volumeMounts, [
    { mountPath: "/var/lib/k8s-incident-agent", name: "runtime-data" },
  ]);
  assert.equal(
    pod.containers[0].volumeMounts.find((mount) => mount.name === "runtime-data").mountPath,
    "/var/lib/k8s-incident-agent",
  );
  assert.deepEqual(
    pod.volumes.find((volume) => volume.name === "runtime-data").persistentVolumeClaim,
    { claimName: "runtime-data" },
  );
  const projected = pod.volumes.find(
    (volume) => volume.name === "kubernetes-api-access",
  ).projected;
  assert.equal(projected.defaultMode, 0o440);
  assert.deepEqual(projected.sources, [
    { serviceAccountToken: { expirationSeconds: 600, path: "token" } },
    {
      configMap: {
        items: [{ key: "ca.crt", path: "ca.crt" }],
        name: "kube-root-ca.crt",
      },
    },
    {
      downwardAPI: {
        items: [
          {
            fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" },
            path: "namespace",
          },
        ],
      },
    },
  ]);
  assert.deepEqual(pod.containers[0].env, [
    {
      name: "DEEPSEEK_API_KEY",
      valueFrom: {
        secretKeyRef: { key: "api-key", name: "agent-runtime-model" },
      },
    },
  ]);
  assert.equal(
    [...resources.values()].some((resource) => resource.kind === "Secret"),
    false,
  );
});

test("Kind render prepares only the fixed hostPath root before non-root migration", () => {
  const resources = indexDocuments(render("overlays/kind-evaluation"));
  const runtime = getResource(
    resources,
    "Deployment",
    "agent-runtime",
    "k8s-incident-agent",
  );
  const [prepare, migrate] = runtime.spec.template.spec.initContainers;
  assert.equal(prepare.name, "prepare-kind-volume");
  assert.equal(prepare.image, RUNTIME_IMAGE);
  assert.deepEqual(prepare.command, [
    "/usr/bin/chown",
    "10001:10001",
    "/var/lib/k8s-incident-agent",
  ]);
  assert.deepEqual(prepare.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { add: ["CHOWN"], drop: ["ALL"] },
    readOnlyRootFilesystem: true,
    runAsGroup: 0,
    runAsNonRoot: false,
    runAsUser: 0,
  });
  assert.deepEqual(prepare.volumeMounts, [
    { mountPath: "/var/lib/k8s-incident-agent", name: "runtime-data" },
  ]);
  assert.equal(migrate.name, "migrate");
  assert.equal(migrate.image, RUNTIME_IMAGE);
  assert.deepEqual(migrate.command, ["alembic", "upgrade", "head"]);
  assert.equal(runtime.spec.template.spec.securityContext.runAsUser, 10001);
});

test("Console and Runtime exposure and RBAC stay within the fixed read-only boundary", () => {
  const resources = indexDocuments(render("overlays/k3s-online"));
  const console = getResource(
    resources,
    "Deployment",
    "incident-console",
    "k8s-incident-agent",
  );
  assert.equal(console.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(console.spec.template.spec.containers[0].image, CONSOLE_IMAGE);
  assert.equal(
    console.spec.template.spec.volumes?.some((volume) =>
      Object.hasOwn(volume, "projected"),
    ) ?? false,
    false,
  );
  for (const name of ["incident-console", "agent-runtime"]) {
    assert.equal(
      getResource(resources, "Service", name, "k8s-incident-agent").spec.type,
      "ClusterIP",
    );
  }
  const ingress = getResource(
    resources,
    "Ingress",
    "incident-console",
    "k8s-incident-agent",
  );
  assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, "incident-console");
  assert.equal(
    JSON.stringify(ingress).includes("agent-runtime"),
    false,
  );

  const role = getResource(
    resources,
    "Role",
    "diagnostic-agent-read",
    "k8s-incident-scenarios",
  );
  assert.deepEqual(
    role.rules
      .map(({ apiGroups, resources: names, verbs }) => ({
        apiGroups,
        resources: names,
        verbs,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [
      { apiGroups: [""], resources: ["pods"], verbs: ["list"] },
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["list"] },
      { apiGroups: ["events.k8s.io"], resources: ["events"], verbs: ["list"] },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
  assert.deepEqual(
    getResource(
      resources,
      "RoleBinding",
      "diagnostic-agent-read",
      "k8s-incident-scenarios",
    ).subjects,
    [
      {
        kind: "ServiceAccount",
        name: "agent-runtime",
        namespace: "k8s-incident-agent",
      },
    ],
  );
});

test("NetworkPolicy render has default deny plus only the required L3/L4 paths", () => {
  const resources = indexDocuments(render("overlays/k3s-evaluation"));
  const policies = [...resources.values()].filter(
    (resource) => resource.kind === "NetworkPolicy",
  );
  assert.deepEqual(
    policies.map((policy) => policy.metadata.name).sort(),
    [
      "allow-console-runtime-egress",
      "allow-console-to-runtime",
      "allow-dns-egress",
      "allow-runtime-https-egress",
      "allow-traefik-to-console",
      "default-deny",
    ],
  );
  assert.deepEqual(
    getResource(
      resources,
      "NetworkPolicy",
      "default-deny",
      "k8s-incident-agent",
    ).spec,
    { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  );
  const dns = getResource(
    resources,
    "NetworkPolicy",
    "allow-dns-egress",
    "k8s-incident-agent",
  );
  assert.deepEqual(
    dns.spec.egress[0].ports,
    [
      { port: 53, protocol: "UDP" },
      { port: 53, protocol: "TCP" },
    ],
  );
  const https = getResource(
    resources,
    "NetworkPolicy",
    "allow-runtime-https-egress",
    "k8s-incident-agent",
  );
  assert.deepEqual(https.spec.egress, [
    { ports: [{ port: 443, protocol: "TCP" }] },
  ]);
});

test("uninstall renders only non-data resources and never a Namespace or volume", () => {
  for (const profile of ["uninstall/kind", "uninstall/k3s"]) {
    const rendered = render(profile);
    assert.equal(rendered, render(profile));
    const resources = documents(rendered);
    indexDocuments(rendered);
    assert.equal(
      resources.some((resource) =>
        ["Namespace", "PersistentVolume", "PersistentVolumeClaim"].includes(
          resource.kind,
        ),
      ),
      false,
    );
    assert.equal(
      resources
        .flatMap((resource) => resource.spec?.template?.spec?.containers ?? [])
        .every((container) => container.image?.includes("@sha256:")),
      true,
    );
  }
});

test("K3s producer contract stays exact and does not duplicate the kubectl pin", () => {
  const contract = JSON.parse(
    readFileSync(path.join(APPLICATION_ROOT, "versions.json"), "utf8"),
  );
  assert.deepEqual(contract, {
    k3s: "v1.36.3+k3s1",
    kubernetes: "v1.36.3",
    components: {
      coredns: "v1.14.6",
      localPathProvisioner: "v0.0.36",
      traefik: "v3.7.8",
    },
  });
  assert.equal(Object.hasOwn(contract, "kubectl"), false);
});

function runDeployment(args, environment = {}) {
  return spawnSync(process.execPath, [DEPLOYMENT_SCRIPT, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function createFakeKubectl(t, overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deployment-kubectl-"));
  const logPath = path.join(directory, "calls.jsonl");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "kubectl");
  const rendered = {
    k3s: indexDocuments(render("overlays/k3s-online")),
    kind: indexDocuments(render("overlays/kind-evaluation")),
  };
  const deploymentFixtures = {
    k3s: {
      "agent-runtime": getResource(
        rendered.k3s,
        "Deployment",
        "agent-runtime",
        "k8s-incident-agent",
      ),
      "incident-console": getResource(
        rendered.k3s,
        "Deployment",
        "incident-console",
        "k8s-incident-agent",
      ),
    },
    kind: {
      "agent-runtime": getResource(
        rendered.kind,
        "Deployment",
        "agent-runtime",
        "k8s-incident-agent",
      ),
      "incident-console": getResource(
        rendered.kind,
        "Deployment",
        "incident-console",
        "k8s-incident-agent",
      ),
    },
  };
  const networkPolicyFixtures = Object.fromEntries(
    Object.entries(rendered).map(([profile, resources]) => [
      profile,
      [...resources.values()].filter(
        (resource) => resource.kind === "NetworkPolicy",
      ),
    ]),
  );
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify({ args, input }) + "\\n");
  const contextIndex = args.indexOf("--context");
  const commandArgs = contextIndex === -1 ? args : args.slice(contextIndex + 2);
  const key = commandArgs.join(" ");
  const output = response(key, commandArgs);
  if (output === undefined) {
    process.stderr.write("unexpected fake kubectl command");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(typeof output === "string" ? output : JSON.stringify(output));
});

const deploymentFixtures = ${JSON.stringify(deploymentFixtures)};
const networkPolicyFixtures = ${JSON.stringify(networkPolicyFixtures)};
const lockedImages = ${JSON.stringify([CONSOLE_IMAGE, RUNTIME_IMAGE])};

function deployment(name) {
  const profile = process.env.FAKE_PROFILE === "kind-evaluation" ? "kind" : "k3s";
  const document = structuredClone(deploymentFixtures[profile][name]);
  document.metadata.generation = 3;
  document.status = { observedGeneration: 3, replicas: 1, updatedReplicas: 1, availableReplicas: 1 };
  return document;
}

function response(key, args) {
  if (key.startsWith("kustomize ")) {
    const result = spawnSync(process.env.REAL_KUBECTL, args, { encoding: "utf8" });
    if (result.status !== 0) process.exitCode = result.status;
    return result.stdout;
  }
  if (key === "version --client --output=json") {
    return { clientVersion: { gitVersion: process.env.FAKE_CLIENT_VERSION || "v1.36.2" } };
  }
  if (key === "version --output=json") {
    return { serverVersion: { gitVersion: process.env.FAKE_SERVER_VERSION || "v1.36.3+k3s1" } };
  }
  const component = key.match(/^get deployment (coredns|traefik|local-path-provisioner) --namespace kube-system --output=json$/);
  if (component) {
    const versions = { coredns: "1.14.6", traefik: "3.7.8", "local-path-provisioner": "0.0.36" };
    return {
      metadata: { generation: 2 },
      spec: { replicas: 1, template: { spec: { containers: [{ image: "registry.example/" + component[1] + ":" + versions[component[1]] }] } } },
      status: {
        observedGeneration: 2,
        replicas: 1,
        updatedReplicas: process.env.FAKE_COMPONENT_STALE_ROLLOUT === component[1] ? 0 : 1,
        availableReplicas: process.env.FAKE_COMPONENT_UNAVAILABLE === component[1] ? 0 : 1,
      },
    };
  }
  if (key === "get storageclass local-path --output=json") {
    return {
      metadata: { annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
      provisioner: "rancher.io/local-path",
    };
  }
  if (key === 'get secret agent-runtime-model --namespace k8s-incident-agent --output=go-template={{if index .data "api-key"}}present{{else}}missing{{end}}') {
    return process.env.FAKE_SECRET_MISSING === "1" ? "missing\\n" : "present\\n";
  }
  if (key === "get nodes --output=json") {
    const availableImages = process.env.FAKE_IMAGE_MISSING === "1"
      ? lockedImages.slice(0, 1)
      : lockedImages;
    return {
      kind: "NodeList",
      items: [{
        metadata: { name: "single-node" },
        status: {
          conditions: [{ type: "Ready", status: "True" }],
          images: availableImages.map((name) => ({ names: ["docker.io/library/" + name] })),
        },
      }],
    };
  }
  if (key === "get deployment agent-runtime --namespace k8s-incident-agent --output=json") {
    return deployment("agent-runtime");
  }
  if (key === "get deployment incident-console --namespace k8s-incident-agent --output=json") {
    return deployment("incident-console");
  }
  if (key === "get pods --namespace k8s-incident-agent --selector=app.kubernetes.io/part-of=k8s-incident-agent --output=json") {
    const pods = [
      ["agent-runtime", "runtime-current"],
      ["incident-console", "console-current"],
    ].map(([appName, name]) => ({
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/name": appName,
          "app.kubernetes.io/part-of": "k8s-incident-agent",
        },
      },
      status: { phase: "Running", containerStatuses: [{ ready: true }] },
    }));
    if (process.env.FAKE_TERMINATING_CONSOLE === "1") {
      pods.push({
        metadata: {
          name: "console-old",
          deletionTimestamp: "2026-08-31T00:00:00Z",
          labels: {
            "app.kubernetes.io/name": "incident-console",
            "app.kubernetes.io/part-of": "k8s-incident-agent",
          },
        },
        status: { phase: "Running", containerStatuses: [{ ready: false }] },
      });
    }
    return { kind: "PodList", items: pods };
  }
  const service = key.match(/^get service (agent-runtime|incident-console) --namespace k8s-incident-agent --output=json$/);
  if (service) {
    return {
      kind: "Service",
      metadata: { name: service[1], namespace: "k8s-incident-agent" },
      spec: {
        type: "ClusterIP",
        clusterIP: "10.43.0.20",
        selector: { "app.kubernetes.io/name": service[1] },
        ports: [{
          port: service[1] === "agent-runtime" ? 8000 : 80,
          protocol: "TCP",
          targetPort: "http",
        }],
      },
    };
  }
  if (key === "get persistentvolumeclaim runtime-data --namespace k8s-incident-agent --output=json" || key === "get persistentvolumeclaim runtime-data --namespace k8s-incident-agent --ignore-not-found=true --output=json") {
    const kind = process.env.FAKE_PROFILE === "kind-evaluation";
    return { kind: "PersistentVolumeClaim", metadata: { name: "runtime-data", namespace: "k8s-incident-agent", uid: "pvc-uid" }, spec: { storageClassName: kind ? "k8s-incident-agent-kind" : "local-path", volumeName: kind ? "k8s-incident-agent-runtime-data" : "pvc-volume" }, status: { phase: "Bound" } };
  }
  if (key === "get configmap agent-runtime-config --namespace k8s-incident-agent --output=json" || key === "get configmap incident-console-config --namespace k8s-incident-agent --output=json") {
    const runtime = key.includes("agent-runtime-config");
    return {
      kind: "ConfigMap",
      metadata: {
        name: runtime ? "agent-runtime-config" : "incident-console-config",
        namespace: "k8s-incident-agent",
      },
      data: runtime
        ? {
          INCIDENT_INTAKE_MODE: process.env.FAKE_INTAKE_MODE || "online",
          KUBERNETES_CLUSTER_ID: "k8s-incident-agent",
          KUBERNETES_CREDENTIAL_MODE: "in_cluster",
          KUBERNETES_DIAGNOSTIC_NAMESPACE: "k8s-incident-scenarios",
          RUNTIME_DATA_DIR: "/var/lib/k8s-incident-agent/runtime",
          SCENARIO_CATALOG_DIR: "/workspace/scenarios",
        }
        : {
          AGENT_RUNTIME_URL: "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000",
          INCIDENT_INTAKE_MODE: process.env.FAKE_INTAKE_MODE || "online",
        },
    };
  }
  if (key === "get networkpolicies --namespace k8s-incident-agent --output=json") {
    const profile = process.env.FAKE_PROFILE === "kind-evaluation" ? "kind" : "k3s";
    const items = structuredClone(networkPolicyFixtures[profile]);
    if (process.env.FAKE_NETWORK_POLICY_DRIFT === "1") {
      items.find((item) => item.metadata.name === "default-deny").spec.ingress = [{}];
    }
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicyList",
      items,
    };
  }
  if (key === "get ingress incident-console --namespace k8s-incident-agent --output=json") {
    return {
      kind: "Ingress",
      metadata: { name: "incident-console", namespace: "k8s-incident-agent" },
      spec: {
        ingressClassName: "traefik",
        rules: [{ http: { paths: [{ backend: { service: { name: "incident-console", port: { name: "http" } } } }] } }],
      },
      status: {
        loadBalancer: {
          ingress: process.env.FAKE_INGRESS_UNAVAILABLE === "1" ? [] : [{ ip: "192.0.2.10" }],
        },
      },
    };
  }
  if (key.startsWith("auth can-i ")) {
    const denied = [" get secrets ", " create pods --subresource=exec ", " create deployments.apps ", " update deployments.apps ", " patch deployments.apps ", " delete deployments.apps "];
    if (denied.some((needle) => (" " + key + " ").includes(needle))) {
      process.exitCode = 1;
      return "no\\n";
    }
    return "yes\\n";
  }
  if (key.startsWith("apply ") || key.startsWith("rollout status ") || key.startsWith("delete --ignore-not-found=true ") || key.startsWith("wait --for=delete ")) return "ok\\n";
  if (key === "get deployments.apps,replicasets.apps,statefulsets.apps,daemonsets.apps,jobs.batch,cronjobs.batch,replicationcontrollers,pods --namespace k8s-incident-agent --ignore-not-found=true --output=name") {
    return process.env.FAKE_ACTIVE_WORKLOAD === "1" ? "pod/agent-runtime-active\\n" : "";
  }
  if (key === "get persistentvolume pvc-volume --output=json") {
    return { kind: "PersistentVolume", metadata: { name: "pvc-volume", uid: "pv-uid" }, spec: { claimRef: { uid: "pvc-uid", name: "runtime-data", namespace: "k8s-incident-agent" }, persistentVolumeReclaimPolicy: "Delete" } };
  }
  if (key === "delete --raw /api/v1/namespaces/k8s-incident-agent/persistentvolumeclaims/runtime-data --filename=-") return "{}";
  return undefined;
}
`,
    "utf8",
  );
  chmodSync(executable, 0o755);
  return {
    environment: {
      FAKE_KUBECTL_LOG: logPath,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      REAL_KUBECTL,
      ...overrides,
    },
    calls() {
      const content = readFileSync(logPath, "utf8");
      return content.trim() === ""
        ? []
        : content.trim().split("\n").map((line) => JSON.parse(line));
    },
  };
}

test("lifecycle preview is offline and uninstall inventory excludes retained data", () => {
  const install = runDeployment([
    "install",
    "k3s-evaluation",
  ]);
  assert.equal(install.status, 0, install.stderr);
  const installResult = JSON.parse(install.stdout);
  assert.equal(installResult.mode, "preview");
  assert.equal(
    installResult.resources.includes(
      "PersistentVolumeClaim/k8s-incident-agent/runtime-data",
    ),
    true,
  );

  const uninstall = runDeployment([
    "uninstall",
    "k3s-evaluation",
    "--preview",
  ]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  const uninstallResult = JSON.parse(uninstall.stdout);
  assert.equal(
    uninstallResult.resources.some((resource) =>
      resource.startsWith("PersistentVolume"),
    ),
    false,
  );
  assert.equal(
    uninstallResult.resources.some((resource) => resource.startsWith("Namespace/")),
    false,
  );
});

test("kubectl-shaped context input is rejected before external execution", () => {
  const result = runDeployment([
    "status",
    "k3s-online",
    "--context",
    "--kubeconfig=/tmp/other-config",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL invalid_argument /);
});

test("confirmed online install preflights, applies, waits, and reports the real status contract", (t) => {
  const fake = createFakeKubectl(t);
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "install",
    cluster: "k3s",
    deployments: "ready",
    ingress: "traefik-ready",
    intakeMode: "online",
    networkPolicies: "matched",
    networkPolicyEnforcement: "requires-task-5-live-probe",
    pods: 2,
    profile: "k3s-online",
    pvc: { name: "runtime-data", phase: "Bound", volumeName: "pvc-volume" },
    rbac: "matched",
    services: "cluster-ip-only",
  });
  assert.equal(result.stdout.includes("api-key"), false);
  const calls = fake.calls().map((call) => call.args.join(" "));
  assert.equal(
    calls.some((call) => call.includes("apply --dry-run=server --kustomize")),
    true,
  );
  assert.equal(
    calls.some((call) => call.includes("apply --kustomize")),
    true,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.includes("rollout status deployment/"))
      .map((call) => call.match(/deployment\/[^ ]+/)?.[0])
      .sort(),
    ["deployment/agent-runtime", "deployment/incident-console"],
  );
  const subject =
    "--as=system:serviceaccount:k8s-incident-agent:agent-runtime";
  const namespace = "--namespace k8s-incident-scenarios";
  assert.deepEqual(
    calls
      .filter((call) => call.includes("auth can-i"))
      .map((call) => call.slice(call.indexOf("auth can-i")))
      .sort(),
    [
      `auth can-i get deployments.apps ${subject} ${namespace}`,
      `auth can-i list replicasets.apps ${subject} ${namespace}`,
      `auth can-i list pods ${subject} ${namespace}`,
      `auth can-i list events.events.k8s.io ${subject} ${namespace}`,
      `auth can-i create selfsubjectaccessreviews.authorization.k8s.io ${subject}`,
      `auth can-i get secrets ${subject} ${namespace}`,
      `auth can-i create pods --subresource=exec ${subject} ${namespace}`,
      `auth can-i create deployments.apps ${subject} ${namespace}`,
      `auth can-i update deployments.apps ${subject} ${namespace}`,
      `auth can-i patch deployments.apps ${subject} ${namespace}`,
      `auth can-i delete deployments.apps ${subject} ${namespace}`,
    ].sort(),
  );
});

test("Kind status accepts the fixed ownership init and exact producer lists", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_INTAKE_MODE: "manual",
    FAKE_PROFILE: "kind-evaluation",
    FAKE_SERVER_VERSION: "v1.36.1",
  });
  const result = runDeployment(
    [
      "status",
      "kind-evaluation",
      "--context",
      "kind-k8s-incident-agent",
    ],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cluster: "kind",
    deployments: "ready",
    ingress: "not-installed",
    intakeMode: "manual",
    networkPolicies: "matched",
    networkPolicyEnforcement: "requires-task-5-live-probe",
    pods: 2,
    profile: "kind-evaluation",
    pvc: {
      name: "runtime-data",
      phase: "Bound",
      volumeName: "k8s-incident-agent-runtime-data",
    },
    rbac: "matched",
    services: "cluster-ip-only",
  });
});

test("status rejects an additive NetworkPolicy that broadens the fixed profile", (t) => {
  const fake = createFakeKubectl(t, { FAKE_NETWORK_POLICY_DRIFT: "1" });
  const result = runDeployment(
    ["status", "k3s-online", "--context", "demo-k3s"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL installation_not_ready /);
});

test("status rejects an Ingress without a Traefik address", (t) => {
  const fake = createFakeKubectl(t, { FAKE_INGRESS_UNAVAILABLE: "1" });
  const result = runDeployment(
    ["status", "k3s-online", "--context", "demo-k3s"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL installation_not_ready /);
});

test("status ignores an old terminating Console Pod after rollout", (t) => {
  const fake = createFakeKubectl(t, { FAKE_TERMINATING_CONSOLE: "1" });
  const result = runDeployment(
    ["status", "k3s-online", "--context", "demo-k3s"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pods, 2);
});

test("confirmed install rejects an unavailable fixed K3s component before apply", (t) => {
  const fake = createFakeKubectl(t, { FAKE_COMPONENT_UNAVAILABLE: "traefik" });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL component_not_ready /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed install rejects a K3s component still serving only old Pods", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_COMPONENT_STALE_ROLLOUT: "traefik",
  });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL component_not_ready /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed install rejects a missing locked node image before apply", (t) => {
  const fake = createFakeKubectl(t, { FAKE_IMAGE_MISSING: "1" });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL image_unavailable /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed write fails before cluster access when kubectl is not the fixed version", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CLIENT_VERSION: "v1.33.1" });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL client_version_mismatch /);
  assert.deepEqual(
    fake.calls().map((call) => call.args),
    [["version", "--client", "--output=json"]],
  );
});

test("uninstall does not depend on a healthy model Secret and preserves the same PVC identity", (t) => {
  const fake = createFakeKubectl(t, { FAKE_SECRET_MISSING: "1" });
  const result = runDeployment(
    ["uninstall", "k3s-evaluation", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "uninstall",
    mode: "confirmed",
    profile: "k3s-evaluation",
    retainedPvc: "runtime-data",
  });
  const calls = fake.calls().map((call) => call.args.join(" "));
  assert.equal(calls.some((call) => call.includes("get secret")), false);
  assert.equal(
    calls.some((call) => call.includes("delete --ignore-not-found=true --wait=true --kustomize")),
    true,
  );
});

test("purge binds confirmation to current K3s PVC and PV UIDs before raw deletion", (t) => {
  const fake = createFakeKubectl(t);
  const preview = runDeployment(
    ["purge", "k3s-online", "--context", "demo-k3s", "--preview"],
    fake.environment,
  );
  assert.equal(preview.status, 0, preview.stderr);
  const target = JSON.parse(preview.stdout);
  assert.equal(target.confirmation, "purge:demo-k3s:pvc-uid:pv-uid");

  const rejected = runDeployment(
    [
      "purge",
      "k3s-online",
      "--context",
      "demo-k3s",
      "--confirm",
      "purge:demo-k3s:old-pvc:old-pv",
    ],
    fake.environment,
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /^FAIL purge_confirmation_mismatch /);

  const confirmed = runDeployment(
    [
      "purge",
      "k3s-online",
      "--context",
      "demo-k3s",
      "--confirm",
      target.confirmation,
    ],
    fake.environment,
  );
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const calls = fake.calls();
  const rawDeletes = calls.filter((call) =>
    call.args.includes("/api/v1/namespaces/k8s-incident-agent/persistentvolumeclaims/runtime-data"),
  );
  assert.equal(rawDeletes.length, 1);
  assert.deepEqual(JSON.parse(rawDeletes[0].input), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: "pvc-uid" },
    propagationPolicy: "Foreground",
  });
  assert.deepEqual(
    calls
      .filter((call) => call.args.includes("--for=delete"))
      .flatMap((call) =>
        call.args.filter((argument) => argument.startsWith("persistentvolume")),
      )
      .sort(),
    [
      "persistentvolume/pvc-volume",
      "persistentvolumeclaim/runtime-data",
    ],
  );
});

test("purge rejects a terminating or active workload before reading data targets", (t) => {
  const fake = createFakeKubectl(t, { FAKE_ACTIVE_WORKLOAD: "1" });
  const result = runDeployment(
    ["purge", "k3s-online", "--context", "demo-k3s", "--preview"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL purge_workload_active /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("persistentvolumeclaim")),
    false,
  );
  const workloadCheck = fake
    .calls()
    .find((call) => call.args.some((argument) => argument.startsWith("deployments.apps,")));
  assert.ok(workloadCheck);
  assert.equal(
    workloadCheck.args.some((argument) => argument.startsWith("--selector=")),
    false,
  );
});

test("Kind purge fails closed instead of claiming hostPath data deletion", () => {
  const result = runDeployment([
    "purge",
    "kind-evaluation",
    "--context",
    "kind-k8s-incident-agent",
    "--preview",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL purge_unsupported /);
});
