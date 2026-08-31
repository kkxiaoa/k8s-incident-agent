import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { load, loadAll } from "js-yaml";

import {
  loadKindVersionContract,
  parseKubectlClientVersion,
  parseSemanticVersion,
} from "./doctor.mjs";

const APPLICATION_NAMESPACE = "k8s-incident-agent";
const DIAGNOSTIC_NAMESPACE = "k8s-incident-scenarios";
const KIND_CONTEXT = "kind-k8s-incident-agent";
const RUNTIME_SERVICE_ACCOUNT = "agent-runtime";
const RUNTIME_SECRET = "agent-runtime-model";
const RUNTIME_SECRET_KEY = "api-key";
const RUNTIME_PVC = "runtime-data";
const COMMAND_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const READ_TIMEOUT_MILLISECONDS = 30_000;
const WRITE_TIMEOUT_MILLISECONDS = 10 * 60_000;
const WAIT_TIMEOUT = "300s";

const PROFILE_DEFINITIONS = Object.freeze({
  "kind-evaluation": Object.freeze({
    platform: "kind",
    intakeMode: "manual",
    overlay: "overlays/kind-evaluation",
    uninstall: "uninstall/kind",
  }),
  "k3s-evaluation": Object.freeze({
    platform: "k3s",
    intakeMode: "manual",
    overlay: "overlays/k3s-evaluation",
    uninstall: "uninstall/k3s",
  }),
  "k3s-online": Object.freeze({
    platform: "k3s",
    intakeMode: "online",
    overlay: "overlays/k3s-online",
    uninstall: "uninstall/k3s",
  }),
});

export class DeploymentContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeploymentContractError";
    this.code = code;
  }
}

async function main() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const request = parseArguments(process.argv.slice(2));
  const contract = await loadDeploymentContract(repositoryRoot);
  const execute = executeExternalCommand;

  if (request.action === "render") {
    process.stdout.write(await renderProfile(contract, request.profile, execute));
    return;
  }

  if (
    request.action === "install" ||
    request.action === "upgrade" ||
    request.action === "uninstall"
  ) {
    if (request.mode === "preview") {
      printJson(
        await previewLifecycleAction(
          contract,
          request.action,
          request.profile,
          execute,
        ),
      );
      return;
    }
    printJson(
      request.action === "uninstall"
        ? await confirmUninstall(contract, request, execute)
        : await confirmApply(contract, request, execute),
    );
    return;
  }

  if (request.action === "status") {
    printJson(
      await verifyDeploymentStatus(request.profile.name, request.context, {
        repositoryRoot,
        contract,
        execute,
      }),
    );
    return;
  }

  printJson(await runPurge(contract, request, execute));
}

export async function verifyDeploymentStatus(
  profileName,
  context,
  dependencies = {},
) {
  const repositoryRoot = path.resolve(
    dependencies.repositoryRoot ?? path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    ),
  );
  const profile = requireProfile(profileName);
  const normalizedContext = requireContextValue(context);
  const contract =
    dependencies.contract ?? await loadDeploymentContract(repositoryRoot);
  const execute = dependencies.execute ?? executeExternalCommand;
  return readInstallationStatus(
    contract,
    { action: "status", profile, context: normalizedContext },
    execute,
  );
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 2) {
    throw usageError();
  }
  const [action, profileName, ...rest] = argv;
  const profile = requireProfile(profileName);

  if (action === "render") {
    if (rest.length !== 0) throw usageError();
    return { action, profile };
  }

  if (action === "status") {
    const options = parseOptions(rest, { context: "required" });
    return { action, profile, context: options.context };
  }

  if (action === "install" || action === "upgrade" || action === "uninstall") {
    const options = parseOptions(rest, {
      context: "optional",
      lifecycleMode: true,
    });
    const mode = options.mode ?? "preview";
    if (
      (mode === "confirm" && options.context === undefined) ||
      (mode === "preview" && options.context !== undefined)
    ) {
      throw usageError();
    }
    return {
      action,
      profile,
      context: options.context,
      mode,
    };
  }

  if (action === "purge") {
    const options = parseOptions(rest, {
      context: "required",
      purgeMode: true,
    });
    return {
      action,
      profile,
      context: options.context,
      mode: options.mode,
      confirmation: options.confirmation,
    };
  }

  throw usageError();
}

function parseOptions(values, shape) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--context" && shape.context && options.context === undefined) {
      options.context = requireContextValue(values[index + 1]);
      index += 1;
      continue;
    }
    if (
      value === "--preview" &&
      (shape.lifecycleMode || shape.purgeMode) &&
      options.mode === undefined
    ) {
      options.mode = "preview";
      continue;
    }
    if (
      value === "--confirm" &&
      (shape.lifecycleMode || shape.purgeMode) &&
      options.mode === undefined
    ) {
      options.mode = "confirm";
      if (shape.purgeMode) {
        options.confirmation = requireNormalizedValue(
          values[index + 1],
          "purge confirmation",
        );
        index += 1;
      }
      continue;
    }
    throw usageError();
  }

  if (shape.context === "required" && options.context === undefined) {
    throw usageError();
  }
  if (shape.purgeMode && options.mode === undefined) {
    throw usageError();
  }
  return options;
}

function requireNormalizedValue(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new DeploymentContractError(
      "invalid_argument",
      `${label} must be a normalized non-empty value`,
    );
  }
  return value;
}

function requireContextValue(value) {
  const context = requireNormalizedValue(value, "context");
  if (context.startsWith("-")) {
    throw new DeploymentContractError(
      "invalid_argument",
      "context must not be parsed as a kubectl option",
    );
  }
  return context;
}

function requireProfile(name) {
  const definition = PROFILE_DEFINITIONS[name];
  if (definition === undefined) throw usageError();
  return { name, ...definition };
}

function usageError() {
  return new DeploymentContractError(
    "usage_invalid",
    "expected render, status, install, upgrade, uninstall, or purge with a fixed deployment profile",
  );
}

async function loadDeploymentContract(repositoryRoot) {
  const applicationRoot = path.join(repositoryRoot, "deploy", "application");
  const [rawK3s, rawImageLock, kind] = await Promise.all([
    readFile(path.join(applicationRoot, "versions.json"), "utf8"),
    readFile(
      path.join(applicationRoot, "base", "workloads", "kustomization.yaml"),
      "utf8",
    ),
    loadKindVersionContract(repositoryRoot),
  ]);
  const k3sDocument = parseJsonObject(rawK3s, "K3s version contract");
  const k3sVersion = requireString(k3sDocument.k3s, "K3s version");
  const kubernetesVersion = requireString(
    k3sDocument.kubernetes,
    "K3s Kubernetes version",
  );
  const components = requireObject(
    k3sDocument.components,
    "K3s component versions",
  );
  if (
    parseSemanticVersion(k3sVersion) !== parseSemanticVersion(kubernetesVersion)
  ) {
    throw new DeploymentContractError(
      "version_contract_invalid",
      "K3s and Kubernetes patch versions must match",
    );
  }

  const imageLock = load(rawImageLock);
  if (imageLock === null || typeof imageLock !== "object") {
    throw new DeploymentContractError(
      "image_lock_invalid",
      "Kustomize image lock is invalid",
    );
  }
  const images = normalizeImageLock(imageLock.images);

  return {
    repositoryRoot,
    applicationRoot,
    kind,
    k3s: {
      version: k3sVersion,
      kubernetesVersion,
      components: {
        coredns: requireVersion(components.coredns, "CoreDNS"),
        localPathProvisioner: requireVersion(
          components.localPathProvisioner,
          "local-path-provisioner",
        ),
        traefik: requireVersion(components.traefik, "Traefik"),
      },
    },
    images,
  };
}

function normalizeImageLock(rawImages) {
  if (!Array.isArray(rawImages) || rawImages.length !== 2) {
    throw new DeploymentContractError(
      "image_lock_invalid",
      "Kustomize image lock must contain exactly two images",
    );
  }
  const images = {};
  for (const entry of rawImages) {
    const name = requireString(entry?.name, "locked image name");
    const newName = requireString(entry?.newName, "locked image repository");
    const digest = requireString(entry?.digest, "locked image digest");
    if (
      name !== newName ||
      !["k8s-incident-agent-console", "k8s-incident-agent-runtime"].includes(
        name,
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      images[name] !== undefined
    ) {
      throw new DeploymentContractError(
        "image_lock_invalid",
        "Kustomize image lock is not immutable or uses an unexpected identity",
      );
    }
    images[name] = `${newName}@${digest}`;
  }
  if (Object.keys(images).length !== 2) {
    throw new DeploymentContractError(
      "image_lock_invalid",
      "Kustomize image lock is incomplete",
    );
  }
  return images;
}

async function renderProfile(contract, profile, execute) {
  return executeCommand(
    execute,
    "kubectl",
    ["kustomize", profilePath(contract, profile.overlay)],
    READ_TIMEOUT_MILLISECONDS,
    "Kustomize render",
  );
}

async function previewLifecycleAction(
  contract,
  action,
  profile,
  execute,
) {
  const directory =
    action === "uninstall" ? profile.uninstall : profile.overlay;
  const rendered = await executeCommand(
    execute,
    "kubectl",
    ["kustomize", profilePath(contract, directory)],
    READ_TIMEOUT_MILLISECONDS,
    "Kustomize preview",
  );
  return {
    action,
    mode: "preview",
    profile: profile.name,
    resources: manifestInventory(rendered),
  };
}

async function confirmApply(contract, request, execute) {
  await requireClusterPrerequisites(contract, request, execute, {
    components: true,
    images: true,
    secret: true,
  });
  const overlayPath = profilePath(contract, request.profile.overlay);
  await runKubectl(
    execute,
    request.context,
    ["apply", "--dry-run=server", "--kustomize", overlayPath],
    WRITE_TIMEOUT_MILLISECONDS,
    "server-side admission preview",
  );
  await runKubectl(
    execute,
    request.context,
    ["apply", "--kustomize", overlayPath],
    WRITE_TIMEOUT_MILLISECONDS,
    `${request.action} apply`,
  );
  for (const deployment of ["agent-runtime", "incident-console"]) {
    await runKubectl(
      execute,
      request.context,
      [
        "rollout",
        "status",
        `deployment/${deployment}`,
        "--namespace",
        APPLICATION_NAMESPACE,
        `--timeout=${WAIT_TIMEOUT}`,
      ],
      WRITE_TIMEOUT_MILLISECONDS,
      `${deployment} rollout`,
    );
  }
  return readInstallationStatus(contract, request, execute, {
    prerequisitesVerified: true,
    action: request.action,
  });
}

async function confirmUninstall(contract, request, execute) {
  await requireClusterPrerequisites(contract, request, execute, {
    components: false,
    secret: false,
  });
  const before = await readOptionalPvc(request, execute);
  await runKubectl(
    execute,
    request.context,
    [
      "delete",
      "--ignore-not-found=true",
      "--wait=true",
      "--kustomize",
      profilePath(contract, request.profile.uninstall),
    ],
    WRITE_TIMEOUT_MILLISECONDS,
    "workload uninstall",
  );
  const after = await readOptionalPvc(request, execute);
  if (
    before !== null &&
    (after === null || after.metadata?.uid !== before.metadata?.uid)
  ) {
    throw new DeploymentContractError(
      "data_retention_failed",
      "uninstall did not preserve the existing Runtime PVC",
    );
  }
  return {
    action: "uninstall",
    mode: "confirmed",
    profile: request.profile.name,
    retainedPvc: after === null ? null : RUNTIME_PVC,
  };
}

async function readInstallationStatus(
  contract,
  request,
  execute,
  options = {},
) {
  if (!options.prerequisitesVerified) {
    await requireClusterPrerequisites(contract, request, execute, {
      components: true,
      images: false,
      secret: true,
    });
  }
  const [
    runtime,
    console,
    pods,
    runtimeService,
    consoleService,
    pvc,
    runtimeConfig,
    consoleConfig,
    networkPolicies,
    desiredManifest,
  ] = await Promise.all([
      readJsonResource(execute, request.context, [
        "get",
        "deployment",
        "agent-runtime",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "Runtime Deployment"),
      readJsonResource(execute, request.context, [
        "get",
        "deployment",
        "incident-console",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "Console Deployment"),
      readJsonResource(execute, request.context, [
        "get",
        "pods",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--selector=app.kubernetes.io/part-of=k8s-incident-agent",
        "--output=json",
      ], "application Pods"),
      readJsonResource(execute, request.context, [
        "get",
        "service",
        "agent-runtime",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "Runtime Service"),
      readJsonResource(execute, request.context, [
        "get",
        "service",
        "incident-console",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "Console Service"),
      readJsonResource(execute, request.context, [
        "get",
        "persistentvolumeclaim",
        RUNTIME_PVC,
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "Runtime PVC"),
      readJsonResource(execute, request.context, [
        "get",
        "configmap",
        "agent-runtime-config",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "Runtime ConfigMap"),
      readJsonResource(execute, request.context, [
        "get",
        "configmap",
        "incident-console-config",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "Console ConfigMap"),
      readJsonResource(execute, request.context, [
        "get",
        "networkpolicies",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--output=json",
      ], "application NetworkPolicies"),
      renderProfile(contract, request.profile, execute),
    ]);

  requireReadyDeployment(
    runtime,
    "agent-runtime",
    contract.images,
    request.profile,
  );
  requireReadyDeployment(
    console,
    "incident-console",
    contract.images,
    request.profile,
  );
  requireReadyPods(pods);
  requireClusterIpService(runtimeService, "agent-runtime", 8000);
  requireClusterIpService(consoleService, "incident-console", 80);
  const volumeName = requireBoundPvc(pvc, request.profile);
  requireRuntimeConfig(runtimeConfig, request.profile.intakeMode);
  requireConsoleConfig(consoleConfig, request.profile.intakeMode);
  requireNetworkPolicies(networkPolicies, desiredManifest);
  if (request.profile.platform === "k3s") {
    const ingress = await readJsonResource(execute, request.context, [
      "get",
      "ingress",
      "incident-console",
      "--namespace",
      APPLICATION_NAMESPACE,
      "--output=json",
    ], "Console Ingress");
    requireReadyIngress(ingress);
  }
  await requireDiagnosticAccess(request, execute);

  return {
    ...(options.action === undefined ? {} : { action: options.action }),
    cluster: request.profile.platform,
    deployments: "ready",
    ingress:
      request.profile.platform === "k3s" ? "traefik-ready" : "not-installed",
    intakeMode: request.profile.intakeMode,
    networkPolicies: "matched",
    networkPolicyEnforcement: "requires-task-5-live-probe",
    pods: 2,
    profile: request.profile.name,
    pvc: { name: RUNTIME_PVC, phase: "Bound", volumeName },
    rbac: "matched",
    services: "cluster-ip-only",
  };
}

async function requireClusterPrerequisites(
  contract,
  request,
  execute,
  requirements,
) {
  const clientVersionRaw = await executeCommand(
    execute,
    "kubectl",
    ["version", "--client", "--output=json"],
    READ_TIMEOUT_MILLISECONDS,
    "kubectl client version",
  );
  let clientVersion;
  try {
    clientVersion = parseKubectlClientVersion(clientVersionRaw);
  } catch {
    throw new DeploymentContractError(
      "client_contract_invalid",
      "kubectl returned an invalid client version",
    );
  }
  if (clientVersion !== contract.kind.kubectl) {
    throw new DeploymentContractError(
      "client_version_mismatch",
      "installed kubectl does not match the fixed deployment baseline",
    );
  }
  if (
    request.profile.platform === "kind" &&
    request.context !== KIND_CONTEXT
  ) {
    throw new DeploymentContractError(
      "cluster_identity_mismatch",
      "Kind deployment requires the fixed project context",
    );
  }

  const serverVersion = await readJsonResource(execute, request.context, [
    "version",
    "--output=json",
  ], "Kubernetes server version");
  const actualServerVersion = requireString(
    serverVersion.serverVersion?.gitVersion,
    "Kubernetes server gitVersion",
  );
  const expectedServerVersion =
    request.profile.platform === "k3s"
      ? contract.k3s.version
      : `v${contract.kind.kubernetes}`;
  if (actualServerVersion !== expectedServerVersion) {
    throw new DeploymentContractError(
      "server_version_mismatch",
      "target Kubernetes server does not match the fixed profile baseline",
    );
  }

  if (requirements.components && request.profile.platform === "k3s") {
    await requireK3sComponents(contract, request.context, execute);
  }
  if (requirements.secret) {
    await requireRuntimeSecret(request.context, execute);
  }
  if (requirements.images) {
    await requireSingleNodeImages(contract, request.context, execute);
  }
}

async function requireK3sComponents(contract, context, execute) {
  const expected = [
    ["coredns", contract.k3s.components.coredns],
    ["traefik", contract.k3s.components.traefik],
    ["local-path-provisioner", contract.k3s.components.localPathProvisioner],
  ];
  for (const [name, version] of expected) {
    const deployment = await readJsonResource(execute, context, [
      "get",
      "deployment",
      name,
      "--namespace",
      "kube-system",
      "--output=json",
    ], `${name} Deployment`);
    const images = deployment.spec?.template?.spec?.containers?.map(
      (container) => container?.image,
    );
    if (
      !Array.isArray(images) ||
      !images.some((image) => imageHasVersion(image, version))
    ) {
      throw new DeploymentContractError(
        "component_version_mismatch",
        `${name} does not match the fixed K3s baseline`,
      );
    }
    const desiredReplicas = deployment.spec?.replicas ?? 1;
    if (
      !Number.isInteger(deployment.metadata?.generation) ||
      !Number.isInteger(desiredReplicas) ||
      desiredReplicas < 1 ||
      deployment.status?.observedGeneration !== deployment.metadata.generation ||
      deployment.status?.replicas !== desiredReplicas ||
      deployment.status?.updatedReplicas !== desiredReplicas ||
      deployment.status?.availableReplicas !== desiredReplicas
    ) {
      throw new DeploymentContractError(
        "component_not_ready",
        `${name} is not available at its current generation`,
      );
    }
  }

  const storageClass = await readJsonResource(execute, context, [
    "get",
    "storageclass",
    "local-path",
    "--output=json",
  ], "local-path StorageClass");
  if (
    storageClass.provisioner !== "rancher.io/local-path" ||
    storageClass.metadata?.annotations?.[
      "storageclass.kubernetes.io/is-default-class"
    ] !== "true"
  ) {
    throw new DeploymentContractError(
      "storage_contract_invalid",
      "K3s local-path StorageClass is missing or not the default",
    );
  }
}

async function requireRuntimeSecret(context, execute) {
  const state = (
    await runKubectl(
      execute,
      context,
      [
        "get",
        "secret",
        RUNTIME_SECRET,
        "--namespace",
        APPLICATION_NAMESPACE,
        `--output=go-template={{if index .data "${RUNTIME_SECRET_KEY}"}}present{{else}}missing{{end}}`,
      ],
      READ_TIMEOUT_MILLISECONDS,
      "Runtime model Secret key check",
    )
  ).trim();
  if (state !== "present") {
    throw new DeploymentContractError(
      "secret_contract_invalid",
      "Runtime model Secret is missing the required non-empty key",
    );
  }
}

async function requireSingleNodeImages(contract, context, execute) {
  const nodes = await readJsonResource(execute, context, [
    "get",
    "nodes",
    "--output=json",
  ], "Kubernetes Nodes");
  if (
    nodes.kind !== "NodeList" ||
    !Array.isArray(nodes.items) ||
    nodes.items.length !== 1
  ) {
    throw new DeploymentContractError(
      "cluster_topology_mismatch",
      "deployment profile requires exactly one Kubernetes node",
    );
  }
  const [node] = nodes.items;
  const ready = node.status?.conditions?.some(
    (condition) => condition?.type === "Ready" && condition?.status === "True",
  );
  const imageNames = node.status?.images?.flatMap((image) => image?.names ?? []);
  if (!ready || !Array.isArray(imageNames)) {
    throw new DeploymentContractError(
      "node_not_ready",
      "the fixed Kubernetes node is not ready",
    );
  }
  const expectedDigests = Object.values(contract.images).map(
    (image) => image.slice(image.indexOf("@") + 1),
  );
  if (
    expectedDigests.some(
      (digest) => !imageNames.some((name) => name.endsWith(`@${digest}`)),
    )
  ) {
    throw new DeploymentContractError(
      "image_unavailable",
      "the fixed deployment images are not available on the Kubernetes node",
    );
  }
}

async function requireDiagnosticAccess(request, execute) {
  const subject = `system:serviceaccount:${APPLICATION_NAMESPACE}:${RUNTIME_SERVICE_ACCOUNT}`;
  const checks = [
    { verb: "get", resource: "deployments.apps", expected: true, namespaced: true },
    { verb: "list", resource: "replicasets.apps", expected: true, namespaced: true },
    { verb: "list", resource: "pods", expected: true, namespaced: true },
    { verb: "list", resource: "events.events.k8s.io", expected: true, namespaced: true },
    {
      verb: "create",
      resource: "selfsubjectaccessreviews.authorization.k8s.io",
      expected: true,
      namespaced: false,
    },
    { verb: "get", resource: "secrets", expected: false, namespaced: true },
    {
      verb: "create",
      resource: "pods",
      subresource: "exec",
      expected: false,
      namespaced: true,
    },
    { verb: "create", resource: "deployments.apps", expected: false, namespaced: true },
    { verb: "update", resource: "deployments.apps", expected: false, namespaced: true },
    { verb: "patch", resource: "deployments.apps", expected: false, namespaced: true },
    { verb: "delete", resource: "deployments.apps", expected: false, namespaced: true },
  ];
  for (const check of checks) {
    const result = await runKubectlResult(
      execute,
      request.context,
      [
        "auth",
        "can-i",
        check.verb,
        check.resource,
        ...(check.subresource === undefined
          ? []
          : [`--subresource=${check.subresource}`]),
        `--as=${subject}`,
        ...(check.namespaced ? ["--namespace", DIAGNOSTIC_NAMESPACE] : []),
      ],
      READ_TIMEOUT_MILLISECONDS,
      "diagnostic access review",
      undefined,
      [0, 1],
    );
    const output = result.stdout.trim();
    const allowed = result.exitCode === 0 && output === "yes";
    const denied =
      result.exitCode === 1 && (output === "no" || output.startsWith("no - "));
    if ((check.expected && !allowed) || (!check.expected && !denied)) {
      throw new DeploymentContractError(
        "rbac_contract_invalid",
        "diagnostic ServiceAccount permissions do not match the Runtime gate",
      );
    }
  }
}

async function runPurge(contract, request, execute) {
  if (request.profile.platform !== "k3s") {
    throw new DeploymentContractError(
      "purge_unsupported",
      "Kind hostPath data cannot be proven deleted by removing Kubernetes objects",
    );
  }
  await requireClusterPrerequisites(contract, request, execute, {
    components: false,
    images: false,
    secret: false,
  });
  await requireWorkloadsAbsent(request, execute);
  const target = await readPurgeTarget(request, execute);
  if (request.mode === "preview") {
    return { action: "purge", mode: "preview", profile: request.profile.name, ...target };
  }
  if (request.confirmation !== target.confirmation) {
    throw new DeploymentContractError(
      "purge_confirmation_mismatch",
      "purge confirmation does not match the current PVC and PV identities",
    );
  }
  const deleteOptions = `${JSON.stringify({
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: target.pvcUid },
    propagationPolicy: "Foreground",
  })}\n`;
  await runKubectl(
    execute,
    request.context,
    [
      "delete",
      "--raw",
      `/api/v1/namespaces/${APPLICATION_NAMESPACE}/persistentvolumeclaims/${RUNTIME_PVC}`,
      "--filename=-",
    ],
    WRITE_TIMEOUT_MILLISECONDS,
    "Runtime PVC purge",
    deleteOptions,
  );
  await runKubectl(
    execute,
    request.context,
    [
      "wait",
      "--for=delete",
      `persistentvolumeclaim/${RUNTIME_PVC}`,
      "--namespace",
      APPLICATION_NAMESPACE,
      `--timeout=${WAIT_TIMEOUT}`,
    ],
    WRITE_TIMEOUT_MILLISECONDS,
    "Runtime PVC deletion",
  );
  await runKubectl(
    execute,
    request.context,
    [
      "wait",
      "--for=delete",
      `persistentvolume/${target.pvName}`,
      `--timeout=${WAIT_TIMEOUT}`,
    ],
    WRITE_TIMEOUT_MILLISECONDS,
    "Runtime PV reclamation",
  );
  return {
    action: "purge",
    mode: "confirmed",
    profile: request.profile.name,
    pvc: RUNTIME_PVC,
    pv: target.pvName,
  };
}

async function requireWorkloadsAbsent(request, execute) {
  const output = (
    await runKubectl(
      execute,
      request.context,
      [
        "get",
        "deployments.apps,replicasets.apps,statefulsets.apps,daemonsets.apps,jobs.batch,cronjobs.batch,replicationcontrollers,pods",
        "--namespace",
        APPLICATION_NAMESPACE,
        "--ignore-not-found=true",
        "--output=name",
      ],
      READ_TIMEOUT_MILLISECONDS,
      "Runtime workload check",
    )
  ).trim();
  if (output !== "") {
    throw new DeploymentContractError(
      "purge_workload_active",
      "uninstall workloads before purging Runtime data",
    );
  }
}

async function readPurgeTarget(request, execute) {
  const pvc = await readJsonResource(execute, request.context, [
    "get",
    "persistentvolumeclaim",
    RUNTIME_PVC,
    "--namespace",
    APPLICATION_NAMESPACE,
    "--output=json",
  ], "Runtime PVC");
  if (
    pvc.kind !== "PersistentVolumeClaim" ||
    pvc.metadata?.name !== RUNTIME_PVC ||
    pvc.metadata?.namespace !== APPLICATION_NAMESPACE
  ) {
    throw new DeploymentContractError(
      "purge_target_invalid",
      "Runtime PVC identity does not match the fixed purge target",
    );
  }
  const pvcUid = requireString(pvc.metadata?.uid, "Runtime PVC UID");
  const pvName = requireString(pvc.spec?.volumeName, "Runtime PV name");
  if (pvc.status?.phase !== "Bound") {
    throw new DeploymentContractError(
      "purge_target_invalid",
      "Runtime PVC must be Bound before purge",
    );
  }
  const pv = await readJsonResource(execute, request.context, [
    "get",
    "persistentvolume",
    pvName,
    "--output=json",
  ], "Runtime PV");
  if (pv.kind !== "PersistentVolume" || pv.metadata?.name !== pvName) {
    throw new DeploymentContractError(
      "purge_target_invalid",
      "Runtime PV identity does not match the bound purge target",
    );
  }
  const pvUid = requireString(pv.metadata?.uid, "Runtime PV UID");
  if (
    pv.spec?.claimRef?.uid !== pvcUid ||
    pv.spec?.claimRef?.name !== RUNTIME_PVC ||
    pv.spec?.claimRef?.namespace !== APPLICATION_NAMESPACE ||
    pv.spec?.persistentVolumeReclaimPolicy !== "Delete" ||
    pvc.spec?.storageClassName !== "local-path"
  ) {
    throw new DeploymentContractError(
      "purge_target_invalid",
      "Runtime PVC and PV do not match the fixed K3s deletion contract",
    );
  }
  return {
    confirmation: `purge:${request.context}:${pvcUid}:${pvUid}`,
    pvc: RUNTIME_PVC,
    pvcUid,
    pvName,
    pvUid,
    reclaimPolicy: "Delete",
    runtimeRoot: "/var/lib/k8s-incident-agent/runtime",
    storageClass: "local-path",
  };
}

async function readOptionalPvc(request, execute) {
  const output = await runKubectl(
    execute,
    request.context,
    [
      "get",
      "persistentvolumeclaim",
      RUNTIME_PVC,
      "--namespace",
      APPLICATION_NAMESPACE,
      "--ignore-not-found=true",
      "--output=json",
    ],
    READ_TIMEOUT_MILLISECONDS,
    "Runtime PVC retention check",
  );
  if (output.trim() === "") return null;
  return parseJsonObject(output, "Runtime PVC");
}

function requireReadyDeployment(document, name, images, profile) {
  const pod = document.spec?.template?.spec;
  const isRuntime = name === "agent-runtime";
  const expectedServiceAccount = isRuntime ? "agent-runtime" : "incident-console";
  if (
    document.kind !== "Deployment" ||
    document.metadata?.name !== name ||
    document.spec?.replicas !== 1 ||
    (isRuntime && document.spec?.strategy?.type !== "Recreate") ||
    pod?.serviceAccountName !== expectedServiceAccount ||
    pod?.automountServiceAccountToken !== false ||
    document.status?.observedGeneration !== document.metadata?.generation ||
    document.status?.replicas !== 1 ||
    document.status?.updatedReplicas !== 1 ||
    document.status?.availableReplicas !== 1
  ) {
    throw stateError(`${name} Deployment is not ready at one replica`);
  }
  const expectedImage =
    isRuntime
      ? images["k8s-incident-agent-runtime"]
      : images["k8s-incident-agent-console"];
  const initContainers = pod.initContainers ?? [];
  const containers = pod.containers ?? [];
  const expectedInitNames = isRuntime
    ? profile.platform === "kind"
      ? ["prepare-kind-volume", "migrate"]
      : ["migrate"]
    : [];
  const containerImages = [...initContainers, ...containers].map(
    (container) => container?.image,
  );
  if (
    !isDeepStrictEqual(
      initContainers.map((container) => container?.name),
      expectedInitNames,
    ) ||
    containers.length !== 1 ||
    containers[0]?.name !== (isRuntime ? "runtime" : "console") ||
    containerImages.some((image) => image !== expectedImage)
  ) {
    throw stateError(`${name} Deployment does not use the locked image`);
  }
  if (isRuntime) {
    const migration = initContainers.find(
      (container) => container?.name === "migrate",
    );
    const volumePreparation = initContainers.find(
      (container) => container?.name === "prepare-kind-volume",
    );
    const runtimeData = pod.volumes?.find(
      (volume) => volume?.name === "runtime-data",
    );
    const apiAccess = pod.volumes?.find(
      (volume) => volume?.name === "kubernetes-api-access",
    );
    if (
      runtimeData?.persistentVolumeClaim?.claimName !== RUNTIME_PVC ||
      !Array.isArray(apiAccess?.projected?.sources) ||
      !migration?.volumeMounts?.some(
        (mount) =>
          mount?.name === "runtime-data" &&
          mount?.mountPath === "/var/lib/k8s-incident-agent",
      ) ||
      !containers[0]?.volumeMounts?.some(
        (mount) =>
          mount?.name === "runtime-data" &&
          mount?.mountPath === "/var/lib/k8s-incident-agent",
      ) ||
      !containers[0]?.volumeMounts?.some(
        (mount) =>
          mount?.name === "kubernetes-api-access" &&
          mount?.mountPath ===
            "/var/run/secrets/kubernetes.io/serviceaccount" &&
          mount?.readOnly === true,
      )
    ) {
      throw stateError("agent-runtime Deployment does not use the fixed identity and storage");
    }
    if (
      profile.platform === "kind" &&
      (!isDeepStrictEqual(volumePreparation?.command, [
        "/usr/bin/chown",
        "10001:10001",
        "/var/lib/k8s-incident-agent",
      ]) ||
        volumePreparation?.securityContext?.runAsUser !== 0 ||
        volumePreparation?.securityContext?.runAsGroup !== 0 ||
        volumePreparation?.securityContext?.runAsNonRoot !== false ||
        volumePreparation?.securityContext?.allowPrivilegeEscalation !== false ||
        volumePreparation?.securityContext?.readOnlyRootFilesystem !== true ||
        !isDeepStrictEqual(volumePreparation?.securityContext?.capabilities, {
          add: ["CHOWN"],
          drop: ["ALL"],
        }) ||
        !volumePreparation?.volumeMounts?.some(
          (mount) =>
            mount?.name === "runtime-data" &&
            mount?.mountPath === "/var/lib/k8s-incident-agent",
        ))
    ) {
      throw stateError("Kind Runtime volume preparation is not minimally scoped");
    }
  }
}

function requireReadyPods(document) {
  if (document.kind !== "PodList" || !Array.isArray(document.items)) {
    throw stateError("application Pods are unavailable");
  }
  const activePods = document.items.filter(
    (pod) =>
      pod.metadata?.deletionTimestamp === undefined ||
      pod.metadata?.deletionTimestamp === null,
  );
  const expectedNames = new Set(["agent-runtime", "incident-console"]);
  const actualNames = new Set();
  if (activePods.length !== expectedNames.size) {
    throw stateError("application Pods are not both ready");
  }
  for (const pod of activePods) {
    const appName = pod.metadata?.labels?.["app.kubernetes.io/name"];
    if (
      pod.metadata?.labels?.["app.kubernetes.io/part-of"] !==
        "k8s-incident-agent" ||
      !expectedNames.has(appName) ||
      actualNames.has(appName) ||
      pod.status?.phase !== "Running" ||
      !Array.isArray(pod.status?.containerStatuses) ||
      pod.status.containerStatuses.length !== 1 ||
      pod.status.containerStatuses[0]?.ready !== true
    ) {
      throw stateError("application Pods are not both ready");
    }
    actualNames.add(appName);
  }
}

function requireClusterIpService(document, name, port) {
  const servicePort = document.spec?.ports?.[0];
  if (
    document.kind !== "Service" ||
    document.metadata?.name !== name ||
    document.metadata?.namespace !== APPLICATION_NAMESPACE ||
    document.spec?.type !== "ClusterIP" ||
    typeof document.spec?.clusterIP !== "string" ||
    document.spec.clusterIP === "" ||
    document.spec.clusterIP === "None" ||
    !isDeepStrictEqual(document.spec?.selector, {
      "app.kubernetes.io/name": name,
    }) ||
    document.spec?.ports?.length !== 1 ||
    servicePort?.port !== port ||
    servicePort?.targetPort !== "http" ||
    servicePort?.protocol !== "TCP"
  ) {
    throw stateError(`${name} Service is not a ready ClusterIP`);
  }
}

function requireBoundPvc(document, profile) {
  const expectedStorageClass =
    profile.platform === "k3s" ? "local-path" : "k8s-incident-agent-kind";
  if (
    document.kind !== "PersistentVolumeClaim" ||
    document.metadata?.name !== RUNTIME_PVC ||
    document.metadata?.namespace !== APPLICATION_NAMESPACE ||
    document.spec?.storageClassName !== expectedStorageClass ||
    document.status?.phase !== "Bound"
  ) {
    throw stateError("Runtime PVC is not Bound");
  }
  const volumeName = requireString(document.spec?.volumeName, "Runtime PV name");
  if (
    profile.platform === "kind" &&
    volumeName !== "k8s-incident-agent-runtime-data"
  ) {
    throw stateError("Runtime PVC does not use the fixed Kind volume");
  }
  return volumeName;
}

function requireRuntimeConfig(document, intakeMode) {
  const expected = {
    INCIDENT_INTAKE_MODE: intakeMode,
    KUBERNETES_CLUSTER_ID: "k8s-incident-agent",
    KUBERNETES_CREDENTIAL_MODE: "in_cluster",
    KUBERNETES_DIAGNOSTIC_NAMESPACE: DIAGNOSTIC_NAMESPACE,
    RUNTIME_DATA_DIR: "/var/lib/k8s-incident-agent/runtime",
    SCENARIO_CATALOG_DIR: "/workspace/scenarios",
  };
  if (
    document.kind !== "ConfigMap" ||
    document.metadata?.name !== "agent-runtime-config" ||
    document.metadata?.namespace !== APPLICATION_NAMESPACE ||
    Object.entries(expected).some(([key, value]) => document.data?.[key] !== value)
  ) {
    throw stateError("Runtime ConfigMap does not match the selected profile");
  }
}

function requireConsoleConfig(document, intakeMode) {
  if (
    document.kind !== "ConfigMap" ||
    document.metadata?.name !== "incident-console-config" ||
    document.metadata?.namespace !== APPLICATION_NAMESPACE ||
    document.data?.INCIDENT_INTAKE_MODE !== intakeMode ||
    document.data?.AGENT_RUNTIME_URL !==
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000"
  ) {
    throw stateError("Console ConfigMap does not match the selected profile");
  }
}

function requireReadyIngress(document) {
  const backend = document.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service;
  const addresses = document.status?.loadBalancer?.ingress;
  if (
    document.kind !== "Ingress" ||
    document.metadata?.name !== "incident-console" ||
    document.metadata?.namespace !== APPLICATION_NAMESPACE ||
    document.spec?.ingressClassName !== "traefik" ||
    backend?.name !== "incident-console" ||
    backend?.port?.name !== "http" ||
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    !addresses.some(
      (address) =>
        (typeof address?.ip === "string" && address.ip !== "") ||
        (typeof address?.hostname === "string" && address.hostname !== ""),
    )
  ) {
    throw stateError("Console Ingress is not ready through Traefik");
  }
}

function requireNetworkPolicies(document, desiredManifest) {
  if (
    document.kind !== "NetworkPolicyList" ||
    !Array.isArray(document.items)
  ) {
    throw stateError("application NetworkPolicies are unavailable");
  }
  const expected = new Map();
  try {
    loadAll(desiredManifest, (resource) => {
      if (resource?.kind !== "NetworkPolicy") return;
      const name = requireString(
        resource.metadata?.name,
        "rendered NetworkPolicy name",
      );
      if (
        resource.metadata?.namespace !== APPLICATION_NAMESPACE ||
        expected.has(name)
      ) {
        throw new DeploymentContractError(
          "render_contract_invalid",
          "rendered NetworkPolicy identity is invalid",
        );
      }
      expected.set(name, resource.spec);
    });
  } catch (error) {
    if (error instanceof DeploymentContractError) throw error;
    throw new DeploymentContractError(
      "render_contract_invalid",
      "Kustomize returned invalid NetworkPolicy YAML",
    );
  }
  if (expected.size === 0 || document.items.length !== expected.size) {
    throw stateError("application NetworkPolicies do not match the selected profile");
  }
  const actualNames = new Set();
  for (const policy of document.items) {
    const name = policy?.metadata?.name;
    if (
      policy?.kind !== "NetworkPolicy" ||
      policy?.metadata?.namespace !== APPLICATION_NAMESPACE ||
      typeof name !== "string" ||
      actualNames.has(name) ||
      !isDeepStrictEqual(policy.spec, expected.get(name))
    ) {
      throw stateError("application NetworkPolicies do not match the selected profile");
    }
    actualNames.add(name);
  }
}

function stateError(message) {
  return new DeploymentContractError("installation_not_ready", message);
}

function manifestInventory(rawYaml) {
  const resources = [];
  try {
    loadAll(rawYaml, (document) => {
      if (document === undefined || document === null) return;
      const kind = requireString(document.kind, "rendered resource kind");
      const name = requireString(
        document.metadata?.name,
        "rendered resource name",
      );
      const namespace = document.metadata?.namespace;
      resources.push(
        `${kind}/${
          typeof namespace === "string" && namespace !== ""
            ? `${namespace}/`
            : ""
        }${name}`,
      );
    });
  } catch (error) {
    if (error instanceof DeploymentContractError) throw error;
    throw new DeploymentContractError(
      "render_contract_invalid",
      "Kustomize returned invalid YAML",
    );
  }
  if (resources.length === 0 || new Set(resources).size !== resources.length) {
    throw new DeploymentContractError(
      "render_contract_invalid",
      "Kustomize render is empty or contains duplicate resource identities",
    );
  }
  return resources.sort();
}

function profilePath(contract, relativePath) {
  return path.join(contract.applicationRoot, relativePath);
}

function imageHasVersion(image, expectedVersion) {
  if (typeof image !== "string") return false;
  const normalized = parseSemanticVersion(expectedVersion);
  const escaped = normalized.replaceAll(".", "\\.");
  return new RegExp(`[:@]v?${escaped}(?:@sha256:[a-f0-9]{64})?$`).test(image);
}

function requireVersion(value, label) {
  const raw = requireString(value, `${label} version`);
  parseSemanticVersion(raw);
  return raw;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DeploymentContractError(
      "external_contract_invalid",
      `${label} is missing`,
    );
  }
  return value;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeploymentContractError(
      "external_contract_invalid",
      `${label} is missing`,
    );
  }
  return value;
}

function parseJsonObject(rawValue, label) {
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    throw new DeploymentContractError(
      "external_contract_invalid",
      `${label} is not valid JSON`,
    );
  }
  return requireObject(value, label);
}

async function readJsonResource(execute, context, args, label) {
  const output = await runKubectl(
    execute,
    context,
    args,
    READ_TIMEOUT_MILLISECONDS,
    label,
  );
  return parseJsonObject(output, label);
}

function runKubectl(execute, context, args, timeout, label, input) {
  return executeCommand(
    execute,
    "kubectl",
    ["--context", context, ...args],
    timeout,
    label,
    input,
  );
}

function runKubectlResult(
  execute,
  context,
  args,
  timeout,
  label,
  input,
  acceptedExitCodes,
) {
  return executeCommandResult(
    execute,
    "kubectl",
    ["--context", context, ...args],
    timeout,
    label,
    input,
    acceptedExitCodes,
  );
}

async function executeCommand(
  execute,
  command,
  args,
  timeoutMilliseconds,
  label,
  input,
) {
  return (
    await executeCommandResult(
      execute,
      command,
      args,
      timeoutMilliseconds,
      label,
      input,
      [0],
    )
  ).stdout;
}

async function executeCommandResult(
  execute,
  command,
  args,
  timeoutMilliseconds,
  label,
  input,
  acceptedExitCodes,
) {
  try {
    const result = await execute(command, args, {
      timeoutMilliseconds,
      maxBufferBytes: COMMAND_OUTPUT_LIMIT_BYTES,
      input,
    });
    if (
      result === null ||
      typeof result !== "object" ||
      typeof result.stdout !== "string" ||
      !Number.isInteger(result.exitCode) ||
      !acceptedExitCodes.includes(result.exitCode)
    ) {
      throw new Error("invalid command result");
    }
    return result;
  } catch {
    throw new DeploymentContractError(
      "external_command_failed",
      `${label} failed`,
    );
  }
}

function executeExternalCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        shell: false,
        encoding: "utf8",
        timeout: options.timeoutMilliseconds,
        maxBuffer: options.maxBufferBytes,
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ stdout, exitCode: 0 });
          return;
        }
        if (Number.isInteger(error.code)) {
          resolve({ stdout, exitCode: error.code });
          return;
        }
        reject(error);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    if (error instanceof DeploymentContractError) {
      process.stderr.write(`FAIL ${error.code} ${error.message}\n`);
    } else {
      process.stderr.write("FAIL unexpected deployment lifecycle failed\n");
    }
    process.exitCode = 1;
  }
}
