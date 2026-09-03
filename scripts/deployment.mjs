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
const MONITORING_NAMESPACE = "k8s-incident-monitoring";
const KIND_CONTEXT = "kind-k8s-incident-agent";
const RUNTIME_SERVICE_ACCOUNT = "agent-runtime";
const RUNTIME_SECRET = "agent-runtime-model";
const RUNTIME_SECRET_KEY = "api-key";
const RUNTIME_PVC = "runtime-data";
const PROMETHEUS_PVC = "prometheus-data";
const ALERTMANAGER_WEBHOOK_SECRET = "alertmanager-webhook";
const ALERTMANAGER_WEBHOOK_SECRET_KEY = "token";
const CUTOVER_JOB = "runtime-data-cutover";
const CUTOVER_CONTAINER = "runtime-reset";
const CUTOVER_RUNTIME_ROOT = "/var/lib/k8s-incident-agent/runtime";
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
const CUTOVER_ADMISSION_RESOURCES = Object.freeze([
  Object.freeze({ apiGroup: "batch", resource: "jobs" }),
  Object.freeze({ apiGroup: "", resource: "pods" }),
  Object.freeze({ apiGroup: "networking.k8s.io", resource: "networkpolicies" }),
]);

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
    const rendered = await renderProfile(contract, request.profile, execute);
    requireRenderedMonitoringContract(
      indexRenderedManifest(rendered),
      contract.monitoring.catalog,
    );
    process.stdout.write(rendered);
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
  const monitoringRoot = path.join(repositoryRoot, "deploy", "monitoring");
  const [rawK3s, rawImageLock, rawMonitoringImageLock, rawAlertCatalog, kind] = await Promise.all([
    readFile(path.join(applicationRoot, "versions.json"), "utf8"),
    readFile(
      path.join(applicationRoot, "base", "workloads", "kustomization.yaml"),
      "utf8",
    ),
    readFile(
      path.join(monitoringRoot, "base", "workloads", "kustomization.yaml"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "monitoring", "catalog", "catalog.json"),
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
  const monitoringVersions = requireObject(
    k3sDocument.monitoring,
    "monitoring version contract",
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
  const monitoringImageLock = load(rawMonitoringImageLock);
  if (monitoringImageLock === null || typeof monitoringImageLock !== "object") {
    throw new DeploymentContractError(
      "image_lock_invalid",
      "Monitoring Kustomize image lock is invalid",
    );
  }
  const monitoring = normalizeMonitoringContract(
    monitoringVersions,
    monitoringImageLock.images,
    rawAlertCatalog,
  );

  return {
    repositoryRoot,
    applicationRoot,
    monitoringRoot,
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
    monitoring,
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

function normalizeMonitoringContract(rawVersions, rawImages, rawAlertCatalog) {
  const componentNames = ["prometheus", "alertmanager", "kubeStateMetrics"];
  if (
    !Array.isArray(rawImages) ||
    rawImages.length !== componentNames.length ||
    !isDeepStrictEqual(Object.keys(rawVersions).sort(), componentNames.toSorted())
  ) {
    throw new DeploymentContractError(
      "image_lock_invalid",
      "Monitoring image lock must contain exactly the managed components",
    );
  }
  const lockedByRepository = new Map();
  for (const entry of rawImages) {
    const name = requireString(entry?.name, "monitoring locked image name");
    const repository = requireString(
      entry?.newName,
      "monitoring locked image repository",
    );
    const digest = requireString(entry?.digest, "monitoring locked image digest");
    if (
      name !== repository ||
      !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      lockedByRepository.has(repository)
    ) {
      throw new DeploymentContractError(
        "image_lock_invalid",
        "Monitoring Kustomize image lock is not immutable",
      );
    }
    lockedByRepository.set(repository, digest);
  }

  const components = {};
  for (const name of componentNames) {
    const definition = requireObject(
      rawVersions[name],
      `${name} version contract`,
    );
    if (
      !isDeepStrictEqual(
        Object.keys(definition).sort(),
        ["digest", "repository", "version"],
      )
    ) {
      throw new DeploymentContractError(
        "version_contract_invalid",
        `${name} version contract has unexpected fields`,
      );
    }
    const version = requireVersion(definition.version, `${name} image`);
    const repository = requireString(
      definition.repository,
      `${name} image repository`,
    );
    const digest = requireString(definition.digest, `${name} image digest`);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      lockedByRepository.get(repository) !== digest
    ) {
      throw new DeploymentContractError(
        "image_lock_invalid",
        `${name} image does not match the monitoring version lock`,
      );
    }
    components[name] = {
      version,
      repository,
      digest,
      image: `${repository}@${digest}`,
    };
  }

  const catalog = normalizeAlertRuleCatalog(rawAlertCatalog);
  return { components, catalog };
}

function normalizeAlertRuleCatalog(rawAlertCatalog) {
  const document = parseJsonObject(rawAlertCatalog, "alert catalog");
  if (
    document.schemaVersion !== 5 ||
    typeof document.catalogVersion !== "string" ||
    document.catalogVersion === "" ||
    !Array.isArray(document.alerts) ||
    document.alerts.length === 0
  ) {
    throw new DeploymentContractError(
      "alert_catalog_invalid",
      "Alert catalog does not define deployable rules",
    );
  }
  const entries = new Map();
  for (const entry of document.alerts) {
    const alertId = requireString(entry?.alertId, "catalog alert identifier");
    const expression = requireString(
      entry?.rule?.expression,
      `${alertId} rule expression`,
    );
    const pendingFor = requireString(
      entry?.rule?.for,
      `${alertId} rule duration`,
    );
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alertId) ||
      !/^[1-9][0-9]*(?:ms|s|m|h)$/.test(pendingFor) ||
      entries.has(alertId)
    ) {
      throw new DeploymentContractError(
        "alert_catalog_invalid",
        "Alert catalog contains an invalid or duplicate rule",
      );
    }
    entries.set(alertId, { expression, pendingFor });
  }
  return { version: document.catalogVersion, entries };
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
  const pod = job.spec?.template?.spec;
  const runtimeContainers = [
    ...(pod?.initContainers ?? []),
    ...(pod?.containers ?? []),
  ];
  if (
    runtimeContainers.length !== 3 ||
    runtimeContainers.some(
      (container) => container?.image !== "k8s-incident-agent-runtime",
    )
  ) {
    throw new DeploymentContractError(
      "cutover_manifest_invalid",
      "cutover Job containers do not use the locked Runtime image placeholder",
    );
  }
  for (const container of runtimeContainers) container.image = runtimeImage;
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
  const [webhookConfigurations, policies, policyBindings] = collections;
  if (
    !isKubernetesList(webhookConfigurations) ||
    !isKubernetesList(policies) ||
    !isKubernetesList(policyBindings) ||
    webhookConfigurations.items.some(webhookMayMutateCutoverResource) ||
    policies.items.length !== 0 ||
    policyBindings.items.length !== 0
  ) {
    throw new DeploymentContractError(
      "cutover_mutator_present",
      "cutover requires mutators capable of changing its resources to be absent",
    );
  }
}

function isKubernetesList(collection) {
  return collection?.kind === "List" && Array.isArray(collection.items);
}

function webhookMayMutateCutoverResource(configuration) {
  if (!Array.isArray(configuration?.webhooks) || configuration.webhooks.length === 0) {
    return true;
  }
  return configuration.webhooks.some((webhook) => {
    if (!Array.isArray(webhook?.rules) || webhook.rules.length === 0) return true;
    return webhook.rules.some((rule) => ruleMayMatchCutoverResource(rule));
  });
}

function ruleMayMatchCutoverResource(rule) {
  if (
    !Array.isArray(rule?.apiGroups) ||
    rule.apiGroups.length === 0 ||
    !rule.apiGroups.every((group) => typeof group === "string") ||
    !Array.isArray(rule?.resources) ||
    rule.resources.length === 0 ||
    !rule.resources.every(
      (resource) => typeof resource === "string" && resource.length > 0,
    ) ||
    rule.apiGroups.includes("*") ||
    rule.resources.includes("*") ||
    rule.resources.includes("*/*")
  ) {
    return true;
  }
  return CUTOVER_ADMISSION_RESOURCES.some(
    ({ apiGroup, resource }) =>
      rule.apiGroups.includes(apiGroup) && rule.resources.includes(resource),
  );
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
    cutoverPermissionInitContainersMatch(pod?.initContainers, runtimeImage) &&
    (pod?.ephemeralContainers === undefined ||
      pod.ephemeralContainers.length === 0) &&
    isDeepStrictEqual(securityContext, {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      fsGroupChangePolicy: "OnRootMismatch",
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
        value: CUTOVER_RUNTIME_ROOT,
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

function cutoverPermissionInitContainersMatch(containers, runtimeImage) {
  if (!Array.isArray(containers) || containers.length !== 2) return false;
  return (
    cutoverPermissionInitContainerMatches(
      containers[0],
      "validate-runtime-data-root",
      ["/usr/bin/test", "!", "-L", CUTOVER_RUNTIME_ROOT],
      runtimeImage,
    ) &&
    cutoverPermissionInitContainerMatches(
      containers[1],
      "tighten-runtime-data-permissions",
      [
        "/usr/bin/chmod",
        "--recursive",
        "u=rwX,go=,a-s",
        CUTOVER_RUNTIME_ROOT,
      ],
      runtimeImage,
    )
  );
}

function cutoverPermissionInitContainerMatches(
  container,
  name,
  command,
  runtimeImage,
) {
  return (
    container?.name === name &&
    container?.image === runtimeImage &&
    container?.imagePullPolicy === "IfNotPresent" &&
    isDeepStrictEqual(container?.command, command) &&
    (container?.args === undefined || container.args.length === 0) &&
    container?.env === undefined &&
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
    ])
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
  const desiredResources = indexRenderedManifest(rendered);
  requireRenderedMonitoringContract(
    desiredResources,
    contract.monitoring.catalog,
  );
  return {
    action,
    mode: "preview",
    profile: profile.name,
    resources: renderedInventory(desiredResources),
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
  const desiredManifest = await renderProfile(
    contract,
    request.profile,
    execute,
  );
  requireRenderedMonitoringContract(
    indexRenderedManifest(desiredManifest),
    contract.monitoring.catalog,
  );
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
  for (const [namespace, deployment] of [
    [APPLICATION_NAMESPACE, "agent-runtime"],
    [APPLICATION_NAMESPACE, "incident-console"],
    [MONITORING_NAMESPACE, "prometheus"],
    [MONITORING_NAMESPACE, "alertmanager"],
    [MONITORING_NAMESPACE, "kube-state-metrics"],
  ]) {
    await runKubectl(
      execute,
      request.context,
      [
        "rollout",
        "status",
        `deployment/${deployment}`,
        "--namespace",
        namespace,
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
  const [runtimeBefore, prometheusBefore] = await Promise.all([
    readOptionalPvc(request, execute, APPLICATION_NAMESPACE, RUNTIME_PVC),
    readOptionalPvc(request, execute, MONITORING_NAMESPACE, PROMETHEUS_PVC),
  ]);
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
  const [runtimeAfter, prometheusAfter] = await Promise.all([
    readOptionalPvc(request, execute, APPLICATION_NAMESPACE, RUNTIME_PVC),
    readOptionalPvc(request, execute, MONITORING_NAMESPACE, PROMETHEUS_PVC),
  ]);
  if (
    (runtimeBefore !== null &&
      (runtimeAfter === null ||
        runtimeAfter.metadata?.uid !== runtimeBefore.metadata?.uid)) ||
    (prometheusBefore !== null &&
      (prometheusAfter === null ||
        prometheusAfter.metadata?.uid !== prometheusBefore.metadata?.uid))
  ) {
    throw new DeploymentContractError(
      "data_retention_failed",
      "uninstall did not preserve the existing data PVCs",
    );
  }
  return {
    action: "uninstall",
    mode: "confirmed",
    profile: request.profile.name,
    retainedPvcs: [
      ...(runtimeAfter === null ? [] : [RUNTIME_PVC]),
      ...(prometheusAfter === null ? [] : [PROMETHEUS_PVC]),
    ],
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
    applicationPods,
    runtimeService,
    consoleService,
    runtimePvc,
    runtimeConfig,
    consoleConfig,
    applicationNetworkPolicies,
    prometheus,
    alertmanager,
    kubeStateMetrics,
    monitoringPods,
    prometheusService,
    alertmanagerService,
    kubeStateMetricsService,
    prometheusPvc,
    prometheusConfig,
    prometheusRules,
    alertmanagerConfig,
    monitoringNetworkPolicies,
    monitoringRole,
    monitoringRoleBinding,
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
      readJsonResource(execute, request.context, [
        "get",
        "deployment",
        "prometheus",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Prometheus Deployment"),
      readJsonResource(execute, request.context, [
        "get",
        "deployment",
        "alertmanager",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Alertmanager Deployment"),
      readJsonResource(execute, request.context, [
        "get",
        "deployment",
        "kube-state-metrics",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "kube-state-metrics Deployment"),
      readJsonResource(execute, request.context, [
        "get",
        "pods",
        "--namespace",
        MONITORING_NAMESPACE,
        "--selector=app.kubernetes.io/part-of=k8s-incident-agent",
        "--output=json",
      ], "monitoring Pods"),
      readJsonResource(execute, request.context, [
        "get",
        "service",
        "prometheus",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Prometheus Service"),
      readJsonResource(execute, request.context, [
        "get",
        "service",
        "alertmanager",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Alertmanager Service"),
      readJsonResource(execute, request.context, [
        "get",
        "service",
        "kube-state-metrics",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "kube-state-metrics Service"),
      readJsonResource(execute, request.context, [
        "get",
        "persistentvolumeclaim",
        PROMETHEUS_PVC,
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Prometheus PVC"),
      readJsonResource(execute, request.context, [
        "get",
        "configmap",
        "prometheus-config",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Prometheus ConfigMap"),
      readJsonResource(execute, request.context, [
        "get",
        "configmap",
        "prometheus-rules",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Prometheus rules ConfigMap"),
      readJsonResource(execute, request.context, [
        "get",
        "configmap",
        "alertmanager-config",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "Alertmanager ConfigMap"),
      readJsonResource(execute, request.context, [
        "get",
        "networkpolicies",
        "--namespace",
        MONITORING_NAMESPACE,
        "--output=json",
      ], "monitoring NetworkPolicies"),
      readJsonResource(execute, request.context, [
        "get",
        "role",
        "managed-monitoring-read",
        "--namespace",
        DIAGNOSTIC_NAMESPACE,
        "--output=json",
      ], "monitoring Role"),
      readJsonResource(execute, request.context, [
        "get",
        "rolebinding",
        "managed-monitoring-read",
        "--namespace",
        DIAGNOSTIC_NAMESPACE,
        "--output=json",
      ], "monitoring RoleBinding"),
      renderProfile(contract, request.profile, execute),
    ]);

  const desiredResources = indexRenderedManifest(desiredManifest);
  const configurationDigests = requireRenderedMonitoringContract(
    desiredResources,
    contract.monitoring.catalog,
  );

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
  requireReadyPods(applicationPods);
  requireClusterIpService(runtimeService, "agent-runtime", 8000);
  requireClusterIpService(consoleService, "incident-console", 80);
  const volumeName = requireBoundPvc(runtimePvc, request.profile);
  requireRuntimeConfig(runtimeConfig);
  requireConsoleConfig(consoleConfig);
  requireNetworkPolicies(
    applicationNetworkPolicies,
    desiredResources,
    APPLICATION_NAMESPACE,
    "application",
  );

  requireReadyMonitoringDeployment(
    prometheus,
    "prometheus",
    contract,
    request.profile,
    configurationDigests,
  );
  requireReadyMonitoringDeployment(
    alertmanager,
    "alertmanager",
    contract,
    request.profile,
    configurationDigests,
  );
  requireReadyMonitoringDeployment(
    kubeStateMetrics,
    "kube-state-metrics",
    contract,
    request.profile,
    configurationDigests,
  );
  requireReadyMonitoringPods(monitoringPods);
  requireMonitoringService(prometheusService, "prometheus", [
    ["http", 9090],
  ]);
  requireMonitoringService(alertmanagerService, "alertmanager", [
    ["http", 9093],
  ]);
  requireMonitoringService(kubeStateMetricsService, "kube-state-metrics", [
    ["http", 8080],
    ["telemetry", 8081],
  ]);
  const prometheusVolumeName = requireBoundPrometheusPvc(
    prometheusPvc,
    request.profile,
  );
  requireRenderedDataResource(
    prometheusConfig,
    desiredResources,
    "ConfigMap",
    "prometheus-config",
    MONITORING_NAMESPACE,
  );
  requireRenderedDataResource(
    prometheusRules,
    desiredResources,
    "ConfigMap",
    "prometheus-rules",
    MONITORING_NAMESPACE,
  );
  requireRenderedDataResource(
    alertmanagerConfig,
    desiredResources,
    "ConfigMap",
    "alertmanager-config",
    MONITORING_NAMESPACE,
  );
  requireRenderedRbacResource(
    monitoringRole,
    desiredResources,
    "Role",
    "managed-monitoring-read",
  );
  requireRenderedRbacResource(
    monitoringRoleBinding,
    desiredResources,
    "RoleBinding",
    "managed-monitoring-read",
  );
  requireNetworkPolicies(
    monitoringNetworkPolicies,
    desiredResources,
    MONITORING_NAMESPACE,
    "monitoring",
  );
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
  await Promise.all([
    requireDiagnosticAccess(request, execute),
    requireMonitoringAccess(request, execute),
  ]);

  return {
    ...(options.action === undefined ? {} : { action: options.action }),
    cluster: request.profile.platform,
    deployments: "ready",
    ingress:
      request.profile.platform === "k3s" ? "traefik-ready" : "not-installed",
    intakeMode: request.profile.intakeMode,
    networkPolicies: "matched",
    networkPolicyEnforcement: "requires-live-probe",
    pods: 2,
    profile: request.profile.name,
    pvc: { name: RUNTIME_PVC, phase: "Bound", volumeName },
    rbac: "matched",
    services: "cluster-ip-only",
    monitoring: {
      components: "ready",
      networkPolicies: "matched",
      pods: 3,
      pvc: {
        name: PROMETHEUS_PVC,
        phase: "Bound",
        volumeName: prometheusVolumeName,
      },
      rbac: "matched",
      rules: "matched",
      secretProjection: "configured",
      services: "cluster-ip-only",
    },
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
    await requireRequiredSecrets(request.context, execute);
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

async function requireRequiredSecrets(context, execute) {
  for (const [namespace, name, key, label] of [
    [APPLICATION_NAMESPACE, RUNTIME_SECRET, RUNTIME_SECRET_KEY, "Runtime model"],
    [
      APPLICATION_NAMESPACE,
      ALERTMANAGER_WEBHOOK_SECRET,
      ALERTMANAGER_WEBHOOK_SECRET_KEY,
      "Runtime webhook",
    ],
    [
      MONITORING_NAMESPACE,
      ALERTMANAGER_WEBHOOK_SECRET,
      ALERTMANAGER_WEBHOOK_SECRET_KEY,
      "Alertmanager webhook",
    ],
  ]) {
    const state = (
      await runKubectl(
        execute,
        context,
        [
          "get",
          "secret",
          name,
          "--namespace",
          namespace,
          `--output=go-template={{if index .data "${key}"}}present{{else}}missing{{end}}`,
        ],
        READ_TIMEOUT_MILLISECONDS,
        `${label} Secret key check`,
      )
    ).trim();
    if (state !== "present") {
      throw new DeploymentContractError(
        "secret_contract_invalid",
        `${label} Secret is missing the required non-empty key`,
      );
    }
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
    {
      verb: "get",
      resource: "pods",
      subresource: "log",
      expected: true,
      namespaced: true,
    },
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
    {
      verb: "create",
      resource: "pods",
      subresource: "attach",
      expected: false,
      namespaced: true,
    },
    { verb: "create", resource: "deployments.apps", expected: false, namespaced: true },
    { verb: "update", resource: "deployments.apps", expected: false, namespaced: true },
    { verb: "patch", resource: "deployments.apps", expected: false, namespaced: true },
    { verb: "delete", resource: "deployments.apps", expected: false, namespaced: true },
  ];
  await requireAccessChecks(
    request,
    execute,
    subject,
    DIAGNOSTIC_NAMESPACE,
    checks,
    "diagnostic ServiceAccount permissions do not match the Runtime gate",
  );
  await requireAccessChecks(
    request,
    execute,
    subject,
    APPLICATION_NAMESPACE,
    [{ verb: "get", resource: "secrets", expected: false, namespaced: true }],
    "Runtime ServiceAccount must not read mounted Secret objects",
  );
}

async function requireMonitoringAccess(request, execute) {
  const kubeStateMetrics =
    `system:serviceaccount:${MONITORING_NAMESPACE}:kube-state-metrics`;
  await requireAccessChecks(
    request,
    execute,
    kubeStateMetrics,
    DIAGNOSTIC_NAMESPACE,
    [
      { verb: "get", resource: "pods", expected: true, namespaced: true },
      { verb: "list", resource: "pods", expected: true, namespaced: true },
      { verb: "watch", resource: "pods", expected: true, namespaced: true },
      {
        verb: "get",
        resource: "deployments.apps",
        expected: true,
        namespaced: true,
      },
      {
        verb: "list",
        resource: "deployments.apps",
        expected: true,
        namespaced: true,
      },
      {
        verb: "watch",
        resource: "deployments.apps",
        expected: true,
        namespaced: true,
      },
      {
        verb: "get",
        resource: "replicasets.apps",
        expected: true,
        namespaced: true,
      },
      {
        verb: "list",
        resource: "replicasets.apps",
        expected: true,
        namespaced: true,
      },
      {
        verb: "watch",
        resource: "replicasets.apps",
        expected: true,
        namespaced: true,
      },
      { verb: "get", resource: "secrets", expected: false, namespaced: true },
      { verb: "list", resource: "configmaps", expected: false, namespaced: true },
      {
        verb: "list",
        resource: "persistentvolumes",
        expected: false,
        namespaced: false,
      },
      { verb: "create", resource: "pods", expected: false, namespaced: true },
      {
        verb: "patch",
        resource: "deployments.apps",
        expected: false,
        namespaced: true,
      },
    ],
    "kube-state-metrics permissions exceed the managed metric scope",
  );
  await requireAccessChecks(
    request,
    execute,
    kubeStateMetrics,
    MONITORING_NAMESPACE,
    [{ verb: "get", resource: "secrets", expected: false, namespaced: true }],
    "kube-state-metrics must not read monitoring Secret objects",
  );

  for (const serviceAccount of ["prometheus", "alertmanager"]) {
    const subject =
      `system:serviceaccount:${MONITORING_NAMESPACE}:${serviceAccount}`;
    await requireAccessChecks(
      request,
      execute,
      subject,
      DIAGNOSTIC_NAMESPACE,
      [{ verb: "list", resource: "pods", expected: false, namespaced: true }],
      `${serviceAccount} must not read Kubernetes business resources`,
    );
    await requireAccessChecks(
      request,
      execute,
      subject,
      MONITORING_NAMESPACE,
      [{ verb: "get", resource: "secrets", expected: false, namespaced: true }],
      `${serviceAccount} must not read mounted Secret objects`,
    );
  }
}

async function requireAccessChecks(
  request,
  execute,
  subject,
  namespace,
  checks,
  failureMessage,
) {
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
        ...(check.namespaced ? ["--namespace", namespace] : []),
      ],
      READ_TIMEOUT_MILLISECONDS,
      "ServiceAccount access review",
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
        failureMessage,
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

async function readOptionalPvc(request, execute, namespace, name) {
  const output = await runKubectl(
    execute,
    request.context,
    [
      "get",
      "persistentvolumeclaim",
      name,
      "--namespace",
      namespace,
      "--ignore-not-found=true",
      "--output=json",
    ],
    READ_TIMEOUT_MILLISECONDS,
    `${name} PVC retention check`,
  );
  if (output.trim() === "") return null;
  return parseJsonObject(output, `${name} PVC`);
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
    const alertmanagerWebhook = pod.volumes?.find(
      (volume) => volume?.name === "alertmanager-webhook",
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
      ) ||
      !containers[0]?.volumeMounts?.some(
        (mount) =>
          mount?.name === "alertmanager-webhook" &&
          mount?.mountPath ===
            "/var/run/secrets/k8s-incident-agent/alertmanager" &&
          mount?.readOnly === true,
      ) ||
      alertmanagerWebhook?.secret?.secretName !==
        ALERTMANAGER_WEBHOOK_SECRET ||
      alertmanagerWebhook?.secret?.defaultMode !== 0o400 ||
      !isDeepStrictEqual(alertmanagerWebhook?.secret?.items, [
        { key: ALERTMANAGER_WEBHOOK_SECRET_KEY, path: "token" },
      ])
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

function requireReadyMonitoringDeployment(
  document,
  name,
  contract,
  profile,
  configurationDigests,
) {
  const componentName =
    name === "kube-state-metrics" ? "kubeStateMetrics" : name;
  const component = contract.monitoring.components[componentName];
  const pod = document.spec?.template?.spec;
  const containers = pod?.containers ?? [];
  const initContainers = pod?.initContainers ?? [];
  const container = containers[0];
  const expectedInitNames =
    name === "prometheus" && profile.platform === "kind"
      ? ["prepare-kind-volume"]
      : [];
  if (
    document.kind !== "Deployment" ||
    document.metadata?.name !== name ||
    document.metadata?.namespace !== MONITORING_NAMESPACE ||
    document.metadata?.labels?.["app.kubernetes.io/version"] !==
      component.version.replace(/^v/, "") ||
    document.spec?.replicas !== 1 ||
    (["prometheus", "alertmanager"].includes(name) &&
      document.spec?.strategy?.type !== "Recreate") ||
    document.status?.observedGeneration !== document.metadata?.generation ||
    document.status?.replicas !== 1 ||
    document.status?.updatedReplicas !== 1 ||
    document.status?.availableReplicas !== 1 ||
    (["prometheus", "alertmanager"].includes(name) &&
      document.spec?.template?.metadata?.annotations?.[
        "k8s-incident-agent.io/config-digest"
      ] !== configurationDigests[name]) ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== (name === "kube-state-metrics") ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.runAsUser !== 65534 ||
    pod?.securityContext?.runAsGroup !== 65534 ||
    !isDeepStrictEqual(
      initContainers.map((candidate) => candidate?.name),
      expectedInitNames,
    ) ||
    containers.length !== 1 ||
    container?.name !== name ||
    container?.image !== component.image
  ) {
    throw stateError(`${name} Deployment does not match the managed component`);
  }
  requireHardenedContainer(container, name);

  if (name === "prometheus") {
    if (
      !isDeepStrictEqual(container.args, [
        "--config.file=/etc/prometheus/prometheus.yaml",
        "--storage.tsdb.path=/prometheus",
      ]) ||
      !hasVolumeMount(container, "config", "/etc/prometheus/prometheus.yaml", true) ||
      !hasVolumeMount(container, "rules", "/etc/prometheus/rules", true) ||
      !hasVolumeMount(container, "data", "/prometheus", false) ||
      findVolume(pod, "config")?.configMap?.name !== "prometheus-config" ||
      findVolume(pod, "rules")?.configMap?.name !== "prometheus-rules" ||
      findVolume(pod, "data")?.persistentVolumeClaim?.claimName !==
        PROMETHEUS_PVC
    ) {
      throw stateError("Prometheus configuration or storage projection drifted");
    }
    if (profile.platform === "kind") {
      const [prepare] = initContainers;
      if (
        prepare?.image !== contract.images["k8s-incident-agent-runtime"] ||
        !isDeepStrictEqual(prepare?.command, [
          "/usr/bin/chown",
          "65534:65534",
          "/prometheus",
        ]) ||
        prepare?.securityContext?.runAsUser !== 0 ||
        prepare?.securityContext?.runAsGroup !== 0 ||
        prepare?.securityContext?.runAsNonRoot !== false ||
        prepare?.securityContext?.allowPrivilegeEscalation !== false ||
        prepare?.securityContext?.readOnlyRootFilesystem !== true ||
        !isDeepStrictEqual(prepare?.securityContext?.capabilities, {
          add: ["CHOWN"],
          drop: ["ALL"],
        }) ||
        !hasVolumeMount(prepare, "data", "/prometheus", false)
      ) {
        throw stateError("Kind Prometheus volume preparation is not minimally scoped");
      }
    }
    requireHttpProbes(container, "/-/ready", "http", "/-/healthy", "http");
    return;
  }

  if (name === "alertmanager") {
    const webhookCredential = findVolume(pod, "webhook-credential")?.secret;
    if (
      !isDeepStrictEqual(container.args, [
        "--config.file=/etc/alertmanager/alertmanager.yaml",
        "--storage.path=/alertmanager",
        "--cluster.listen-address=",
      ]) ||
      !hasVolumeMount(
        container,
        "config",
        "/etc/alertmanager/alertmanager.yaml",
        true,
      ) ||
      !hasVolumeMount(container, "data", "/alertmanager", false) ||
      !hasVolumeMount(
        container,
        "webhook-credential",
        "/etc/alertmanager/secrets/webhook",
        true,
      ) ||
      findVolume(pod, "config")?.configMap?.name !== "alertmanager-config" ||
      findVolume(pod, "data")?.emptyDir?.sizeLimit !== "64Mi" ||
      webhookCredential?.secretName !== ALERTMANAGER_WEBHOOK_SECRET ||
      webhookCredential?.defaultMode !== 0o400 ||
      !isDeepStrictEqual(webhookCredential?.items, [
        { key: ALERTMANAGER_WEBHOOK_SECRET_KEY, path: "token" },
      ])
    ) {
      throw stateError("Alertmanager configuration or credential projection drifted");
    }
    requireHttpProbes(container, "/-/ready", "http", "/-/healthy", "http");
    return;
  }

  if (
    !isDeepStrictEqual(container.args, [
      "--namespaces=k8s-incident-scenarios",
      "--resources=deployments,pods,replicasets",
      "--metric-allowlist=kube_deployment_status_replicas_available,kube_pod_container_status_restarts_total,kube_pod_container_status_waiting_reason,kube_pod_owner,kube_replicaset_owner",
      "--use-apiserver-cache",
    ])
  ) {
    throw stateError("kube-state-metrics collection scope drifted");
  }
  requireHttpProbes(container, "/readyz", "telemetry", "/livez", "http");
}

function requireHardenedContainer(container, name) {
  if (
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !isDeepStrictEqual(container?.securityContext?.capabilities, {
      drop: ["ALL"],
    })
  ) {
    throw stateError(`${name} container security context drifted`);
  }
}

function requireHttpProbes(
  container,
  readinessPath,
  readinessPort,
  livenessPath,
  livenessPort,
) {
  if (
    container?.startupProbe?.httpGet?.path !== readinessPath ||
    container?.startupProbe?.httpGet?.port !== readinessPort ||
    container?.readinessProbe?.httpGet?.path !== readinessPath ||
    container?.readinessProbe?.httpGet?.port !== readinessPort ||
    container?.livenessProbe?.httpGet?.path !== livenessPath ||
    container?.livenessProbe?.httpGet?.port !== livenessPort
  ) {
    throw stateError(`${container?.name ?? "monitoring"} health probes drifted`);
  }
}

function hasVolumeMount(container, name, mountPath, readOnly) {
  return container?.volumeMounts?.some(
    (mount) =>
      mount?.name === name &&
      mount?.mountPath === mountPath &&
      (readOnly ? mount?.readOnly === true : mount?.readOnly !== true),
  ) === true;
}

function findVolume(pod, name) {
  return pod?.volumes?.find((volume) => volume?.name === name);
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
  requireReadyPodSet(
    document,
    ["agent-runtime", "incident-console"],
    "application Pods are not both ready",
  );
}

function requireReadyMonitoringPods(document) {
  requireReadyPodSet(
    document,
    ["prometheus", "alertmanager", "kube-state-metrics"],
    "monitoring Pods are not all ready",
  );
}

function requireReadyPodSet(document, names, failureMessage) {
  if (document.kind !== "List" || !Array.isArray(document.items)) {
    throw stateError(failureMessage);
  }
  const activePods = document.items.filter(
    (pod) =>
      pod.metadata?.deletionTimestamp === undefined ||
      pod.metadata?.deletionTimestamp === null,
  );
  const expectedNames = new Set(names);
  const actualNames = new Set();
  if (activePods.length !== expectedNames.size) {
    throw stateError(failureMessage);
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
      throw stateError(failureMessage);
    }
    actualNames.add(appName);
  }
}

function requireClusterIpService(document, name, port) {
  requireClusterIpServicePorts(
    document,
    name,
    APPLICATION_NAMESPACE,
    [["http", port]],
  );
}

function requireMonitoringService(document, name, ports) {
  requireClusterIpServicePorts(
    document,
    name,
    MONITORING_NAMESPACE,
    ports,
  );
}

function requireClusterIpServicePorts(document, name, namespace, ports) {
  const actualPorts = document.spec?.ports?.map((port) => [
    port?.name,
    port?.port,
    port?.targetPort,
    port?.protocol,
  ]);
  const expectedPorts = ports.map(([portName, port]) => [
    portName,
    port,
    portName,
    "TCP",
  ]);
  if (
    document.kind !== "Service" ||
    document.metadata?.name !== name ||
    document.metadata?.namespace !== namespace ||
    document.spec?.type !== "ClusterIP" ||
    typeof document.spec?.clusterIP !== "string" ||
    document.spec.clusterIP === "" ||
    document.spec.clusterIP === "None" ||
    !isDeepStrictEqual(document.spec?.selector, {
      "app.kubernetes.io/name": name,
    }) ||
    !isDeepStrictEqual(actualPorts, expectedPorts)
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

function requireBoundPrometheusPvc(document, profile) {
  const expectedStorageClass =
    profile.platform === "k3s"
      ? "local-path"
      : "k8s-incident-agent-monitoring-kind";
  if (
    document.kind !== "PersistentVolumeClaim" ||
    document.metadata?.name !== PROMETHEUS_PVC ||
    document.metadata?.namespace !== MONITORING_NAMESPACE ||
    document.spec?.storageClassName !== expectedStorageClass ||
    document.status?.phase !== "Bound"
  ) {
    throw stateError("Prometheus PVC is not Bound");
  }
  const volumeName = requireString(
    document.spec?.volumeName,
    "Prometheus PV name",
  );
  if (
    profile.platform === "kind" &&
    volumeName !== "k8s-incident-agent-prometheus-data"
  ) {
    throw stateError("Prometheus PVC does not use the fixed Kind volume");
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
    ALERT_CATALOG_DIR: "/workspace/monitoring/catalog",
    ALERTMANAGER_WEBHOOK_TOKEN_FILE:
      "/var/run/secrets/k8s-incident-agent/alertmanager/token",
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
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000" ||
    document.data?.YAML_ASSISTANT_URL !== "/k8s-yaml-assistant"
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

function requireRenderedDataResource(
  document,
  desiredResources,
  kind,
  name,
  namespace,
) {
  const desired = requireRenderedResource(
    desiredResources,
    kind,
    name,
    namespace,
  );
  if (
    document.kind !== kind ||
    document.metadata?.name !== name ||
    document.metadata?.namespace !== namespace ||
    !isDeepStrictEqual(document.data, desired.data)
  ) {
    throw stateError(`${name} ${kind} does not match the rendered contract`);
  }
}

function requireRenderedRbacResource(document, desiredResources, kind, name) {
  const desired = requireRenderedResource(
    desiredResources,
    kind,
    name,
    DIAGNOSTIC_NAMESPACE,
  );
  const matches =
    kind === "Role"
      ? isDeepStrictEqual(document.rules, desired.rules)
      : isDeepStrictEqual(document.subjects, desired.subjects) &&
        isDeepStrictEqual(document.roleRef, desired.roleRef);
  if (
    document.kind !== kind ||
    document.metadata?.name !== name ||
    document.metadata?.namespace !== DIAGNOSTIC_NAMESPACE ||
    !matches
  ) {
    throw stateError(`${name} ${kind} does not match the rendered contract`);
  }
}

function requireRenderedMonitoringContract(desiredResources, catalog) {
  const prometheusConfig = requireRenderedResource(
    desiredResources,
    "ConfigMap",
    "prometheus-config",
    MONITORING_NAMESPACE,
  );
  const rulesConfig = requireRenderedResource(
    desiredResources,
    "ConfigMap",
    "prometheus-rules",
    MONITORING_NAMESPACE,
  );
  const alertmanagerConfig = requireRenderedResource(
    desiredResources,
    "ConfigMap",
    "alertmanager-config",
    MONITORING_NAMESPACE,
  );
  requirePrometheusConfiguration(prometheusConfig.data?.["prometheus.yaml"]);
  requireAlertmanagerConfiguration(
    alertmanagerConfig.data?.["alertmanager.yaml"],
  );
  requireCatalogRules(rulesConfig.data?.["alerts.yaml"], catalog);
  const configurationDigests = {
    prometheus: configurationDigest(prometheusConfig.data, rulesConfig.data),
    alertmanager: configurationDigest(alertmanagerConfig.data),
  };
  for (const name of ["prometheus", "alertmanager"]) {
    const deployment = requireRenderedResource(
      desiredResources,
      "Deployment",
      name,
      MONITORING_NAMESPACE,
    );
    if (
      !isDeepStrictEqual(deployment.spec?.template?.metadata?.annotations, {
        "k8s-incident-agent.io/config-digest": configurationDigests[name],
      })
    ) {
      throw new DeploymentContractError(
        "monitoring_contract_invalid",
        `${name} Deployment is not bound to its configuration digest`,
      );
    }
  }
  return configurationDigests;
}

function configurationDigest(...data) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex")}`;
}

function requirePrometheusConfiguration(rawConfiguration) {
  let configuration;
  try {
    configuration = load(requireString(rawConfiguration, "Prometheus config"));
  } catch (error) {
    if (error instanceof DeploymentContractError) throw error;
    throw new DeploymentContractError(
      "monitoring_contract_invalid",
      "Prometheus configuration is invalid YAML",
    );
  }
  const scrape = (jobName, target, bodySizeLimit, sampleLimit) => ({
    job_name: jobName,
    static_configs: [{ targets: [target] }],
    body_size_limit: bodySizeLimit,
    sample_limit: sampleLimit,
    label_limit: 64,
    label_name_length_limit: 128,
    label_value_length_limit: 512,
  });
  const expected = {
    global: {
      scrape_interval: "15s",
      scrape_timeout: "10s",
      evaluation_interval: "15s",
      external_labels: { cluster: "k8s-incident-agent" },
    },
    storage: {
      tsdb: { retention: { time: "24h", size: "1GB" } },
    },
    rule_files: ["/etc/prometheus/rules/*.yaml"],
    alerting: {
      alertmanagers: [
        {
          api_version: "v2",
          static_configs: [
            {
              targets: [
                "alertmanager.k8s-incident-monitoring.svc.cluster.local:9093",
              ],
            },
          ],
        },
      ],
    },
    scrape_configs: [
      scrape("prometheus", "127.0.0.1:9090", "2MB", 10000),
      scrape(
        "kube-state-metrics",
        "kube-state-metrics.k8s-incident-monitoring.svc.cluster.local:8080",
        "16MB",
        50000,
      ),
      scrape(
        "kube-state-metrics-telemetry",
        "kube-state-metrics.k8s-incident-monitoring.svc.cluster.local:8081",
        "2MB",
        10000,
      ),
      scrape(
        "alertmanager",
        "alertmanager.k8s-incident-monitoring.svc.cluster.local:9093",
        "2MB",
        10000,
      ),
    ],
  };
  if (!isDeepStrictEqual(configuration, expected)) {
    throw new DeploymentContractError(
      "monitoring_contract_invalid",
      "Prometheus configuration does not match the managed topology",
    );
  }
}

function requireAlertmanagerConfiguration(rawConfiguration) {
  let configuration;
  try {
    configuration = load(requireString(rawConfiguration, "Alertmanager config"));
  } catch (error) {
    if (error instanceof DeploymentContractError) throw error;
    throw new DeploymentContractError(
      "monitoring_contract_invalid",
      "Alertmanager configuration is invalid YAML",
    );
  }
  const expected = {
    global: { resolve_timeout: "1m" },
    route: {
      receiver: "agent-runtime",
      group_by: ["alertname", "cluster", "namespace", "deployment"],
      group_wait: "1s",
      group_interval: "15s",
      repeat_interval: "5m",
    },
    receivers: [
      {
        name: "agent-runtime",
        webhook_configs: [
          {
            url:
              "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000/api/v1/alerts/alertmanager",
            send_resolved: true,
            max_alerts: 0,
            timeout: "10s",
            http_config: {
              authorization: {
                type: "Bearer",
                credentials_file:
                  "/etc/alertmanager/secrets/webhook/token",
              },
            },
          },
        ],
      },
    ],
  };
  if (!isDeepStrictEqual(configuration, expected)) {
    throw new DeploymentContractError(
      "monitoring_contract_invalid",
      "Alertmanager configuration does not match the Runtime trust boundary",
    );
  }
}

function requireCatalogRules(rawRules, catalog) {
  let document;
  try {
    document = load(requireString(rawRules, "Prometheus rules"));
  } catch (error) {
    if (error instanceof DeploymentContractError) throw error;
    throw new DeploymentContractError(
      "monitoring_contract_invalid",
      "Prometheus rules are invalid YAML",
    );
  }
  if (
    !Array.isArray(document?.groups) ||
    document.groups.length !== 1 ||
    document.groups[0]?.name !== "k8s-incident-agent" ||
    !Array.isArray(document.groups[0]?.rules)
  ) {
    throw new DeploymentContractError(
      "monitoring_contract_invalid",
      "Prometheus rules do not match the alert catalog",
    );
  }
  const rules = document.groups[0].rules;
  const watchdogs = rules.filter((rule) => rule?.alert === "Watchdog");
  const alertRules = rules.filter((rule) => rule?.alert !== "Watchdog");
  if (
    watchdogs.length !== 1 ||
    !isDeepStrictEqual(watchdogs[0], {
      alert: "Watchdog",
      expr: "vector(1)",
      labels: { severity: "none" },
    }) ||
    alertRules.length !== catalog.entries.size
  ) {
    throw new DeploymentContractError(
      "monitoring_contract_invalid",
      "Prometheus rules do not match the alert catalog",
    );
  }
  const seen = new Set();
  for (const rule of alertRules) {
    const expected = catalog.entries.get(rule?.alert);
    if (
      expected === undefined ||
      seen.has(rule.alert) ||
      normalizePromql(rule?.expr) !== normalizePromql(expected.expression) ||
      rule?.for !== expected.pendingFor ||
      !isDeepStrictEqual(rule?.labels, { severity: "warning" }) ||
      !isDeepStrictEqual(
        Object.keys(rule ?? {}).sort(),
        ["alert", "expr", "for", "labels"],
      )
    ) {
      throw new DeploymentContractError(
        "monitoring_contract_invalid",
        "Prometheus rules do not match the alert catalog",
      );
    }
    seen.add(rule.alert);
  }
}

function normalizePromql(value) {
  if (typeof value !== "string") return "";
  let normalized = "";
  let quoted = false;
  let escaped = false;
  let whitespace = false;
  for (const character of value.trim()) {
    if (quoted) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      normalized += character;
      whitespace = false;
      continue;
    }
    if (/\s/.test(character)) {
      whitespace = true;
      continue;
    }
    if (
      whitespace &&
      /[A-Za-z0-9_]/.test(normalized.at(-1) ?? "") &&
      /[A-Za-z0-9_]/.test(character)
    ) {
      normalized += " ";
    }
    normalized += character;
    whitespace = false;
  }
  return normalized;
}

function requireNetworkPolicies(
  document,
  desiredResources,
  namespace,
  label,
) {
  if (
    document.kind !== "List" ||
    !Array.isArray(document.items)
  ) {
    throw stateError(`${label} NetworkPolicies are unavailable`);
  }
  const expected = new Map();
  for (const resource of desiredResources.values()) {
    if (
      resource?.kind === "NetworkPolicy" &&
      resource.metadata?.namespace === namespace
    ) {
      expected.set(resource.metadata.name, resource.spec);
    }
  }
  if (expected.size === 0 || document.items.length !== expected.size) {
    throw stateError(`${label} NetworkPolicies do not match the selected profile`);
  }
  const actualNames = new Set();
  for (const policy of document.items) {
    const name = policy?.metadata?.name;
    if (
      policy?.kind !== "NetworkPolicy" ||
      policy?.metadata?.namespace !== namespace ||
      typeof name !== "string" ||
      actualNames.has(name) ||
      !isDeepStrictEqual(policy.spec, expected.get(name))
    ) {
      throw stateError(`${label} NetworkPolicies do not match the selected profile`);
    }
    actualNames.add(name);
  }
}

function indexRenderedManifest(rawYaml) {
  const resources = new Map();
  try {
    loadAll(rawYaml, (document) => {
      if (document === undefined || document === null) return;
      const kind = requireString(document.kind, "rendered resource kind");
      const name = requireString(
        document.metadata?.name,
        "rendered resource name",
      );
      const namespace = document.metadata?.namespace ?? "";
      const key = renderedResourceKey(kind, name, namespace);
      if (resources.has(key)) {
        throw new DeploymentContractError(
          "render_contract_invalid",
          "Kustomize render contains duplicate resource identities",
        );
      }
      resources.set(key, document);
    });
  } catch (error) {
    if (error instanceof DeploymentContractError) throw error;
    throw new DeploymentContractError(
      "render_contract_invalid",
      "Kustomize returned invalid YAML",
    );
  }
  if (resources.size === 0) {
    throw new DeploymentContractError(
      "render_contract_invalid",
      "Kustomize render is empty",
    );
  }
  return resources;
}

function requireRenderedResource(resources, kind, name, namespace) {
  const resource = resources.get(renderedResourceKey(kind, name, namespace));
  if (resource === undefined) {
    throw new DeploymentContractError(
      "render_contract_invalid",
      `Kustomize render is missing ${kind}/${namespace}/${name}`,
    );
  }
  return resource;
}

function renderedResourceKey(kind, name, namespace) {
  return `${kind}/${namespace}/${name}`;
}

function stateError(message) {
  return new DeploymentContractError("installation_not_ready", message);
}

function renderedInventory(resources) {
  return [...resources.values()]
    .map((document) => {
      const namespace = document.metadata?.namespace;
      return `${document.kind}/${
        typeof namespace === "string" && namespace !== ""
          ? `${namespace}/`
          : ""
      }${document.metadata.name}`;
    })
    .sort();
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
