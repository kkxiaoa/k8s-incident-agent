import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const CUTOVER_JOB = "runtime-data-cutover";
const CUTOVER_CONTAINER = "runtime-reset";
const CUTOVER_GATE = "k8s-incident-agent.io/runtime-data-cutover";
const DEFAULT_DENY_POLICY = "default-deny";
const CUTOVER_CONFIRMATION_PATTERN = /^cutover:v1:sha256:[a-f0-9]{64}$/;
const PLAN_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CUTOVER_DEFAULT_TOLERATIONS = Object.freeze([
  Object.freeze({
    key: "node.kubernetes.io/not-ready",
    operator: "Exists",
    effect: "NoExecute",
    tolerationSeconds: 300,
  }),
  Object.freeze({
    key: "node.kubernetes.io/unreachable",
    operator: "Exists",
    effect: "NoExecute",
    tolerationSeconds: 300,
  }),
]);
const COMMAND_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const READ_TIMEOUT_MILLISECONDS = 30_000;
const WRITE_TIMEOUT_MILLISECONDS = 10 * 60_000;
const CUTOVER_DEADLINE_MILLISECONDS = 5 * 60_000;
const CUTOVER_POLL_INTERVAL_MILLISECONDS = 250;
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
const CUTOVER_PROFILES = new Set(["kind-evaluation", "k3s-evaluation"]);

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

  if (request.action === "cutover") {
    printJson(
      await runCutover(
        await loadCutoverContract(contract),
        request,
        execute,
      ),
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

  if (action === "cutover") {
    if (!CUTOVER_PROFILES.has(profile.name)) throw usageError();
    const options = parseOptions(rest, {
      context: "required",
      cutoverMode: true,
    });
    if (profile.platform === "kind" && options.context !== KIND_CONTEXT) {
      throw new DeploymentContractError(
        "cluster_identity_mismatch",
        "Kind cutover requires the fixed project context",
      );
    }
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
      (shape.lifecycleMode || shape.purgeMode || shape.cutoverMode) &&
      options.mode === undefined
    ) {
      options.mode = "preview";
      continue;
    }
    if (
      value === "--confirm" &&
      (shape.lifecycleMode || shape.purgeMode || shape.cutoverMode) &&
      options.mode === undefined
    ) {
      options.mode = "confirm";
      if (shape.purgeMode) {
        options.confirmation = requireNormalizedValue(
          values[index + 1],
          "purge confirmation",
        );
        index += 1;
      } else if (shape.cutoverMode) {
        options.confirmation = requireCutoverConfirmation(values[index + 1]);
        index += 1;
      }
      continue;
    }
    throw usageError();
  }

  if (shape.context === "required" && options.context === undefined) {
    throw usageError();
  }
  if ((shape.purgeMode || shape.cutoverMode) && options.mode === undefined) {
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

function requireCutoverConfirmation(value) {
  const confirmation = requireNormalizedValue(value, "cutover confirmation");
  if (
    confirmation.startsWith("-") ||
    !CUTOVER_CONFIRMATION_PATTERN.test(confirmation)
  ) {
    throw new DeploymentContractError(
      "invalid_argument",
      "cutover confirmation must use the fixed versioned SHA-256 format",
    );
  }
  return confirmation;
}

function requireProfile(name) {
  const definition = PROFILE_DEFINITIONS[name];
  if (definition === undefined) throw usageError();
  return { name, ...definition };
}

function usageError() {
  return new DeploymentContractError(
    "usage_invalid",
    "expected render, status, install, upgrade, uninstall, purge, or cutover with a fixed deployment profile",
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

async function loadCutoverContract(contract) {
  const [rawJob, rawNetworkPolicies] = await Promise.all([
    readFile(path.join(contract.applicationRoot, "cutover", "job.yaml"), "utf8"),
    readFile(
      path.join(
        contract.applicationRoot,
        "base",
        "workloads",
        "network-policies.yaml",
      ),
      "utf8",
    ),
  ]);
  return {
    ...contract,
    cutover: normalizeCutoverContract(
      rawJob,
      rawNetworkPolicies,
      contract.images["k8s-incident-agent-runtime"],
    ),
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

function normalizeCutoverContract(
  rawJob,
  rawNetworkPolicies,
  runtimeImage,
) {
  let job;
  const defaultDenyCandidates = [];
  try {
    job = load(rawJob);
    loadAll(rawNetworkPolicies, (document) => {
      if (
        document?.kind === "NetworkPolicy" &&
        document.metadata?.name === DEFAULT_DENY_POLICY
      ) {
        defaultDenyCandidates.push(document);
      }
    });
  } catch {
    throw new DeploymentContractError(
      "cutover_manifest_invalid",
      "cutover resources are not valid YAML",
    );
  }
  if (
    job === null ||
    typeof job !== "object" ||
    Array.isArray(job) ||
    defaultDenyCandidates.length !== 1
  ) {
    throw new DeploymentContractError(
      "cutover_manifest_invalid",
      "cutover resources are incomplete",
    );
  }
  const container = job.spec?.template?.spec?.containers?.[0];
  if (container?.image !== "k8s-incident-agent-runtime") {
    throw new DeploymentContractError(
      "cutover_manifest_invalid",
      "cutover Job does not use the locked Runtime image placeholder",
    );
  }
  container.image = runtimeImage;
  requireCutoverJobContract(job, runtimeImage, [
    "runtime",
    "reset-stage-one-data",
    "--preview",
  ]);
  requireDefaultDenyContract(defaultDenyCandidates[0]);
  return {
    defaultDeny: defaultDenyCandidates[0],
    job,
  };
}

function buildCutoverJob(contract, mode, planDigest) {
  const job = structuredClone(contract.cutover.job);
  job.spec.template.spec.containers[0].command =
    mode === "preview"
      ? ["runtime", "reset-stage-one-data", "--preview"]
      : ["runtime", "reset-stage-one-data", "--confirm", planDigest];
  requireCutoverJobContract(
    job,
    contract.images["k8s-incident-agent-runtime"],
    job.spec.template.spec.containers[0].command,
  );
  return job;
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

async function runCutover(contract, request, execute) {
  const target = await prepareCutoverTarget(contract, request, execute);
  const previewReset = await executeCutoverJob(
    contract,
    request,
    execute,
    "preview",
  );
  const confirmation = cutoverConfirmation(target, previewReset.planDigest);
  if (request.mode === "preview") {
    return {
      action: "cutover",
      mode: "preview",
      profile: request.profile.name,
      context: request.context,
      ...cutoverTargetProjection(target),
      reset: previewReset,
      confirmation,
    };
  }
  if (request.confirmation !== confirmation) {
    throw new DeploymentContractError(
      "cutover_confirmation_mismatch",
      "cutover confirmation does not match the fresh target",
    );
  }

  const reboundTarget = await prepareCutoverTarget(contract, request, execute);
  if (!isDeepStrictEqual(reboundTarget, target)) {
    throw new DeploymentContractError(
      "cutover_target_changed",
      "cutover target changed before destructive Job creation",
    );
  }
  const confirmedReset = await executeCutoverJob(
    contract,
    request,
    execute,
    "confirm",
    previewReset.planDigest,
  );
  return {
    action: "cutover",
    mode: "confirmed",
    profile: request.profile.name,
    context: request.context,
    ...cutoverTargetProjection(reboundTarget),
    reset: confirmedReset,
  };
}

async function prepareCutoverTarget(contract, request, execute) {
  await requireClusterPrerequisites(contract, request, execute, {
    components: false,
    images: [contract.images["k8s-incident-agent-runtime"]],
    secret: false,
  });
  await recoverTerminalCutoverJob(contract, request, execute);
  const first = await readCutoverSnapshot(contract, request, execute);
  if (!first.defaultDenyPresent) {
    await createDefaultDeny(contract, request, execute);
  }
  const second = await readCutoverSnapshot(contract, request, execute);
  if (
    !second.defaultDenyPresent ||
    !isDeepStrictEqual(first.target, second.target)
  ) {
    throw new DeploymentContractError(
      "cutover_target_changed",
      "cutover target changed while establishing isolation",
    );
  }
  return second.target;
}

async function readCutoverSnapshot(contract, request, execute) {
  const runtimeImage = contract.images["k8s-incident-agent-runtime"];
  const cluster = await requireClusterPrerequisites(
    contract,
    request,
    execute,
    {
      components: false,
      images: [runtimeImage],
      secret: false,
    },
  );
  const [namespaceUid, storage, defaultDenyPresent] = await Promise.all([
    readCutoverNamespace(request, execute),
    readCutoverStorage(request, execute),
    readCutoverNetworkPolicyState(request, execute),
    requireCutoverMutatorsAbsent(request, execute),
    requireWorkloadsAbsent(request, execute, {
      code: "cutover_workload_active",
      message: "application workloads must be absent before cutover",
    }),
  ]);
  return {
    defaultDenyPresent,
    target: {
      context: request.context,
      namespaceUid,
      profile: request.profile.name,
      pvUid: storage.pvUid,
      pvcName: RUNTIME_PVC,
      pvcUid: storage.pvcUid,
      runtimeImage,
      serverVersion: cluster.serverVersion,
      volumeName: storage.volumeName,
    },
  };
}

async function readCutoverNamespace(request, execute) {
  const namespace = await readJsonResource(execute, request.context, [
    "get",
    "namespace",
    APPLICATION_NAMESPACE,
    "--output=json",
  ], "application Namespace");
  if (
    namespace.kind !== "Namespace" ||
    namespace.metadata?.name !== APPLICATION_NAMESPACE ||
    namespace.metadata?.labels?.["app.kubernetes.io/part-of"] !==
      "k8s-incident-agent"
  ) {
    throw new DeploymentContractError(
      "cutover_namespace_invalid",
      "application Namespace does not match the fixed cutover target",
    );
  }
  return requireString(namespace.metadata?.uid, "application Namespace UID");
}

async function readCutoverStorage(request, execute) {
  const pvc = await readJsonResource(execute, request.context, [
    "get",
    "persistentvolumeclaim",
    RUNTIME_PVC,
    "--namespace",
    APPLICATION_NAMESPACE,
    "--output=json",
  ], "Runtime PVC");
  const expectedStorageClass =
    request.profile.platform === "kind"
      ? "k8s-incident-agent-kind"
      : "local-path";
  if (
    pvc.kind !== "PersistentVolumeClaim" ||
    pvc.metadata?.name !== RUNTIME_PVC ||
    pvc.metadata?.namespace !== APPLICATION_NAMESPACE ||
    pvc.spec?.storageClassName !== expectedStorageClass ||
    pvc.spec?.volumeMode !== "Filesystem" ||
    !isDeepStrictEqual(pvc.spec?.accessModes, ["ReadWriteOnce"]) ||
    pvc.status?.phase !== "Bound"
  ) {
    throw new DeploymentContractError(
      "cutover_storage_invalid",
      "Runtime PVC does not match the fixed cutover storage contract",
    );
  }
  const pvcUid = requireString(pvc.metadata?.uid, "Runtime PVC UID");
  const volumeName = requireString(pvc.spec?.volumeName, "Runtime PV name");
  const pv = await readJsonResource(execute, request.context, [
    "get",
    "persistentvolume",
    volumeName,
    "--output=json",
  ], "Runtime PV");
  const baseContractMatched =
    pv.kind === "PersistentVolume" &&
    pv.metadata?.name === volumeName &&
    pv.spec?.claimRef?.uid === pvcUid &&
    pv.spec?.claimRef?.name === RUNTIME_PVC &&
    pv.spec?.claimRef?.namespace === APPLICATION_NAMESPACE &&
    pv.spec?.storageClassName === expectedStorageClass &&
    pv.spec?.volumeMode === "Filesystem" &&
    isDeepStrictEqual(pv.spec?.accessModes, ["ReadWriteOnce"]);
  const platformContractMatched =
    request.profile.platform === "kind"
      ? volumeName === "k8s-incident-agent-runtime-data" &&
        pv.spec?.persistentVolumeReclaimPolicy === "Retain" &&
        isDeepStrictEqual(pv.spec?.hostPath, {
          path: "/var/local/k8s-incident-agent",
          type: "DirectoryOrCreate",
        })
      : pv.spec?.persistentVolumeReclaimPolicy === "Delete";
  if (!baseContractMatched || !platformContractMatched) {
    throw new DeploymentContractError(
      "cutover_storage_invalid",
      "Runtime PV does not match the bound cutover target",
    );
  }
  return {
    pvcUid,
    volumeName,
    pvUid: requireString(pv.metadata?.uid, "Runtime PV UID"),
  };
}

async function readCutoverNetworkPolicyState(request, execute) {
  const policies = await readJsonResource(execute, request.context, [
    "get",
    "networkpolicies",
    "--namespace",
    APPLICATION_NAMESPACE,
    "--output=json",
  ], "cutover NetworkPolicies");
  if (policies.kind !== "List" || !Array.isArray(policies.items)) {
    throw new DeploymentContractError(
      "cutover_network_policy_invalid",
      "cutover NetworkPolicy collection is unavailable",
    );
  }
  if (policies.items.length === 0) return false;
  if (policies.items.length !== 1) {
    throw new DeploymentContractError(
      "cutover_network_policy_invalid",
      "cutover permits only the fixed default-deny NetworkPolicy",
    );
  }
  requireDefaultDenyContract(policies.items[0]);
  return true;
}

async function createDefaultDeny(contract, request, execute) {
  const input = serializeKubernetesResource(contract.cutover.defaultDeny);
  const dryRun = await readJsonFromKubectl(
    execute,
    request.context,
    [
      "create",
      "--dry-run=server",
      "--output=json",
      "--filename=-",
    ],
    "default-deny admission preview",
    input,
  );
  requireDefaultDenyContract(dryRun, contract.cutover.defaultDeny);
  const created = await readJsonFromKubectl(
    execute,
    request.context,
    ["create", "--output=json", "--filename=-"],
    "default-deny creation",
    input,
  );
  requireDefaultDenyContract(created, contract.cutover.defaultDeny);
}

async function requireCutoverMutatorsAbsent(request, execute) {
  const resources = [
    "mutatingwebhookconfigurations.admissionregistration.k8s.io",
    "mutatingadmissionpolicies.admissionregistration.k8s.io",
    "mutatingadmissionpolicybindings.admissionregistration.k8s.io",
  ];
  const collections = await Promise.all(
    resources.map((resource) =>
      readJsonResource(execute, request.context, [
        "get",
        resource,
        "--output=json",
      ], resource),
    ),
  );
  if (
    collections.some(
      (collection) =>
        collection.kind !== "List" ||
        !Array.isArray(collection.items) ||
        collection.items.length !== 0,
    )
  ) {
    throw new DeploymentContractError(
      "cutover_mutator_present",
      "cutover requires all supported API mutator collections to be empty",
    );
  }
}

function cutoverConfirmation(target, planDigest) {
  const payload = JSON.stringify({
    context: target.context,
    namespaceUid: target.namespaceUid,
    planDigest,
    profile: target.profile,
    pvUid: target.pvUid,
    pvcName: target.pvcName,
    pvcUid: target.pvcUid,
    runtimeImage: target.runtimeImage,
    serverVersion: target.serverVersion,
    volumeName: target.volumeName,
  });
  const digest = createHash("sha256").update(payload).digest("hex");
  return `cutover:v1:sha256:${digest}`;
}

function cutoverTargetProjection(target) {
  return {
    cluster: { serverVersion: target.serverVersion },
    namespaceUid: target.namespaceUid,
    storage: {
      pvcName: target.pvcName,
      pvcUid: target.pvcUid,
      volumeName: target.volumeName,
      pvUid: target.pvUid,
    },
    runtimeImage: target.runtimeImage,
  };
}

async function executeCutoverJob(
  contract,
  request,
  execute,
  mode,
  planDigest,
) {
  const runtimeImage = contract.images["k8s-incident-agent-runtime"];
  const desiredJob = buildCutoverJob(contract, mode, planDigest);
  const input = serializeKubernetesResource(desiredJob);
  const admitted = await readJsonFromKubectl(
    execute,
    request.context,
    ["create", "--dry-run=server", "--output=json", "--filename=-"],
    "cutover Job admission preview",
    input,
  );
  requireCutoverJobContract(
    admitted,
    runtimeImage,
    desiredJob.spec.template.spec.containers[0].command,
  );

  let jobUid;
  let knownPodNames = [];
  let result;
  let operationError;
  try {
    const created = await readJsonFromKubectl(
      execute,
      request.context,
      ["create", "--output=json", "--filename=-"],
      "cutover Job creation",
      input,
    );
    jobUid = requireString(created.metadata?.uid, "cutover Job UID");
    requireCutoverJobContract(
      created,
      runtimeImage,
      desiredJob.spec.template.spec.containers[0].command,
    );

    const gatedPod = await waitForGatedCutoverPod(
      request,
      execute,
      jobUid,
      runtimeImage,
      desiredJob.spec.template.spec.containers[0].command,
    );
    knownPodNames = [gatedPod.metadata.name];
    const releasedPod = await releaseCutoverPod(
      request,
      execute,
      gatedPod,
      jobUid,
      runtimeImage,
      desiredJob.spec.template.spec.containers[0].command,
    );
    const terminal = await waitForCutoverTerminal(
      request,
      execute,
      jobUid,
      runtimeImage,
      desiredJob.spec.template.spec.containers[0].command,
      releasedPod.metadata.name,
      releasedPod.metadata.uid,
    );
    knownPodNames = terminal.pods.map((pod) => pod.metadata.name);
    const terminalPod = terminal.pods[0];
    const log = await runKubectl(
      execute,
      request.context,
      [
        "logs",
        `pod/${terminalPod.metadata.name}`,
        "--namespace",
        APPLICATION_NAMESPACE,
        "--container",
        CUTOVER_CONTAINER,
      ],
      READ_TIMEOUT_MILLISECONDS,
      "cutover Runtime output",
    );
    const postLogPod = requireStableCutoverPod(
      await readCutoverPods(request, execute),
      terminalPod.metadata.name,
      releasedPod.metadata.uid,
    );
    requireCutoverPodContract(
      postLogPod,
      jobUid,
      runtimeImage,
      desiredJob.spec.template.spec.containers[0].command,
      "terminal",
    );
    if (terminal.phase === "failed") {
      const failure = normalizeCutoverRuntimeFailure(log, mode);
      throw new DeploymentContractError(
        "cutover_runtime_failed",
        `Runtime reset failed safely (${failure.code}/${failure.phase})`,
      );
    }
    result = normalizeCutoverRuntimeSuccess(log, mode, planDigest);
  } catch (error) {
    operationError = error;
  }

  if (jobUid !== undefined) {
    try {
      await cleanupCutoverJob(request, execute, jobUid, knownPodNames);
    } catch {
      throw new DeploymentContractError(
        "cutover_cleanup_failed",
        "cutover Job result could not be converged to an absent state",
      );
    }
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

async function waitForGatedCutoverPod(
  request,
  execute,
  jobUid,
  runtimeImage,
  command,
) {
  const deadline = Date.now() + CUTOVER_DEADLINE_MILLISECONDS;
  while (Date.now() <= deadline) {
    const job = await readOptionalCutoverJob(request, execute);
    if (job === null || job.metadata?.uid !== jobUid) {
      throw new DeploymentContractError(
        "cutover_job_identity_changed",
        "cutover Job identity changed before Pod release",
      );
    }
    requireCutoverJobContract(job, runtimeImage, command);
    if (cutoverJobPhase(job) !== "active") {
      throw new DeploymentContractError(
        "cutover_job_terminal_early",
        "cutover Job became terminal before its Pod was released",
      );
    }
    const pods = await readCutoverPods(request, execute);
    if (pods.length > 1) {
      throw new DeploymentContractError(
        "cutover_pod_count_invalid",
        "cutover Job produced more than one Pod",
      );
    }
    if (pods.length === 1) {
      requireCutoverPodContract(
        pods[0],
        jobUid,
        runtimeImage,
        command,
        "gated",
      );
      return pods[0];
    }
    await delay(CUTOVER_POLL_INTERVAL_MILLISECONDS);
  }
  throw new DeploymentContractError(
    "cutover_timeout",
    "cutover Job did not produce a gated Pod before the deadline",
  );
}

async function releaseCutoverPod(
  request,
  execute,
  pod,
  jobUid,
  runtimeImage,
  command,
) {
  const podName = requireString(pod.metadata?.name, "cutover Pod name");
  const podUid = requireString(pod.metadata?.uid, "cutover Pod UID");
  const resourceVersion = requireString(
    pod.metadata?.resourceVersion,
    "cutover Pod resourceVersion",
  );
  const patch = JSON.stringify([
    { op: "test", path: "/metadata/uid", value: podUid },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: resourceVersion,
    },
    {
      op: "test",
      path: "/spec/schedulingGates",
      value: [{ name: CUTOVER_GATE }],
    },
    { op: "remove", path: "/spec/schedulingGates/0" },
  ]);
  const released = await readJsonFromKubectl(
    execute,
    request.context,
    [
      "patch",
      "pod",
      podName,
      "--namespace",
      APPLICATION_NAMESPACE,
      "--type=json",
      "--patch",
      patch,
      "--output=json",
    ],
    "cutover Pod scheduling release",
  );
  if (released.metadata?.uid !== podUid) {
    throw new DeploymentContractError(
      "cutover_pod_identity_changed",
      "cutover Pod identity changed during scheduling release",
    );
  }
  requireCutoverPodContract(
    released,
    jobUid,
    runtimeImage,
    command,
    "released",
  );
  return released;
}

async function waitForCutoverTerminal(
  request,
  execute,
  jobUid,
  runtimeImage,
  command,
  podName,
  podUid,
) {
  const deadline = Date.now() + CUTOVER_DEADLINE_MILLISECONDS;
  while (Date.now() <= deadline) {
    const job = await readOptionalCutoverJob(request, execute);
    if (job === null || job.metadata?.uid !== jobUid) {
      throw new DeploymentContractError(
        "cutover_job_identity_changed",
        "cutover Job identity changed before completion",
      );
    }
    requireCutoverJobContract(job, runtimeImage, command);
    const pods = await readCutoverPods(request, execute);
    const pod = requireStableCutoverPod(pods, podName, podUid);
    requireCutoverPodContract(
      pod,
      jobUid,
      runtimeImage,
      command,
      "terminal",
    );
    const phase = cutoverJobPhase(job);
    const podPhase = pod.status?.phase;
    if (
      (phase === "complete" && podPhase === "Succeeded") ||
      (phase === "failed" && podPhase === "Failed")
    ) {
      return { phase, pods };
    }
    if (phase !== "active") {
      throw new DeploymentContractError(
        "cutover_terminal_invalid",
        "cutover Job and Pod terminal states disagree",
      );
    }
    await delay(CUTOVER_POLL_INTERVAL_MILLISECONDS);
  }
  throw new DeploymentContractError(
    "cutover_timeout",
    "cutover Job did not finish before the deadline",
  );
}

function requireStableCutoverPod(pods, podName, podUid) {
  if (pods.length !== 1) {
    throw new DeploymentContractError(
      "cutover_pod_count_invalid",
      "cutover Job does not have exactly one stable owner Pod",
    );
  }
  const [pod] = pods;
  if (pod.metadata?.name !== podName || pod.metadata?.uid !== podUid) {
    throw new DeploymentContractError(
      "cutover_pod_identity_changed",
      "cutover Pod identity changed after scheduling release",
    );
  }
  return pod;
}

async function recoverTerminalCutoverJob(contract, request, execute) {
  const job = await readOptionalCutoverJob(request, execute);
  const pods = await readCutoverPods(request, execute);
  if (job === null && pods.length === 0) return;
  if (job === null) {
    throw new DeploymentContractError(
      "cutover_residue_invalid",
      "cutover owner Pods exist without the fixed Job",
    );
  }
  const runtimeImage = contract.images["k8s-incident-agent-runtime"];
  requireCutoverJobContract(job, runtimeImage);
  const jobUid = requireString(job.metadata?.uid, "cutover Job UID");
  const phase = cutoverJobPhase(job);
  if (phase === "active") {
    throw new DeploymentContractError(
      "cutover_residue_active",
      "an active cutover Job requires operator review",
    );
  }
  if (
    pods.length > 1 ||
    (pods.length === 0 && job.metadata?.deletionTimestamp == null)
  ) {
    throw new DeploymentContractError(
      "cutover_residue_invalid",
      "terminal cutover residue does not have exactly one owner Pod",
    );
  }
  if (pods.length === 1) {
    const hasGate = isDeepStrictEqual(pods[0].spec?.schedulingGates, [
      { name: CUTOVER_GATE },
    ]);
    if (phase === "complete" && hasGate) {
      throw new DeploymentContractError(
        "cutover_residue_invalid",
        "completed cutover residue still has its scheduling gate",
      );
    }
    requireCutoverPodContract(
      pods[0],
      jobUid,
      runtimeImage,
      job.spec.template.spec.containers[0].command,
      hasGate ? "terminal-gated" : "terminal",
    );
    const podPhase = pods[0].status?.phase;
    if (
      (phase === "complete" && podPhase !== "Succeeded") ||
      (phase === "failed" && podPhase !== "Failed")
    ) {
      throw new DeploymentContractError(
        "cutover_residue_invalid",
        "terminal cutover Job and Pod states disagree",
      );
    }
  }
  const podNames = pods.map(
    (pod) => requireString(pod.metadata?.name, "cutover Pod name"),
  );
  if (job.metadata?.deletionTimestamp != null) {
    await waitForCutoverDeletion(request, execute, podNames);
  } else {
    await cleanupCutoverJob(request, execute, jobUid, podNames);
  }
}

async function cleanupCutoverJob(request, execute, jobUid, podNames) {
  const deleteOptions = `${JSON.stringify({
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: jobUid },
    propagationPolicy: "Foreground",
  })}\n`;
  await runKubectl(
    execute,
    request.context,
    [
      "delete",
      "--raw",
      `/apis/batch/v1/namespaces/${APPLICATION_NAMESPACE}/jobs/${CUTOVER_JOB}`,
      "--filename=-",
    ],
    WRITE_TIMEOUT_MILLISECONDS,
    "cutover Job cleanup",
    deleteOptions,
  );
  await waitForCutoverDeletion(request, execute, podNames);
}

async function waitForCutoverDeletion(request, execute, podNames) {
  await runKubectl(
    execute,
    request.context,
    [
      "wait",
      "--for=delete",
      `job/${CUTOVER_JOB}`,
      "--namespace",
      APPLICATION_NAMESPACE,
      `--timeout=${WAIT_TIMEOUT}`,
    ],
    WRITE_TIMEOUT_MILLISECONDS,
    "cutover Job deletion",
  );
  for (const podName of new Set(podNames)) {
    await runKubectl(
      execute,
      request.context,
      [
        "wait",
        "--for=delete",
        `pod/${podName}`,
        "--namespace",
        APPLICATION_NAMESPACE,
        `--timeout=${WAIT_TIMEOUT}`,
      ],
      WRITE_TIMEOUT_MILLISECONDS,
      "cutover Pod deletion",
    );
  }
  if ((await readCutoverPods(request, execute)).length !== 0) {
    throw new DeploymentContractError(
      "cutover_cleanup_failed",
      "cutover owner Pods remain after Job cleanup",
    );
  }
}

async function requireCutoverObjectsAbsent(request, execute) {
  const [job, pods] = await Promise.all([
    readOptionalCutoverJob(request, execute),
    readCutoverPods(request, execute),
  ]);
  if (job !== null || pods.length !== 0) {
    throw new DeploymentContractError(
      "cutover_residue_present",
      "run cutover preview recovery before install or upgrade",
    );
  }
}

async function readOptionalCutoverJob(request, execute) {
  const output = await runKubectl(
    execute,
    request.context,
    [
      "get",
      "job",
      CUTOVER_JOB,
      "--namespace",
      APPLICATION_NAMESPACE,
      "--ignore-not-found=true",
      "--output=json",
    ],
    READ_TIMEOUT_MILLISECONDS,
    "cutover Job",
  );
  if (output.trim() === "") return null;
  return parseJsonObject(output, "cutover Job");
}

async function readCutoverPods(request, execute) {
  const pods = await readJsonResource(execute, request.context, [
    "get",
    "pods",
    "--namespace",
    APPLICATION_NAMESPACE,
    "--output=json",
  ], "cutover Pods");
  if (pods.kind !== "List" || !Array.isArray(pods.items)) {
    throw new DeploymentContractError(
      "cutover_pod_collection_invalid",
      "cutover Pod collection is unavailable",
    );
  }
  return pods.items.filter(
    (pod) =>
      pod?.metadata?.labels?.["batch.kubernetes.io/job-name"] === CUTOVER_JOB ||
      pod?.metadata?.ownerReferences?.some(
        (owner) => owner?.kind === "Job" && owner?.name === CUTOVER_JOB,
      ),
  );
}

function requireCutoverJobContract(document, runtimeImage, expectedCommand) {
  const spec = document?.spec;
  const pod = spec?.template?.spec;
  const containers = pod?.containers;
  const command = containers?.[0]?.command;
  requireCutoverCommand(command, expectedCommand);
  const labels = document?.metadata?.labels ?? {};
  const templateLabels = spec?.template?.metadata?.labels ?? {};
  if (
    document?.apiVersion !== "batch/v1" ||
    document?.kind !== "Job" ||
    document?.metadata?.name !== CUTOVER_JOB ||
    document?.metadata?.namespace !== APPLICATION_NAMESPACE ||
    labels["app.kubernetes.io/component"] !== CUTOVER_JOB ||
    labels["app.kubernetes.io/part-of"] !== "k8s-incident-agent" ||
    labels["app.kubernetes.io/name"] === "agent-runtime" ||
    spec?.parallelism !== 1 ||
    spec?.completions !== 1 ||
    spec?.backoffLimit !== 0 ||
    spec?.activeDeadlineSeconds !== 300 ||
    spec?.ttlSecondsAfterFinished !== undefined ||
    spec?.suspend === true ||
    spec?.manualSelector === true ||
    spec?.completionMode === "Indexed" ||
    templateLabels["app.kubernetes.io/component"] !== CUTOVER_JOB ||
    templateLabels["app.kubernetes.io/part-of"] !== "k8s-incident-agent" ||
    templateLabels["app.kubernetes.io/name"] === "agent-runtime" ||
    pod?.nodeName !== undefined ||
    !cutoverPodSpecMatches(pod, runtimeImage, command, true, false)
  ) {
    throw new DeploymentContractError(
      "cutover_job_contract_invalid",
      "cutover Job does not match the fixed safety contract",
    );
  }
}

function requireCutoverCommand(command, expectedCommand) {
  const isPreview = isDeepStrictEqual(command, [
    "runtime",
    "reset-stage-one-data",
    "--preview",
  ]);
  const isConfirm =
    Array.isArray(command) &&
    command.length === 4 &&
    isDeepStrictEqual(command.slice(0, 3), [
      "runtime",
      "reset-stage-one-data",
      "--confirm",
    ]) &&
    PLAN_DIGEST_PATTERN.test(command[3]);
  if (
    (!isPreview && !isConfirm) ||
    (expectedCommand !== undefined &&
      !isDeepStrictEqual(command, expectedCommand))
  ) {
    throw new DeploymentContractError(
      "cutover_job_contract_invalid",
      "cutover Job command is not one of the fixed reset forms",
    );
  }
}

function cutoverPodSpecMatches(
  pod,
  runtimeImage,
  command,
  requireGate,
  allowDefaultTolerations,
) {
  const containers = pod?.containers;
  const container = containers?.[0];
  const volumes = pod?.volumes;
  const securityContext = pod?.securityContext;
  const tolerations = pod?.tolerations ?? [];
  const tolerationsMatched =
    tolerations.length === 0 ||
    (allowDefaultTolerations &&
      isDeepStrictEqual(
        [...tolerations].sort((left, right) => left.key.localeCompare(right.key)),
        [...CUTOVER_DEFAULT_TOLERATIONS].sort((left, right) =>
          left.key.localeCompare(right.key)
        ),
      ));
  const gatesMatched = requireGate
    ? isDeepStrictEqual(pod?.schedulingGates, [{ name: CUTOVER_GATE }])
    : pod?.schedulingGates === undefined || pod.schedulingGates.length === 0;
  return (
    pod?.automountServiceAccountToken === false &&
    (pod?.serviceAccountName === undefined ||
      pod.serviceAccountName === "default") &&
    (pod?.serviceAccount === undefined || pod.serviceAccount === "default") &&
    pod?.restartPolicy === "Never" &&
    gatesMatched &&
    (pod?.hostNetwork === undefined || pod.hostNetwork === false) &&
    (pod?.hostPID === undefined || pod.hostPID === false) &&
    (pod?.hostIPC === undefined || pod.hostIPC === false) &&
    (pod?.shareProcessNamespace === undefined ||
      pod.shareProcessNamespace === false) &&
    pod?.nodeSelector === undefined &&
    pod?.affinity === undefined &&
    tolerationsMatched &&
    pod?.hostAliases === undefined &&
    pod?.runtimeClassName === undefined &&
    (pod?.imagePullSecrets === undefined || pod.imagePullSecrets.length === 0) &&
    (pod?.initContainers === undefined || pod.initContainers.length === 0) &&
    (pod?.ephemeralContainers === undefined ||
      pod.ephemeralContainers.length === 0) &&
    isDeepStrictEqual(securityContext, {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    }) &&
    Array.isArray(containers) &&
    containers.length === 1 &&
    container?.name === CUTOVER_CONTAINER &&
    container?.image === runtimeImage &&
    container?.imagePullPolicy === "IfNotPresent" &&
    isDeepStrictEqual(container?.command, command) &&
    (container?.args === undefined || container.args.length === 0) &&
    isDeepStrictEqual(container?.env, [
      {
        name: "RUNTIME_DATA_DIR",
        value: "/var/lib/k8s-incident-agent/runtime",
      },
    ]) &&
    container?.envFrom === undefined &&
    container?.lifecycle === undefined &&
    container?.livenessProbe === undefined &&
    container?.readinessProbe === undefined &&
    container?.startupProbe === undefined &&
    (container?.ports === undefined || container.ports.length === 0) &&
    isDeepStrictEqual(container?.securityContext, {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    }) &&
    isDeepStrictEqual(container?.volumeMounts, [
      {
        name: "runtime-data",
        mountPath: "/var/lib/k8s-incident-agent",
      },
    ]) &&
    Array.isArray(volumes) &&
    volumes.length === 1 &&
    isDeepStrictEqual(volumes[0], {
      name: "runtime-data",
      persistentVolumeClaim: { claimName: RUNTIME_PVC },
    })
  );
}

function requireCutoverPodContract(
  document,
  jobUid,
  runtimeImage,
  command,
  state,
) {
  const ownerReferences = document?.metadata?.ownerReferences;
  const owner = ownerReferences?.[0];
  const gated = state === "gated";
  const requireGate = gated || state === "terminal-gated";
  const podScheduled = document?.status?.conditions?.find(
    (condition) => condition?.type === "PodScheduled",
  );
  const statuses = [
    ...(document?.status?.initContainerStatuses ?? []),
    ...(document?.status?.containerStatuses ?? []),
    ...(document?.status?.ephemeralContainerStatuses ?? []),
  ];
  const startedBeforeRelease = statuses.some(
    (status) =>
      status?.started === true ||
      status?.state?.running !== undefined ||
      status?.state?.terminated !== undefined,
  );
  if (
    document?.apiVersion !== "v1" ||
    document?.kind !== "Pod" ||
    document?.metadata?.namespace !== APPLICATION_NAMESPACE ||
    typeof document?.metadata?.name !== "string" ||
    typeof document?.metadata?.uid !== "string" ||
    typeof document?.metadata?.resourceVersion !== "string" ||
    !Array.isArray(ownerReferences) ||
    ownerReferences.length !== 1 ||
    owner?.apiVersion !== "batch/v1" ||
    owner?.kind !== "Job" ||
    owner?.name !== CUTOVER_JOB ||
    owner?.uid !== jobUid ||
    owner?.controller !== true ||
    document?.metadata?.labels?.["app.kubernetes.io/component"] !==
      CUTOVER_JOB ||
    document?.metadata?.labels?.["app.kubernetes.io/part-of"] !==
      "k8s-incident-agent" ||
    document?.metadata?.labels?.["app.kubernetes.io/name"] ===
      "agent-runtime" ||
    !cutoverPodSpecMatches(
      document?.spec,
      runtimeImage,
      command,
      requireGate,
      true,
    ) ||
    ((requireGate || state === "released") &&
      document?.spec?.nodeName !== undefined) ||
    (gated &&
      (document?.status?.phase !== "Pending" ||
        podScheduled?.status !== "False" ||
        podScheduled?.reason !== "SchedulingGated" ||
        startedBeforeRelease)) ||
    (state === "terminal-gated" && startedBeforeRelease)
  ) {
    throw new DeploymentContractError(
      "cutover_pod_contract_invalid",
      "admitted cutover Pod does not match the fixed safety projection",
    );
  }
}

function cutoverJobPhase(job) {
  const conditions = job?.status?.conditions ?? [];
  if (!Array.isArray(conditions)) {
    throw new DeploymentContractError(
      "cutover_job_status_invalid",
      "cutover Job status conditions are invalid",
    );
  }
  const complete = conditions.some(
    (condition) => condition?.type === "Complete" && condition?.status === "True",
  );
  const failed = conditions.some(
    (condition) => condition?.type === "Failed" && condition?.status === "True",
  );
  if (complete && failed) {
    throw new DeploymentContractError(
      "cutover_job_status_invalid",
      "cutover Job reports conflicting terminal conditions",
    );
  }
  return complete ? "complete" : failed ? "failed" : "active";
}

function requireDefaultDenyContract(document) {
  if (
    document?.apiVersion !== "networking.k8s.io/v1" ||
    document?.kind !== "NetworkPolicy" ||
    document?.metadata?.name !== DEFAULT_DENY_POLICY ||
    document?.metadata?.namespace !== APPLICATION_NAMESPACE ||
    document?.metadata?.labels?.["app.kubernetes.io/part-of"] !==
      "k8s-incident-agent" ||
    !isDeepStrictEqual(document?.spec, {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
    })
  ) {
    throw new DeploymentContractError(
      "cutover_network_policy_invalid",
      "default-deny does not match the shared fixed contract",
    );
  }
}

function normalizeCutoverRuntimeSuccess(rawLog, mode, expectedPlanDigest) {
  const payload = parseCutoverRuntimeObject(rawLog, "Runtime reset output");
  const plan = normalizeCutoverRuntimePlan(payload, mode);
  if (mode === "preview") return plan;
  if (
    payload.planDigest !== expectedPlanDigest ||
    !["reset", "migrated", "already_complete"].includes(payload.outcome) ||
    payload.newHead !== "20260901_0002"
  ) {
    throw new DeploymentContractError(
      "cutover_runtime_output_invalid",
      "Runtime confirm output does not match the requested reset",
    );
  }
  const deleted = requireCutoverRuntimeObject(
    payload.deleted,
    "Runtime deleted targets",
  );
  const businessFiles = requireStringArray(
    deleted.businessFiles,
    "Runtime deleted business files",
  );
  const checkpointFiles = requireStringArray(
    deleted.checkpointFiles,
    "Runtime deleted checkpoint files",
  );
  const artifactRunIds = requireStringArray(
    deleted.artifactRunIds,
    "Runtime deleted artifact runs",
  );
  return {
    ...plan,
    outcome: payload.outcome,
    newHead: payload.newHead,
    deleted: {
      businessFileCount: businessFiles.length,
      checkpointFileCount: checkpointFiles.length,
      artifactRunCount: artifactRunIds.length,
    },
  };
}

function normalizeCutoverRuntimePlan(payload, mode) {
  if (
    payload.mode !== mode ||
    payload.targetHead !== "20260901_0002" ||
    !["stage_one", "deletion_complete", "empty_database", "already_complete"]
      .includes(payload.state) ||
    !(payload.sourceHead === null ||
      (typeof payload.sourceHead === "string" && payload.sourceHead !== "")) ||
    typeof payload.planDigest !== "string" ||
    !PLAN_DIGEST_PATTERN.test(payload.planDigest)
  ) {
    throw new DeploymentContractError(
      "cutover_runtime_output_invalid",
      "Runtime reset output does not match the fixed contract",
    );
  }
  const targets = requireCutoverRuntimeObject(
    payload.targets,
    "Runtime reset targets",
  );
  const rowCounts = requireCutoverRuntimeObject(
    targets.rowCounts,
    "Runtime row counts",
  );
  if (
    Object.keys(rowCounts).length > 5 ||
    Object.entries(rowCounts).some(
      ([name, count]) =>
        name === "" ||
        name.length > 64 ||
        !Number.isSafeInteger(count) ||
        count < 0,
    )
  ) {
    throw new DeploymentContractError(
      "cutover_runtime_output_invalid",
      "Runtime row counts are invalid",
    );
  }
  const businessFiles = requireStringArray(
    targets.businessFiles,
    "Runtime business files",
  );
  const checkpointFiles = requireStringArray(
    targets.checkpointFiles,
    "Runtime checkpoint files",
  );
  const runIds = requireStringArray(targets.runIds, "Runtime run identities");
  const artifactRunIds = requireStringArray(
    targets.artifactRunIds,
    "Runtime artifact run identities",
  );
  return {
    sourceHead: payload.sourceHead,
    targetHead: payload.targetHead,
    state: payload.state,
    rowCounts,
    businessFileCount: businessFiles.length,
    checkpointFileCount: checkpointFiles.length,
    runCount: runIds.length,
    artifactRunCount: artifactRunIds.length,
    planDigest: payload.planDigest,
  };
}

function normalizeCutoverRuntimeFailure(rawLog, mode) {
  const payload = parseCutoverRuntimeObject(rawLog, "Runtime reset failure");
  const error = requireCutoverRuntimeObject(
    payload.error,
    "Runtime reset failure",
  );
  if (
    payload.mode !== mode ||
    typeof error.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(error.code) ||
    ![
      "preflight",
      "artifact_delete",
      "checkpoint_delete",
      "business_delete",
      "migration",
    ].includes(error.phase)
  ) {
    throw new DeploymentContractError(
      "cutover_runtime_output_invalid",
      "Runtime failure output does not match the fixed contract",
    );
  }
  return { code: error.code, phase: error.phase };
}

function requireStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new DeploymentContractError(
      "cutover_runtime_output_invalid",
      `${label} are invalid`,
    );
  }
  return value;
}

function parseCutoverRuntimeObject(rawValue, label) {
  try {
    return requireCutoverRuntimeObject(JSON.parse(rawValue.trim()), label);
  } catch (error) {
    if (
      error instanceof DeploymentContractError &&
      error.code === "cutover_runtime_output_invalid"
    ) {
      throw error;
    }
    throw new DeploymentContractError(
      "cutover_runtime_output_invalid",
      `${label} is not one JSON object`,
    );
  }
}

function requireCutoverRuntimeObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeploymentContractError(
      "cutover_runtime_output_invalid",
      `${label} is invalid`,
    );
  }
  return value;
}

function serializeKubernetesResource(document) {
  return `${JSON.stringify(document)}\n`;
}

async function readJsonFromKubectl(
  execute,
  context,
  args,
  label,
  input,
) {
  const output = await runKubectl(
    execute,
    context,
    args,
    WRITE_TIMEOUT_MILLISECONDS,
    label,
    input,
  );
  return parseJsonObject(output, label);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  await requireCutoverObjectsAbsent(request, execute);
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
  requireRuntimeConfig(runtimeConfig);
  requireConsoleConfig(consoleConfig);
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
    await requireSingleNodeImages(
      request.context,
      execute,
      Array.isArray(requirements.images)
        ? requirements.images
        : Object.values(contract.images),
    );
  }
  return { serverVersion: actualServerVersion };
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

async function requireSingleNodeImages(
  context,
  execute,
  expectedImages,
) {
  const nodes = await readJsonResource(execute, context, [
    "get",
    "nodes",
    "--output=json",
  ], "Kubernetes Nodes");
  if (
    nodes.kind !== "List" ||
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
  const expectedImageNames = expectedImages.map(
    (image) => `docker.io/library/${image}`,
  );
  if (expectedImageNames.some((expected) => !imageNames.includes(expected))) {
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

async function requireWorkloadsAbsent(request, execute, options = {}) {
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
      options.code ?? "purge_workload_active",
      options.message ?? "uninstall workloads before purging Runtime data",
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
  requireContainerIntakeMode(
    containers[0],
    profile.intakeMode,
    `${name} Deployment`,
  );
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

function requireContainerIntakeMode(container, intakeMode, label) {
  const entries = Array.isArray(container?.env)
    ? container.env.filter((entry) => entry?.name === "INCIDENT_INTAKE_MODE")
    : [];
  if (
    entries.length !== 1 ||
    entries[0]?.value !== intakeMode ||
    Object.hasOwn(entries[0], "valueFrom")
  ) {
    throw stateError(`${label} does not use the selected intake mode`);
  }
}

function requireReadyPods(document) {
  if (document.kind !== "List" || !Array.isArray(document.items)) {
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

function requireRuntimeConfig(document) {
  const expected = {
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
    Object.hasOwn(document.data ?? {}, "INCIDENT_INTAKE_MODE") ||
    Object.entries(expected).some(([key, value]) => document.data?.[key] !== value)
  ) {
    throw stateError("Runtime ConfigMap does not match the selected profile");
  }
}

function requireConsoleConfig(document) {
  if (
    document.kind !== "ConfigMap" ||
    document.metadata?.name !== "incident-console-config" ||
    document.metadata?.namespace !== APPLICATION_NAMESPACE ||
    Object.hasOwn(document.data ?? {}, "INCIDENT_INTAKE_MODE") ||
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
    document.kind !== "List" ||
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
