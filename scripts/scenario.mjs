import { execFile } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { loadAll } from "js-yaml";

import {
  DeploymentContractError,
  verifyDeploymentStatus,
} from "./deployment.mjs";
import { runClusterCommand } from "./kind-cluster.mjs";

const CLUSTER_NAME = "k8s-incident-agent";
const CONTEXT_NAME = "kind-k8s-incident-agent";
const NAMESPACE = "k8s-incident-scenarios";
const SCENARIO_SCHEMA_VERSION = 2;
const DEFAULT_SCENARIO_VERSION = 1;
const SCENARIO_VERSION_OVERRIDES = new Map([
  ["image-pull-backoff", 2],
]);
const MAX_FILE_BYTES = 1024 * 1024;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const HEALTHY_ROLLOUT_TIMEOUT_MILLISECONDS = 125_000;
const ROOT_CAUSE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ROOT_CAUSE_GLOB_PATTERN = /^(?:\*)?[a-z][a-z0-9_]*(?:\*[a-z0-9_]*)+$/;
const EXPECTED_IMAGE = "registry.invalid/k8s-incident-agent/missing:v1";
const AGNHOST_IMAGE =
  "registry.k8s.io/e2e-test-images/agnhost:2.53@sha256:99c6b4bb4a1e1df3f0b3752168c89358794d02258ebebc26bf21c29399011a85";
const WAITING_REASONS = new Set(["ErrImagePull", "ImagePullBackOff"]);
const SERVICE_ASSOCIATION_LABEL = "k8s-incident-agent.io/service";
const SERVICE_MONITORING_LABEL = "k8s-incident-agent.io/monitor-selector";
const READINESS_CONTAINER_LABEL =
  "k8s-incident-agent.io/readiness-container";
const READINESS_SLO_LABEL = "k8s-incident-agent.io/readiness-slo";
const LIVENESS_CONTAINER_LABEL =
  "k8s-incident-agent.io/liveness-container";
const ENDPOINT_SLICE_SERVICE_LABEL = "kubernetes.io/service-name";
const PVC_PENDING_POLICY_LABEL =
  "k8s-incident-agent.io/pending-policy";
const PVC_STORAGE_SIZE = "1Mi";
const VALID_VERIFIERS = new Set([
  "image_pull_backoff",
  "crash_loop_backoff",
  "service_selector_mismatch",
  "readiness_probe_failure",
  "liveness_probe_failure",
  "pvc_pending",
]);
const DIAGNOSTIC_EVIDENCE_TOOLS = new Map([
  ["workload", "get_workload"],
  ["rollout_history", "get_rollout_history"],
  ["pods", "get_pods"],
  ["events", "get_events"],
  ["container_logs", "get_container_logs"],
  ["service_network", "get_service_network"],
  ["pvc_storage", "get_pvc_storage"],
  ["metrics", "query_prometheus"],
]);
const VALID_DIAGNOSTIC_TOOLS = new Set(DIAGNOSTIC_EVIDENCE_TOOLS.values());
const VALID_ACTIONS = new Set(["list", "apply", "verify", "cleanup"]);
const VALID_EXECUTION_PROFILES = new Set([
  "kind-evaluation",
  "k3s-evaluation",
]);
const NOOP_LOGGER = { info() {}, error() {} };

export class ScenarioCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScenarioCommandError";
    this.code = code;
  }
}

class VerificationPending extends Error {
  constructor(reason) {
    super("Scenario verification condition is not yet satisfied");
    this.reason = reason;
  }
}

function loadScenarioCatalog(repositoryRoot, environment = process.env) {
  try {
    const normalizedRoot = normalizeRepositoryRoot(repositoryRoot);
    const catalogDirectory = resolveCatalogDirectory(normalizedRoot, environment);
    assertDedicatedCatalogDirectory(normalizedRoot, catalogDirectory);
    assertRealDirectory(catalogDirectory);

    return readdirSync(catalogDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => loadScenarioEntry(catalogDirectory, entry.name));
  } catch {
    throw new ScenarioCommandError(
      "scenario_contract_invalid",
      "Scenario catalog does not satisfy the supported contract",
    );
  }
}

export function loadEvaluationScenarioCatalog(
  repositoryRoot = repositoryRootFromModule(),
  environment = process.env,
) {
  return loadScenarioCatalog(repositoryRoot, environment).map(({ definition }) => ({
    scenarioId: definition.scenario_id,
    scenarioVersion: definition.scenario_version,
    alertId: definition.monitoring_alert_id,
    target: {
      cluster: definition.target.cluster,
      namespace: definition.target.namespace,
      apiVersion: definition.target.api_version,
      kind: definition.target.kind,
      name: definition.target.name,
    },
    expectedRootCauses: [...definition.expected_root_causes],
    requiredEvidence: [...definition.required_evidence],
    allowedTools: [...definition.allowed_tools],
    forbiddenTools: [...definition.forbidden_tools],
    verifierKind: definition.deterministic_verifier.kind,
    healthyControlNames: evaluationControlNames(definition),
  }));
}

export function supportedScenarioVersion(scenarioId) {
  return SCENARIO_VERSION_OVERRIDES.get(scenarioId) ?? DEFAULT_SCENARIO_VERSION;
}

function evaluationControlNames(definition) {
  const verifierKind = definition.deterministic_verifier.kind;
  if (verifierKind === "image_pull_backoff") return [];
  if (verifierKind === "readiness_probe_failure") {
    return [
      `${definition.target.name}-healthy-control`,
      `${definition.target.name}-slow-start-control`,
    ];
  }
  if (verifierKind === "pvc_pending") {
    return [`${definition.target.name}-wffc-control`];
  }
  return [`${definition.target.name}-healthy-control`];
}

export async function runScenarioCommand(
  action,
  scenarioId,
  dependencies = {},
) {
  assertAction(action);
  const repositoryRoot = normalizeRepositoryRoot(
    dependencies.repositoryRoot ?? repositoryRootFromModule(),
  );
  const entries = loadScenarioCatalog(
    repositoryRoot,
    dependencies.environment ?? process.env,
  );

  if (action === "list") {
    if (scenarioId !== undefined) {
      throw new ScenarioCommandError(
        "invalid_arguments",
        "The list action does not accept a scenario identifier",
      );
    }
    return entries.map(({ definition }) => publicScenario(definition));
  }

  const entry = entries.find(
    ({ definition }) => definition.scenario_id === scenarioId,
  );
  if (entry === undefined) {
    throw new ScenarioCommandError(
      "scenario_not_found",
      "Requested scenario is not present in the catalog",
    );
  }

  const target = resolveExecutionTarget(
    dependencies.profile,
    dependencies.context,
  );

  const execute = dependencies.execute ?? executeExternalCommand;
  await requireExecutionTargetReady(
    target,
    repositoryRoot,
    execute,
  );

  if (action === "apply" || action === "cleanup") {
    await mutateFixture(action, entry, target.context, execute);
    return {
      status: action === "apply" ? "applied" : "cleaned_up",
      scenario_id: entry.definition.scenario_id,
    };
  }

  return verifyScenario(entry, target.context, execute, {
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? defaultSleep,
  });
}

function resolveExecutionTarget(profile, context) {
  const normalizedProfile = profile ?? "kind-evaluation";
  if (!VALID_EXECUTION_PROFILES.has(normalizedProfile)) {
    throw invalidArguments(
      "Scenario execution requires kind-evaluation or k3s-evaluation",
    );
  }
  if (normalizedProfile === "kind-evaluation") {
    if (context !== undefined) {
      throw invalidArguments(
        "Kind evaluation uses only the fixed project context",
      );
    }
    return { profile: normalizedProfile, context: CONTEXT_NAME };
  }
  return {
    profile: normalizedProfile,
    context: requireExplicitContext(context),
  };
}

function requireExplicitContext(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value.startsWith("-") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidArguments(
      "K3s evaluation requires a normalized explicit context",
    );
  }
  return value;
}

async function requireExecutionTargetReady(
  target,
  repositoryRoot,
  execute,
) {
  if (target.profile === "kind-evaluation") {
    try {
      await runClusterCommand("status", {
        repositoryRoot,
        execute,
        logger: NOOP_LOGGER,
      });
    } catch {
      throw new ScenarioCommandError(
        "cluster_precondition_failed",
        "The fixed Kind cluster does not match the required baseline",
      );
    }
    return;
  }

  try {
    await verifyDeploymentStatus(target.profile, target.context, {
      repositoryRoot,
      execute: adaptDeploymentExecutor(execute),
    });
  } catch (error) {
    if (error instanceof DeploymentContractError) {
      throw new ScenarioCommandError(error.code, error.message);
    }
    throw new ScenarioCommandError(
      "deployment_precondition_failed",
      "The fixed K3s evaluation deployment does not match the required baseline",
    );
  }
}

function adaptDeploymentExecutor(execute) {
  return async (command, args, options) => {
    try {
      const stdout = await execute(command, args, options);
      if (typeof stdout !== "string") throw new Error("invalid command result");
      return { stdout, exitCode: 0 };
    } catch (error) {
      if (
        Number.isInteger(error?.exitCode) &&
        typeof error?.stdout === "string"
      ) {
        return { stdout: error.stdout, exitCode: error.exitCode };
      }
      throw error;
    }
  };
}

function resolveCatalogDirectory(repositoryRoot, environment) {
  const configured = environment?.SCENARIO_CATALOG_DIR;
  if (configured === undefined) return path.join(repositoryRoot, "scenarios");
  if (
    typeof configured !== "string" ||
    configured.trim() === "" ||
    !path.isAbsolute(configured)
  ) {
    throw new Error("invalid catalog directory");
  }
  return path.normalize(configured);
}

function assertDedicatedCatalogDirectory(repositoryRoot, catalogDirectory) {
  const normalizedCatalog = path.resolve(catalogDirectory);
  const broadDirectories = new Set([
    path.parse(normalizedCatalog).root,
    path.resolve(homedir()),
    repositoryRoot,
  ]);
  if (broadDirectories.has(normalizedCatalog)) throw new Error();
}

function loadScenarioEntry(catalogDirectory, scenarioDirectoryName) {
  const scenarioDirectory = path.join(catalogDirectory, scenarioDirectoryName);
  assertRealDirectory(scenarioDirectory);
  const definitionPath = path.join(scenarioDirectory, "scenario.json");
  const definition = parseJsonFile(definitionPath);
  validateScenarioDefinition(definition, scenarioDirectoryName);

  const deploymentManifests = new Map();
  const manifestPaths = definition.fixture_manifests.map((relativePath) => {
    validateManifestRelativePath(relativePath);
    const manifestPath = path.join(
      scenarioDirectory,
      ...relativePath.split("/"),
    );
    assertContainedPath(scenarioDirectory, manifestPath);
    assertRegularFileWithoutSymlinkComponents(
      scenarioDirectory,
      manifestPath,
    );
    const manifest = validateScenarioManifest(
      manifestPath,
      relativePath,
      definition,
    );
    if (manifest !== undefined) {
      deploymentManifests.set(relativePath, manifest);
    }
    return manifestPath;
  });
  validateImagePullRevisionPair(definition, deploymentManifests);

  return { definition, manifestPaths };
}

function validateScenarioDefinition(definition, directoryName) {
  assertPlainObject(definition);
  assertExactKeys(definition, [
    "schema_version",
    "scenario_id",
    "scenario_version",
    "monitoring_alert_id",
    "display_name",
    "description",
    "trigger",
    "target",
    "fixture_manifests",
    "expected_root_causes",
    "required_evidence",
    "allowed_tools",
    "forbidden_tools",
    "deterministic_verifier",
  ]);
  if (definition.schema_version !== SCENARIO_SCHEMA_VERSION) throw new Error();
  assertNormalizedString(definition.scenario_id);
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(definition.scenario_id)) {
    throw new Error();
  }
  if (definition.scenario_id !== directoryName) throw new Error();
  if (
    definition.scenario_version !== supportedScenarioVersion(definition.scenario_id)
  ) {
    throw new Error();
  }
  assertNormalizedString(definition.monitoring_alert_id);
  assertNormalizedString(definition.display_name);
  assertNormalizedString(definition.description);

  assertPlainObject(definition.trigger);
  assertExactKeys(definition.trigger, ["type", "summary"]);
  if (definition.trigger.type !== "manual") throw new Error();
  assertNormalizedString(definition.trigger.summary);

  assertPlainObject(definition.target);
  assertExactKeys(definition.target, [
    "cluster",
    "namespace",
    "api_version",
    "kind",
    "name",
  ]);
  const verifierKind = definition.deterministic_verifier?.kind;
  const targetType = verifierKind === "service_selector_mismatch"
    ? ["v1", "Service"]
    : verifierKind === "pvc_pending"
      ? ["v1", "PersistentVolumeClaim"]
      : ["apps/v1", "Deployment"];
  if (
    definition.target.cluster !== CLUSTER_NAME ||
    definition.target.namespace !== NAMESPACE ||
    definition.target.api_version !== targetType[0] ||
    definition.target.kind !== targetType[1] ||
    definition.target.name !== definition.scenario_id
  ) {
    throw new Error();
  }

  for (const field of [
    "fixture_manifests",
    "expected_root_causes",
    "required_evidence",
    "allowed_tools",
    "forbidden_tools",
  ]) {
    assertNonEmptyUniqueStringArray(definition[field]);
  }
  if (
    definition.expected_root_causes.some(
      (value) =>
        !ROOT_CAUSE_CODE_PATTERN.test(value) &&
        (value.length > 64 ||
          value.includes("**") ||
          !ROOT_CAUSE_GLOB_PATTERN.test(value)),
    )
  ) {
    throw new Error();
  }
  const forbidden = new Set(definition.forbidden_tools);
  const allowed = new Set(definition.allowed_tools);
  if (
    definition.allowed_tools.some(
      (tool) => forbidden.has(tool) || !VALID_DIAGNOSTIC_TOOLS.has(tool),
    ) ||
    definition.required_evidence.some(
      (evidenceKind) =>
        !DIAGNOSTIC_EVIDENCE_TOOLS.has(evidenceKind) ||
        !allowed.has(DIAGNOSTIC_EVIDENCE_TOOLS.get(evidenceKind)),
    )
  ) {
    throw new Error();
  }

  assertPlainObject(definition.deterministic_verifier);
  assertExactKeys(definition.deterministic_verifier, [
    "kind",
    "timeout_seconds",
    "poll_interval_seconds",
  ]);
  const expectedTimeout =
    definition.deterministic_verifier.kind === "crash_loop_backoff" ? 300 : 120;
  if (
    !VALID_VERIFIERS.has(definition.deterministic_verifier.kind) ||
    definition.deterministic_verifier.timeout_seconds !== expectedTimeout ||
    definition.deterministic_verifier.poll_interval_seconds !== 2
  ) {
    throw new Error();
  }
}

function validateManifestRelativePath(relativePath) {
  assertNormalizedString(relativePath);
  const segments = relativePath.split("/");
  if (
    path.posix.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    !/\.ya?ml$/.test(relativePath)
  ) {
    throw new Error();
  }
}

function validateScenarioManifest(manifestPath, relativePath, definition) {
  if (definition.deterministic_verifier.kind === "service_selector_mismatch") {
    validateServiceSelectorManifest(manifestPath, relativePath, definition);
    return;
  }
  if (definition.deterministic_verifier.kind === "pvc_pending") {
    validatePvcPendingManifest(manifestPath, relativePath, definition);
    return;
  }
  return validateDeploymentManifest(manifestPath, relativePath, definition);
}

function validatePvcPendingManifest(manifestPath, relativePath, definition) {
  const missingClass = definition.scenario_id === "pvc-storage-class-missing";
  if (!missingClass && definition.scenario_id !== "pvc-binding-pending") {
    throw new Error();
  }
  const expectedPaths = [
    "manifests/persistent-volume-claim.yaml",
    ...(missingClass ? [] : ["manifests/storage-class.yaml"]),
    "manifests/wffc-storage-class.yaml",
    "manifests/wffc-control.yaml",
  ];
  if (
    definition.fixture_manifests.length !== expectedPaths.length ||
    expectedPaths.some((item) => !definition.fixture_manifests.includes(item)) ||
    !expectedPaths.includes(relativePath)
  ) {
    throw new Error();
  }

  const manifest = loadSingleManifest(manifestPath);
  assertPlainObject(manifest);
  assertPlainObject(manifest.metadata);
  if (relativePath.includes("storage-class")) {
    const expectedName = relativePath === "manifests/storage-class.yaml"
      ? `${definition.scenario_id}-immediate`
      : `${definition.scenario_id}-wffc`;
    const expectedMode = relativePath === "manifests/storage-class.yaml"
      ? "Immediate"
      : "WaitForFirstConsumer";
    if (
      manifest.apiVersion !== "storage.k8s.io/v1" ||
      manifest.kind !== "StorageClass" ||
      manifest.metadata.name !== expectedName ||
      manifest.metadata.namespace !== undefined ||
      manifest.provisioner !== "kubernetes.io/no-provisioner" ||
      manifest.volumeBindingMode !== expectedMode
    ) {
      throw new Error();
    }
    return manifest;
  }

  const isControl = relativePath === "manifests/wffc-control.yaml";
  const expectedName = isControl
    ? `${definition.scenario_id}-wffc-control`
    : definition.scenario_id;
  const expectedClass = isControl
    ? `${definition.scenario_id}-wffc`
    : missingClass
      ? `${definition.scenario_id}-absent`
      : `${definition.scenario_id}-immediate`;
  if (
    manifest.apiVersion !== "v1" ||
    manifest.kind !== "PersistentVolumeClaim" ||
    manifest.metadata.name !== expectedName ||
    manifest.metadata.namespace !== NAMESPACE ||
    manifest.metadata.labels?.[PVC_PENDING_POLICY_LABEL] !==
      (isControl ? undefined : "immediate")
  ) {
    throw new Error();
  }
  assertPlainObject(manifest.spec);
  if (
    manifest.spec.storageClassName !== expectedClass ||
    !Array.isArray(manifest.spec.accessModes) ||
    manifest.spec.accessModes.length !== 1 ||
    manifest.spec.accessModes[0] !== "ReadWriteOnce" ||
    manifest.spec.resources?.requests?.storage !== PVC_STORAGE_SIZE
  ) {
    throw new Error();
  }
}

function validateDeploymentManifest(manifestPath, relativePath, definition) {
  const manifest = loadSingleManifest(manifestPath);
  assertPlainObject(manifest);
  if (
    manifest.apiVersion !== definition.target.api_version ||
    manifest.kind !== definition.target.kind
  ) {
    throw new Error();
  }
  assertPlainObject(manifest.metadata);
  const verifier = definition.deterministic_verifier.kind;
  const isHealthyControl =
    verifier !== "image_pull_backoff" &&
    relativePath === "manifests/healthy-control.yaml";
  const isSlowStartControl =
    verifier === "readiness_probe_failure" &&
    relativePath === "manifests/slow-start-control.yaml";
  const expectedName = isHealthyControl
    ? `${definition.target.name}-healthy-control`
    : isSlowStartControl
      ? `${definition.target.name}-slow-start-control`
      : definition.target.name;
  if (
    manifest.metadata.name !== expectedName ||
    manifest.metadata.namespace !== definition.target.namespace
  ) {
    throw new Error();
  }
  assertPlainObject(manifest.spec);
  const selector = manifest.spec.selector;
  assertPlainObject(selector);
  assertExactKeys(selector, ["matchLabels"]);
  const matchLabels = validateLabelMap(selector.matchLabels);

  assertPlainObject(manifest.spec.template);
  assertPlainObject(manifest.spec.template.metadata);
  const templateLabels = validateLabelMap(
    manifest.spec.template.metadata.labels,
  );
  for (const [key, value] of Object.entries(matchLabels)) {
    if (templateLabels[key] !== value) throw new Error();
  }

  assertPlainObject(manifest.spec.template.spec);
  const containers = manifest.spec.template.spec.containers;
  if (!Array.isArray(containers)) throw new Error();
  const workload = containers.find(
    (container) => isPlainObject(container) && container.name === "workload",
  );
  if (workload === undefined) throw new Error();
  if (verifier === "image_pull_backoff") {
    const expectedPaths = [
      "manifests/healthy-deployment.yaml",
      "manifests/deployment.yaml",
    ];
    const isHealthyRevision = relativePath === expectedPaths[0];
    if (
      definition.fixture_manifests.length !== expectedPaths.length ||
      definition.fixture_manifests.some(
        (item, index) => item !== expectedPaths[index],
      ) ||
      !expectedPaths.includes(relativePath) ||
      workload.image !== (isHealthyRevision ? AGNHOST_IMAGE : EXPECTED_IMAGE) ||
      workload.imagePullPolicy !== "IfNotPresent" ||
      !Array.isArray(workload.args) ||
      workload.args.length !== 1 ||
      workload.args[0] !== "pause"
    ) {
      throw new Error();
    }
    return manifest;
  }
  if (
    verifier === "readiness_probe_failure" ||
    verifier === "liveness_probe_failure"
  ) {
    validateProbeDeploymentManifest(
      definition,
      relativePath,
      workload,
      templateLabels,
      verifier,
      isHealthyControl,
      isSlowStartControl,
    );
    return manifest;
  }
  if (
    definition.fixture_manifests.length !== 2 ||
    !definition.fixture_manifests.includes("manifests/deployment.yaml") ||
    !definition.fixture_manifests.includes("manifests/healthy-control.yaml") ||
    workload.image !== AGNHOST_IMAGE ||
    workload.imagePullPolicy !== "IfNotPresent" ||
    !Array.isArray(workload.args) ||
    workload.args.length !== 1 ||
    workload.args[0] !==
      (isHealthyControl ? "pause" : "unsupported-k8s-incident-agent-command")
  ) {
    throw new Error();
  }
  return manifest;
}

function validateImagePullRevisionPair(definition, deploymentManifests) {
  if (definition.deterministic_verifier.kind !== "image_pull_backoff") return;
  const healthy = deploymentManifests.get("manifests/healthy-deployment.yaml");
  const fault = deploymentManifests.get("manifests/deployment.yaml");
  if (
    healthy === undefined ||
    fault === undefined ||
    !isDeepStrictEqual(
      withoutWorkloadImage(healthy),
      withoutWorkloadImage(fault),
    )
  ) {
    throw new Error();
  }
}

function withoutWorkloadImage(manifest) {
  const template = manifest.spec.template;
  const podSpec = template.spec;
  return {
    ...manifest,
    spec: {
      ...manifest.spec,
      template: {
        ...template,
        spec: {
          ...podSpec,
          containers: podSpec.containers.map((container) =>
            container.name === "workload"
              ? { ...container, image: "<workload-image>" }
              : container
          ),
        },
      },
    },
  };
}

function validateProbeDeploymentManifest(
  definition,
  relativePath,
  workload,
  templateLabels,
  verifier,
  isHealthyControl,
  isSlowStartControl,
) {
  const expectedManifests =
    verifier === "readiness_probe_failure"
      ? [
          "manifests/deployment.yaml",
          "manifests/healthy-control.yaml",
          "manifests/slow-start-control.yaml",
        ]
      : ["manifests/deployment.yaml", "manifests/healthy-control.yaml"];
  if (
    definition.fixture_manifests.length !== expectedManifests.length ||
    expectedManifests.some(
      (manifest) => !definition.fixture_manifests.includes(manifest),
    ) ||
    !expectedManifests.includes(relativePath) ||
    workload.image !== AGNHOST_IMAGE ||
    workload.imagePullPolicy !== "IfNotPresent" ||
    !Array.isArray(workload.args) ||
    workload.args.length !== 2 ||
    workload.args[0] !== "netexec" ||
    workload.args[1] !== "--http-port=8080" ||
    !Array.isArray(workload.ports) ||
    workload.ports.length !== 1 ||
    workload.ports[0]?.name !== "health" ||
    workload.ports[0]?.containerPort !== 8080 ||
    workload.ports[0]?.protocol !== "TCP"
  ) {
    throw new Error();
  }
  const monitoringLabel =
    verifier === "readiness_probe_failure"
      ? READINESS_CONTAINER_LABEL
      : LIVENESS_CONTAINER_LABEL;
  if (templateLabels[monitoringLabel] !== "workload") throw new Error();
  if (
    verifier === "readiness_probe_failure" &&
    templateLabels[READINESS_SLO_LABEL] !== (isSlowStartControl ? "5m" : "2m")
  ) {
    throw new Error();
  }
  validateTcpProbe(workload.startupProbe, {
    port: "health",
    initialDelaySeconds: isSlowStartControl
      ? 180
      : isHealthyControl
        ? 20
        : 1,
    periodSeconds: 2,
    timeoutSeconds: 1,
    failureThreshold: 30,
  });
  validateTcpProbe(workload.readinessProbe, {
    port:
      verifier === "readiness_probe_failure" &&
      !isHealthyControl &&
      !isSlowStartControl
        ? "missing-health"
        : "health",
    initialDelaySeconds: 1,
    periodSeconds: 2,
    timeoutSeconds: 1,
    failureThreshold: 3,
  });
  if (verifier === "readiness_probe_failure") {
    if (workload.livenessProbe !== undefined) throw new Error();
    return;
  }
  validateTcpProbe(workload.livenessProbe, {
    port: isHealthyControl ? 8080 : 8081,
    initialDelaySeconds: 1,
    periodSeconds: 2,
    timeoutSeconds: 1,
    failureThreshold: 3,
  });
}

function validateTcpProbe(probe, expected) {
  assertPlainObject(probe);
  assertPlainObject(probe.tcpSocket);
  if (
    probe.tcpSocket.port !== expected.port ||
    probe.initialDelaySeconds !== expected.initialDelaySeconds ||
    probe.periodSeconds !== expected.periodSeconds ||
    probe.timeoutSeconds !== expected.timeoutSeconds ||
    probe.failureThreshold !== expected.failureThreshold
  ) {
    throw new Error();
  }
}

function validateServiceSelectorManifest(manifestPath, relativePath, definition) {
  const requiredPaths = new Set([
    "manifests/deployment.yaml",
    "manifests/service.yaml",
    "manifests/healthy-control-deployment.yaml",
    "manifests/healthy-control-service.yaml",
  ]);
  if (
    definition.fixture_manifests.length !== requiredPaths.size ||
    definition.fixture_manifests.some((item) => !requiredPaths.has(item))
  ) {
    throw new Error();
  }
  const manifest = loadSingleManifest(manifestPath);
  assertPlainObject(manifest);
  assertPlainObject(manifest.metadata);
  if (manifest.metadata.namespace !== NAMESPACE) throw new Error();
  const healthy = relativePath.includes("healthy-control");
  const serviceName = healthy
    ? `${definition.target.name}-healthy-control`
    : definition.target.name;
  const appLabel = healthy
    ? "service-selector-healthy-control"
    : "service-selector-backend";

  if (relativePath.endsWith("service.yaml")) {
    if (
      manifest.apiVersion !== "v1" ||
      manifest.kind !== "Service" ||
      manifest.metadata.name !== serviceName ||
      manifest.metadata.labels?.[SERVICE_MONITORING_LABEL] !== "true"
    ) {
      throw new Error();
    }
    assertPlainObject(manifest.spec);
    if (manifest.spec.type !== "ClusterIP") throw new Error();
    const selector = validateLabelMap(manifest.spec.selector);
    const expectedApp = healthy ? appLabel : "service-selector-wrong";
    if (
      Object.keys(selector).length !== 1 ||
      selector.app !== expectedApp ||
      !Array.isArray(manifest.spec.ports) ||
      manifest.spec.ports.length !== 1
    ) {
      throw new Error();
    }
    return;
  }

  if (
    manifest.apiVersion !== "apps/v1" ||
    manifest.kind !== "Deployment" ||
    manifest.metadata.name !== `${serviceName}-backend`
  ) {
    throw new Error();
  }
  assertPlainObject(manifest.spec);
  assertPlainObject(manifest.spec.selector);
  const matchLabels = validateLabelMap(manifest.spec.selector.matchLabels);
  assertPlainObject(manifest.spec.template);
  assertPlainObject(manifest.spec.template.metadata);
  const templateLabels = validateLabelMap(manifest.spec.template.metadata.labels);
  if (
    Object.keys(matchLabels).length !== 1 ||
    matchLabels.app !== appLabel ||
    templateLabels.app !== appLabel ||
    templateLabels[SERVICE_ASSOCIATION_LABEL] !== serviceName
  ) {
    throw new Error();
  }
  const containers = manifest.spec.template.spec?.containers;
  if (
    !Array.isArray(containers) ||
    containers.length !== 1 ||
    containers[0]?.name !== "workload" ||
    containers[0]?.image !== AGNHOST_IMAGE ||
    containers[0]?.imagePullPolicy !== "IfNotPresent" ||
    !Array.isArray(containers[0]?.args) ||
    containers[0].args.length !== 1 ||
    containers[0].args[0] !== "pause"
  ) {
    throw new Error();
  }
}

function loadSingleManifest(manifestPath) {
  const source = readBoundedFile(manifestPath);
  const documents = [];
  loadAll(source, (document) => documents.push(document));
  if (documents.length !== 1) throw new Error();
  return documents[0];
}

function publicScenario(definition) {
  return {
    scenario_id: definition.scenario_id,
    scenario_version: definition.scenario_version,
    display_name: definition.display_name,
    description: definition.description,
    trigger: { ...definition.trigger },
    target: { ...definition.target },
  };
}

async function mutateFixture(action, entry, context, execute) {
  if (
    action === "apply" &&
    entry.definition.deterministic_verifier.kind === "image_pull_backoff"
  ) {
    await applyImagePullFixture(entry, context, execute);
    return;
  }
  const verb = action === "apply" ? "apply" : "delete";
  const args = [
    "--context",
    context,
    "--namespace",
    NAMESPACE,
    verb,
  ];
  const manifestPaths =
    action === "cleanup" &&
    entry.definition.deterministic_verifier.kind === "image_pull_backoff"
      ? [entry.manifestPaths.at(-1)]
      : entry.manifestPaths;
  for (const manifestPath of manifestPaths) {
    args.push("--filename", manifestPath);
  }
  if (action === "apply") {
    args.push("--validate=strict", "--request-timeout=30s");
  } else {
    args.push(
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=30s",
      "--request-timeout=30s",
    );
  }
  await executeKubectl(execute, args);
}

async function applyImagePullFixture(entry, context, execute) {
  const [healthyManifest, faultManifest] = entry.manifestPaths;
  await executeKubectl(execute, [
    "--context",
    context,
    "--namespace",
    NAMESPACE,
    "apply",
    "--filename",
    healthyManifest,
    "--validate=strict",
    "--request-timeout=30s",
  ]);
  await executeKubectl(
    execute,
    [
      "--context",
      context,
      "--namespace",
      NAMESPACE,
      "rollout",
      "status",
      `deployment.apps/${entry.definition.target.name}`,
      "--timeout=120s",
    ],
    HEALTHY_ROLLOUT_TIMEOUT_MILLISECONDS,
  );
  await executeKubectl(execute, [
    "--context",
    context,
    "--namespace",
    NAMESPACE,
    "apply",
    "--filename",
    faultManifest,
    "--validate=strict",
    "--request-timeout=30s",
  ]);
}

async function verifyScenario(entry, context, execute, clock) {
  const verifier = entry.definition.deterministic_verifier;
  const startedAt = normalizeTimestamp(clock.now());
  const deadline = startedAt + verifier.timeout_seconds * 1000;
  let lastReason = "deployment_not_found";
  const executeBeforeDeadline = async (args, pendingReason) => {
    const remainingMilliseconds = deadline - normalizeTimestamp(clock.now());
    if (remainingMilliseconds <= 0) {
      throw verificationFailure(lastReason);
    }
    lastReason = pendingReason;
    const timeoutMilliseconds = Math.min(
      COMMAND_TIMEOUT_MILLISECONDS,
      remainingMilliseconds,
    );
    try {
      const output = await executeKubectl(execute, args, timeoutMilliseconds);
      if (normalizeTimestamp(clock.now()) >= deadline) {
        throw verificationFailure(lastReason);
      }
      return output;
    } catch (error) {
      if (
        error instanceof ScenarioCommandError &&
        error.code === "request_timeout" &&
        timeoutMilliseconds < COMMAND_TIMEOUT_MILLISECONDS &&
        normalizeTimestamp(clock.now()) >= deadline
      ) {
        throw verificationFailure(lastReason);
      }
      throw error;
    }
  };

  while (true) {
    try {
      return await verifyOnce(entry.definition, context, executeBeforeDeadline);
    } catch (error) {
      if (!(error instanceof VerificationPending)) throw error;
      lastReason = error.reason;
    }

    const remainingMilliseconds = deadline - normalizeTimestamp(clock.now());
    if (remainingMilliseconds <= 0) {
      throw verificationFailure(lastReason);
    }
    await clock.sleep(Math.min(
      verifier.poll_interval_seconds * 1000,
      remainingMilliseconds,
    ));
  }
}

async function verifyOnce(definition, context, executeKubectlQuery) {
  if (definition.deterministic_verifier.kind === "crash_loop_backoff") {
    return verifyCrashLoopOnce(definition, context, executeKubectlQuery);
  }
  if (definition.deterministic_verifier.kind === "service_selector_mismatch") {
    return verifyServiceSelectorMismatchOnce(
      definition,
      context,
      executeKubectlQuery,
    );
  }
  if (
    definition.deterministic_verifier.kind === "readiness_probe_failure" ||
    definition.deterministic_verifier.kind === "liveness_probe_failure"
  ) {
    return verifyProbeFailureOnce(definition, context, executeKubectlQuery);
  }
  if (definition.deterministic_verifier.kind === "pvc_pending") {
    return verifyPvcPendingOnce(definition, context, executeKubectlQuery);
  }
  return verifyImagePullOnce(definition, context, executeKubectlQuery);
}

async function verifyPvcPendingOnce(
  definition,
  context,
  executeKubectlQuery,
) {
  const missingClass = definition.scenario_id === "pvc-storage-class-missing";
  const requestedClass = missingClass
    ? `${definition.scenario_id}-absent`
    : `${definition.scenario_id}-immediate`;
  const claim = await readPvc(
    definition.target.name,
    context,
    executeKubectlQuery,
    "pvc_not_found",
  );
  const claimMetadata = requireMetadata(claim, {
    namespace: NAMESPACE,
    name: definition.target.name,
  });
  requirePendingPvc(claim, requestedClass, true);

  let storageClassState;
  if (missingClass) {
    const rawStorageClass = await executeKubectlQuery(
      [
        "--context",
        context,
        "get",
        "storageclass",
        requestedClass,
        "--ignore-not-found=true",
        "--output=json",
        "--request-timeout=30s",
      ],
      "missing_storage_class_still_exists",
    );
    if (rawStorageClass.trim() !== "") {
      throw upstreamContractError();
    }
    storageClassState = "not_found";
  } else {
    const storageClass = await readStorageClass(
      requestedClass,
      context,
      executeKubectlQuery,
      "immediate_storage_class_not_found",
    );
    requireStorageClass(storageClass, requestedClass, "Immediate");
    storageClassState = "immediate_without_volume";
  }

  const events = await readScenarioEvents(context, executeKubectlQuery);
  const expectedReason = "ProvisioningFailed";
  const event = events.items.find((candidate) => {
    assertPlainUpstreamObject(candidate);
    const regarding = candidate.regarding;
    return (
      candidate.type === "Warning" &&
      candidate.reason === expectedReason &&
      candidate.reportingController === "persistentvolume-controller" &&
      typeof candidate.note === "string" &&
      (missingClass
        ? candidate.note.includes(requestedClass) &&
          /not found/i.test(candidate.note)
        : candidate.note.includes("kubernetes.io/no-provisioner") &&
          /no volume plugin matched name/i.test(candidate.note)) &&
      isPlainObject(regarding) &&
      regarding.apiVersion === "v1" &&
      regarding.kind === "PersistentVolumeClaim" &&
      regarding.namespace === NAMESPACE &&
      regarding.name === claimMetadata.name &&
      regarding.uid === claimMetadata.uid
    );
  });
  if (event === undefined) {
    throw new VerificationPending(
      missingClass
        ? "missing_storage_class_event_not_observed"
        : "failed_binding_event_not_observed",
    );
  }

  const controlName = `${definition.scenario_id}-wffc-control`;
  const controlClassName = `${definition.scenario_id}-wffc`;
  const controlClass = await readStorageClass(
    controlClassName,
    context,
    executeKubectlQuery,
    "wffc_storage_class_not_found",
  );
  requireStorageClass(
    controlClass,
    controlClassName,
    "WaitForFirstConsumer",
  );
  const control = await readPvc(
    controlName,
    context,
    executeKubectlQuery,
    "wffc_control_not_found",
  );
  requirePendingPvc(control, controlClassName, false);

  return {
    status: "verified",
    scenario_id: definition.scenario_id,
    persistent_volume_claim: {
      name: claimMetadata.name,
      phase: "Pending",
      requested_storage_class: requestedClass,
    },
    storage_class: storageClassState,
    event: {
      name: requireMetadata(event, { namespace: NAMESPACE }, false).name,
      reason: expectedReason,
    },
    wffc_control: "pending_but_not_selected",
  };
}

async function readPvc(
  name,
  context,
  executeKubectlQuery,
  pendingReason,
) {
  const raw = await executeKubectlQuery(
    [
      "--context",
      context,
      "--namespace",
      NAMESPACE,
      "get",
      "persistentvolumeclaim",
      name,
      "--ignore-not-found=true",
      "--output=json",
      "--request-timeout=30s",
    ],
    pendingReason,
  );
  if (raw.trim() === "") throw new VerificationPending(pendingReason);
  return parseKubectlObject(raw, "v1", "PersistentVolumeClaim");
}

async function readStorageClass(
  name,
  context,
  executeKubectlQuery,
  pendingReason,
) {
  const raw = await executeKubectlQuery(
    [
      "--context",
      context,
      "get",
      "storageclass",
      name,
      "--ignore-not-found=true",
      "--output=json",
      "--request-timeout=30s",
    ],
    pendingReason,
  );
  if (raw.trim() === "") throw new VerificationPending(pendingReason);
  return parseKubectlObject(raw, "storage.k8s.io/v1", "StorageClass");
}

function requirePendingPvc(claim, expectedClass, monitored) {
  const metadata = requireMetadata(claim, { namespace: NAMESPACE });
  if (
    claim.spec?.storageClassName !== expectedClass ||
    claim.status?.phase !== "Pending" ||
    metadata.labels?.[PVC_PENDING_POLICY_LABEL] !==
      (monitored ? "immediate" : undefined)
  ) {
    throw upstreamContractError();
  }
}

function requireStorageClass(storageClass, expectedName, expectedMode) {
  assertPlainUpstreamObject(storageClass);
  const metadata = storageClass.metadata;
  assertPlainUpstreamObject(metadata);
  assertNormalizedUpstreamString(metadata.name);
  if (
    metadata.name !== expectedName ||
    metadata.namespace !== undefined ||
    storageClass.provisioner !== "kubernetes.io/no-provisioner" ||
    storageClass.volumeBindingMode !== expectedMode
  ) {
    throw upstreamContractError();
  }
}

async function verifyProbeFailureOnce(
  definition,
  context,
  executeKubectlQuery,
) {
  const verifier = definition.deterministic_verifier.kind;
  const failing = await readOwnedDeploymentPods(
    definition.target,
    context,
    executeKubectlQuery,
  );
  requireProbeDeployment(failing.deployment, verifier, "failing");
  const events = await readScenarioEvents(context, executeKubectlQuery);
  const expectedEventPrefix =
    verifier === "readiness_probe_failure"
      ? "Readiness probe errored"
      : "Liveness probe failed";
  let observed;
  for (const pod of failing.ownedPods) {
    const metadata = requireMetadata(pod, { namespace: NAMESPACE });
    const statuses = pod.status?.containerStatuses;
    if (!Array.isArray(statuses)) continue;
    const status = statuses.find((item) => item?.name === "workload");
    if (!isPlainObject(status) || !Number.isInteger(status.restartCount)) continue;
    const readinessFailure =
      status.ready === false &&
      status.restartCount === 0 &&
      isPlainObject(status.state?.running) &&
      pod.status?.conditions?.some(
        (condition) =>
          condition?.type === "Ready" && condition?.status === "False",
      );
    const livenessFailure = status.restartCount > 0;
    if (
      (verifier === "readiness_probe_failure" && !readinessFailure) ||
      (verifier === "liveness_probe_failure" && !livenessFailure)
    ) {
      continue;
    }
    const event = findProbeFailureEvent(events, metadata, expectedEventPrefix);
    if (event !== undefined) {
      observed = { metadata, status, event };
      break;
    }
  }
  if (observed === undefined) {
    throw new VerificationPending(
      verifier === "readiness_probe_failure"
        ? "readiness_probe_failure_not_observed"
        : "liveness_probe_failure_not_observed",
    );
  }

  const healthyTarget = {
    ...definition.target,
    name: `${definition.target.name}-healthy-control`,
  };
  const healthy = await readOwnedDeploymentPods(
    healthyTarget,
    context,
    executeKubectlQuery,
  );
  requireProbeDeployment(healthy.deployment, verifier, "healthy");
  if (
    healthy.deployment.status?.availableReplicas !== 1 ||
    !healthy.ownedPods.some(hasHealthyWorkloadContainer)
  ) {
    throw new VerificationPending("probe_healthy_control_not_ready");
  }

  let slowStartControl;
  if (verifier === "readiness_probe_failure") {
    const slowTarget = {
      ...definition.target,
      name: `${definition.target.name}-slow-start-control`,
    };
    const slow = await readOwnedDeploymentPods(
      slowTarget,
      context,
      executeKubectlQuery,
    );
    requireProbeDeployment(slow.deployment, verifier, "slow");
    if (!slow.ownedPods.some(hasRunningUnfailedWorkloadContainer)) {
      throw new VerificationPending("probe_slow_start_control_not_running");
    }
    slowStartControl = "excluded_by_5m_slo";
  }

  return {
    status: "verified",
    scenario_id: definition.scenario_id,
    probe_kind:
      verifier === "readiness_probe_failure" ? "readiness" : "liveness",
    pod: {
      name: observed.metadata.name,
      ready: observed.status.ready,
      restart_count: observed.status.restartCount,
    },
    event: {
      name: requireMetadata(observed.event, { namespace: NAMESPACE }, false).name,
      reason: "Unhealthy",
    },
    healthy_control: "ready",
    ...(slowStartControl === undefined
      ? {}
      : { slow_start_control: slowStartControl }),
  };
}

function requireProbeDeployment(deployment, verifier, control) {
  const template = deployment.spec?.template;
  assertPlainUpstreamObject(template);
  const labels = validateUpstreamLabelMap(template.metadata?.labels);
  const containers = template.spec?.containers;
  if (!Array.isArray(containers)) throw upstreamContractError();
  const workload = containers.find((container) => container?.name === "workload");
  assertPlainUpstreamObject(workload);
  const monitoringLabel =
    verifier === "readiness_probe_failure"
      ? READINESS_CONTAINER_LABEL
      : LIVENESS_CONTAINER_LABEL;
  if (labels[monitoringLabel] !== "workload") throw upstreamContractError();
  if (
    verifier === "readiness_probe_failure" &&
    labels[READINESS_SLO_LABEL] !== (control === "slow" ? "5m" : "2m")
  ) {
    throw upstreamContractError();
  }
  if (
    !Array.isArray(workload.ports) ||
    workload.ports.length !== 1 ||
    workload.ports[0]?.name !== "health" ||
    workload.ports[0]?.containerPort !== 8080
  ) {
    throw upstreamContractError();
  }
  requireUpstreamTcpProbe(workload.startupProbe, {
    port: "health",
    initialDelaySeconds:
      control === "slow" ? 180 : control === "healthy" ? 20 : 1,
    failureThreshold: 30,
  });
  requireUpstreamTcpProbe(workload.readinessProbe, {
    port:
      verifier === "readiness_probe_failure" && control === "failing"
        ? "missing-health"
        : "health",
    initialDelaySeconds: 1,
    failureThreshold: 3,
  });
  if (verifier === "liveness_probe_failure") {
    requireUpstreamTcpProbe(workload.livenessProbe, {
      port: control === "healthy" ? 8080 : 8081,
      initialDelaySeconds: 1,
      failureThreshold: 3,
    });
  } else if (workload.livenessProbe !== undefined) {
    throw upstreamContractError();
  }
}

function requireUpstreamTcpProbe(probe, expected) {
  if (
    !isPlainObject(probe) ||
    !isPlainObject(probe.tcpSocket) ||
    probe.tcpSocket.port !== expected.port ||
    probe.initialDelaySeconds !== expected.initialDelaySeconds ||
    probe.periodSeconds !== 2 ||
    probe.timeoutSeconds !== 1 ||
    probe.failureThreshold !== expected.failureThreshold
  ) {
    throw upstreamContractError();
  }
}

function hasHealthyWorkloadContainer(pod) {
  const ready = pod.status?.conditions?.some(
    (condition) => condition?.type === "Ready" && condition?.status === "True",
  );
  const statuses = pod.status?.containerStatuses;
  if (!Array.isArray(statuses)) return false;
  return ready && statuses.some((status) => {
    assertPlainUpstreamObject(status);
    return (
      status.name === "workload" &&
      status.ready === true &&
      status.restartCount === 0 &&
      status.state?.running !== undefined
    );
  });
}

function hasRunningUnfailedWorkloadContainer(pod) {
  const statuses = pod.status?.containerStatuses;
  if (!Array.isArray(statuses)) return false;
  return statuses.some((status) => {
    assertPlainUpstreamObject(status);
    return (
      status.name === "workload" &&
      status.restartCount === 0 &&
      isPlainObject(status.state?.running)
    );
  });
}

async function verifyServiceSelectorMismatchOnce(
  definition,
  context,
  executeKubectlQuery,
) {
  const mismatch = await readServiceNetworkState(
    definition.target.name,
    context,
    executeKubectlQuery,
  );
  if (mismatch.candidatePods.length === 0) {
    throw new VerificationPending("service_candidate_pod_not_observed");
  }
  if (mismatch.selectorMatches !== 0) {
    throw new VerificationPending("service_selector_mismatch_not_observed");
  }
  if (mismatch.readyEndpoints !== 0) {
    throw new VerificationPending("mismatched_service_has_ready_endpoint");
  }

  const healthy = await readServiceNetworkState(
    `${definition.target.name}-healthy-control`,
    context,
    executeKubectlQuery,
  );
  if (
    healthy.candidatePods.length === 0 ||
    healthy.selectorMatches !== healthy.candidatePods.length ||
    healthy.readyEndpoints === 0
  ) {
    throw new VerificationPending("service_healthy_control_not_ready");
  }
  return {
    status: "verified",
    scenario_id: definition.scenario_id,
    service: {
      name: mismatch.service.metadata.name,
      candidate_pods: mismatch.candidatePods.length,
      selector_matches: mismatch.selectorMatches,
      ready_endpoints: mismatch.readyEndpoints,
    },
    healthy_control: {
      name: healthy.service.metadata.name,
      ready_endpoints: healthy.readyEndpoints,
    },
  };
}

async function readServiceNetworkState(serviceName, context, executeKubectlQuery) {
  const serviceRaw = await executeKubectlQuery(
    [
      "--context",
      context,
      "--namespace",
      NAMESPACE,
      "get",
      "service",
      serviceName,
      "--ignore-not-found=true",
      "--output=json",
      "--request-timeout=30s",
    ],
    "service_not_found",
  );
  if (serviceRaw.trim() === "") {
    throw new VerificationPending("service_not_found");
  }
  const service = parseKubectlObject(serviceRaw, "v1", "Service");
  const serviceMetadata = requireMetadata(service, {
    namespace: NAMESPACE,
    name: serviceName,
  });
  if (
    serviceMetadata.labels?.[SERVICE_MONITORING_LABEL] !== "true" ||
    service.spec?.type !== "ClusterIP" ||
    service.spec?.clusterIP === "None" ||
    service.spec?.publishNotReadyAddresses === true
  ) {
    throw upstreamContractError();
  }
  const selector = validateUpstreamLabelMap(service.spec?.selector);
  const pods = parseKubectlList(
    await executeKubectlQuery(
      [
        "--context",
        context,
        "--namespace",
        NAMESPACE,
        "get",
        "pods",
        "--selector",
        `${SERVICE_ASSOCIATION_LABEL}=${serviceName}`,
        "--output=json",
        "--request-timeout=30s",
      ],
      "service_candidate_pod_not_observed",
    ),
    "v1",
    "Pod",
  );
  const candidatePods = pods.items.filter((pod) => {
    const metadata = requireMetadata(pod, { namespace: NAMESPACE });
    return metadata.labels?.[SERVICE_ASSOCIATION_LABEL] === serviceName;
  });
  const selectorMatches = candidatePods.filter((pod) => {
    const metadata = requireMetadata(pod, { namespace: NAMESPACE });
    return Object.entries(selector).every(
      ([key, value]) => metadata.labels?.[key] === value,
    );
  }).length;

  const slices = parseKubectlList(
    await executeKubectlQuery(
      [
        "--context",
        context,
        "--namespace",
        NAMESPACE,
        "get",
        "endpointslices.discovery.k8s.io",
        "--selector",
        `${ENDPOINT_SLICE_SERVICE_LABEL}=${serviceName}`,
        "--output=json",
        "--request-timeout=30s",
      ],
      "service_endpoint_slice_not_observed",
    ),
    "discovery.k8s.io/v1",
    "EndpointSlice",
  );
  let readyEndpoints = 0;
  for (const slice of slices.items) {
    const metadata = requireMetadata(slice, { namespace: NAMESPACE });
    const endpoints = slice.endpoints ?? [];
    if (
      metadata.labels?.[ENDPOINT_SLICE_SERVICE_LABEL] !== serviceName ||
      !hasControllerOwner(metadata, {
        apiVersion: "v1",
        kind: "Service",
        name: serviceName,
        uid: serviceMetadata.uid,
      }) ||
      !Array.isArray(endpoints)
    ) {
      throw upstreamContractError();
    }
    readyEndpoints += endpoints.filter(
      (endpoint) => endpoint?.conditions?.ready === true,
    ).length;
  }
  return {
    service,
    candidatePods,
    selectorMatches,
    readyEndpoints,
  };
}

async function verifyImagePullOnce(definition, context, executeKubectlQuery) {
  const { ownedPods } = await readOwnedDeploymentPods(
    definition.target,
    context,
    executeKubectlQuery,
  );

  const waitingPods = [];
  for (const pod of ownedPods) {
    const statuses = pod.status?.containerStatuses;
    if (statuses === undefined) continue;
    if (!Array.isArray(statuses)) throw upstreamContractError();
    for (const status of statuses) {
      assertPlainUpstreamObject(status);
      const reason = status.state?.waiting?.reason;
      if (WAITING_REASONS.has(reason)) {
        waitingPods.push({ pod, reason });
        break;
      }
    }
  }
  if (waitingPods.length === 0) {
    throw new VerificationPending("image_pull_waiting_state_not_observed");
  }

  const events = await readScenarioEvents(context, executeKubectlQuery);
  for (const candidate of waitingPods) {
    const podMetadata = requireMetadata(candidate.pod, { namespace: NAMESPACE });
    const event = findWarningEvent(events, podMetadata);
    if (event !== undefined) {
      const eventMetadata = requireMetadata(
        event,
        { namespace: NAMESPACE },
        false,
      );
      assertNormalizedUpstreamString(event.reason);
      return {
        status: "verified",
        scenario_id: definition.scenario_id,
        pod: {
          name: podMetadata.name,
          waiting_reason: candidate.reason,
        },
        event: {
          name: eventMetadata.name,
          reason: event.reason,
        },
      };
    }
  }
  throw new VerificationPending("warning_event_not_observed");
}

async function verifyCrashLoopOnce(definition, context, executeKubectlQuery) {
  const { ownedPods } = await readOwnedDeploymentPods(
    definition.target,
    context,
    executeKubectlQuery,
  );
  const candidates = [];
  for (const pod of ownedPods) {
    const statuses = pod.status?.containerStatuses;
    if (statuses === undefined) continue;
    if (!Array.isArray(statuses)) throw upstreamContractError();
    for (const status of statuses) {
      assertPlainUpstreamObject(status);
      if (
        status.name === "workload" &&
        status.state?.waiting?.reason === "CrashLoopBackOff" &&
        Number.isInteger(status.restartCount) &&
        status.restartCount > 0 &&
        Number.isInteger(status.lastState?.terminated?.exitCode) &&
        status.lastState.terminated.exitCode !== 0
      ) {
        candidates.push({ pod, restartCount: status.restartCount });
      }
    }
  }
  if (candidates.length === 0) {
    throw new VerificationPending("crash_loop_waiting_state_not_observed");
  }

  const events = await readScenarioEvents(context, executeKubectlQuery);
  for (const candidate of candidates) {
    const podMetadata = requireMetadata(candidate.pod, { namespace: NAMESPACE });
    const event = findWarningEvent(events, podMetadata);
    if (event?.reason !== "BackOff") continue;
    const logs = await executeKubectlQuery(
      [
        "--context",
        context,
        "--namespace",
        NAMESPACE,
        "logs",
        podMetadata.name,
        "--container=workload",
        "--previous=true",
        "--timestamps=true",
        "--tail=80",
        "--limit-bytes=4096",
        "--request-timeout=30s",
      ],
      "previous_container_log_not_observed",
    );
    const logLines = logs.split(/\r?\n/u).filter((line) => line !== "");
    if (
      Buffer.byteLength(logs, "utf8") > 4096 ||
      logLines.length === 0 ||
      logLines.some(
        (line) =>
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) /u.test(
            line,
          ),
      ) ||
      !logs.includes("unsupported-k8s-incident-agent-command")
    ) {
      throw new VerificationPending("invalid_startup_argument_log_not_observed");
    }

    await verifyCrashLoopHealthyControl(
      definition,
      context,
      executeKubectlQuery,
    );
    return {
      status: "verified",
      scenario_id: definition.scenario_id,
      pod: {
        name: podMetadata.name,
        waiting_reason: "CrashLoopBackOff",
        restart_count: candidate.restartCount,
      },
      event: {
        name: requireMetadata(event, { namespace: NAMESPACE }, false).name,
        reason: event.reason,
      },
      previous_log: "bounded",
      healthy_control: "ready",
    };
  }
  throw new VerificationPending("crash_loop_backoff_event_not_observed");
}

async function verifyCrashLoopHealthyControl(
  definition,
  context,
  executeKubectlQuery,
) {
  const target = {
    ...definition.target,
    name: `${definition.target.name}-healthy-control`,
  };
  const { deployment, ownedPods } = await readOwnedDeploymentPods(
    target,
    context,
    executeKubectlQuery,
  );
  if (deployment.status?.availableReplicas !== 1) {
    throw new VerificationPending("healthy_control_not_available");
  }
  const healthy = ownedPods.some((pod) => {
    const ready = pod.status?.conditions?.some(
      (condition) => condition?.type === "Ready" && condition?.status === "True",
    );
    const statuses = pod.status?.containerStatuses;
    if (!Array.isArray(statuses)) return false;
    return ready && statuses.some((status) => {
      assertPlainUpstreamObject(status);
      return (
        status.name === "workload" &&
        status.ready === true &&
        status.restartCount === 0 &&
        status.state?.running !== undefined
      );
    });
  });
  if (!healthy) throw new VerificationPending("healthy_control_not_ready");
}

async function readOwnedDeploymentPods(target, context, executeKubectlQuery) {
  const deploymentRaw = await executeKubectlQuery(
    [
      "--context",
      context,
      "--namespace",
      NAMESPACE,
      "get",
      "deployment.apps",
      target.name,
      "--ignore-not-found=true",
      "--output=json",
      "--request-timeout=30s",
    ],
    "deployment_not_found",
  );
  if (deploymentRaw.trim() === "") {
    throw new VerificationPending("deployment_not_found");
  }
  const deployment = parseKubectlObject(deploymentRaw, "apps/v1", "Deployment");
  const deploymentMetadata = requireMetadata(deployment, target);
  const selector = deployment.spec?.selector;
  assertPlainUpstreamObject(selector);
  if (selector.matchExpressions !== undefined) throw upstreamContractError();
  const matchLabels = validateUpstreamLabelMap(selector.matchLabels);
  const selectorArgument = Object.entries(matchLabels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

  const replicaSets = parseKubectlList(
    await executeKubectlQuery(
      [
        "--context",
        context,
        "--namespace",
        NAMESPACE,
        "get",
        "replicasets.apps",
        "--selector",
        selectorArgument,
        "--output=json",
        "--request-timeout=30s",
      ],
      "owner_linked_replicaset_not_found",
    ),
    "apps/v1",
    "ReplicaSet",
  );
  const ownedReplicaSets = replicaSets.items.filter((replicaSet) => {
    const metadata = requireMetadata(replicaSet, { namespace: NAMESPACE });
    return hasControllerOwner(metadata, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: target.name,
      uid: deploymentMetadata.uid,
    });
  });
  if (ownedReplicaSets.length === 0) {
    throw new VerificationPending("owner_linked_replicaset_not_found");
  }
  const replicaSetUids = new Set(
    ownedReplicaSets.map((replicaSet) => replicaSet.metadata.uid),
  );

  const pods = parseKubectlList(
    await executeKubectlQuery(
      [
        "--context",
        context,
        "--namespace",
        NAMESPACE,
        "get",
        "pods",
        "--selector",
        selectorArgument,
        "--output=json",
        "--request-timeout=30s",
      ],
      "owner_linked_pod_not_found",
    ),
    "v1",
    "Pod",
  );
  const ownedPods = pods.items.filter((pod) => {
    const metadata = requireMetadata(pod, { namespace: NAMESPACE });
    return hasAnyReplicaSetOwner(metadata, replicaSetUids);
  });
  if (ownedPods.length === 0) {
    throw new VerificationPending("owner_linked_pod_not_found");
  }
  return { deployment, ownedPods };
}

async function readScenarioEvents(context, executeKubectlQuery) {
  return parseKubectlList(
    await executeKubectlQuery(
      [
        "--context",
        context,
        "--namespace",
        NAMESPACE,
        "get",
        "events.events.k8s.io",
        "--output=json",
        "--request-timeout=30s",
      ],
      "warning_event_not_observed",
    ),
    "events.k8s.io/v1",
    "Event",
  );
}

function findWarningEvent(events, podMetadata) {
  return events.items.find((item) => {
    assertPlainUpstreamObject(item);
    if (item.type !== "Warning") return false;
    const regarding = item.regarding;
    return (
      isPlainObject(regarding) &&
      regarding.apiVersion === "v1" &&
      regarding.kind === "Pod" &&
      regarding.name === podMetadata.name &&
      regarding.namespace === NAMESPACE &&
      regarding.uid === podMetadata.uid
    );
  });
}

function findProbeFailureEvent(events, podMetadata, expectedPrefix) {
  return events.items.find((item) => {
    assertPlainUpstreamObject(item);
    if (
      item.type !== "Warning" ||
      item.reason !== "Unhealthy" ||
      item.reportingController !== "kubelet" ||
      typeof item.note !== "string" ||
      !item.note.includes(expectedPrefix)
    ) {
      return false;
    }
    const regarding = item.regarding;
    return (
      isPlainObject(regarding) &&
      regarding.apiVersion === "v1" &&
      regarding.kind === "Pod" &&
      regarding.name === podMetadata.name &&
      regarding.namespace === NAMESPACE &&
      regarding.uid === podMetadata.uid
    );
  });
}

function parseKubectlObject(rawJson, apiVersion, kind) {
  const document = parseUpstreamJson(rawJson);
  assertPlainUpstreamObject(document);
  if (document.apiVersion !== apiVersion || document.kind !== kind) {
    throw upstreamContractError();
  }
  return document;
}

function parseKubectlList(
  rawJson,
  itemApiVersion,
  itemKind,
) {
  const document = parseKubectlObject(rawJson, "v1", "List");
  if (!Array.isArray(document.items)) throw upstreamContractError();
  for (const item of document.items) {
    assertPlainUpstreamObject(item);
    if (item.apiVersion !== itemApiVersion || item.kind !== itemKind) {
      throw upstreamContractError();
    }
  }
  return document;
}

function requireMetadata(resource, expected, requireUid = true) {
  assertPlainUpstreamObject(resource);
  const metadata = resource.metadata;
  assertPlainUpstreamObject(metadata);
  assertNormalizedUpstreamString(metadata.name);
  assertNormalizedUpstreamString(metadata.namespace);
  if (requireUid) assertNormalizedUpstreamString(metadata.uid);
  if (
    (expected.name !== undefined && metadata.name !== expected.name) ||
    (expected.namespace !== undefined && metadata.namespace !== expected.namespace)
  ) {
    throw upstreamContractError();
  }
  return metadata;
}

function hasControllerOwner(metadata, expected) {
  const ownerReferences = metadata.ownerReferences;
  if (ownerReferences === undefined) return false;
  if (!Array.isArray(ownerReferences)) throw upstreamContractError();
  return ownerReferences.some((owner) => {
    assertPlainUpstreamObject(owner);
    return (
      owner.controller === true &&
      owner.apiVersion === expected.apiVersion &&
      owner.kind === expected.kind &&
      owner.name === expected.name &&
      owner.uid === expected.uid
    );
  });
}

function hasAnyReplicaSetOwner(metadata, replicaSetUids) {
  const ownerReferences = metadata.ownerReferences;
  if (ownerReferences === undefined) return false;
  if (!Array.isArray(ownerReferences)) throw upstreamContractError();
  return ownerReferences.some((owner) => {
    assertPlainUpstreamObject(owner);
    return (
      owner.controller === true &&
      owner.apiVersion === "apps/v1" &&
      owner.kind === "ReplicaSet" &&
      replicaSetUids.has(owner.uid)
    );
  });
}

async function executeKubectl(
  execute,
  args,
  timeoutMilliseconds = COMMAND_TIMEOUT_MILLISECONDS,
) {
  try {
    const output = await execute("kubectl", args, {
      timeoutMilliseconds,
      maxBufferBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    });
    if (typeof output !== "string") throw upstreamContractError();
    return output;
  } catch (error) {
    if (error instanceof ScenarioCommandError) throw error;
    if (error?.timedOut === true || error?.code === "ETIMEDOUT") {
      throw new ScenarioCommandError(
        "request_timeout",
        "Kubernetes API request exceeded its bounded timeout",
      );
    }
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (/\bForbidden\b/i.test(stderr)) {
      throw new ScenarioCommandError(
        "permission_denied",
        "Kubernetes API denied the fixed scenario request",
      );
    }
    throw new ScenarioCommandError(
      "upstream_unavailable",
      "Kubernetes API request failed",
    );
  }
}

function verificationFailure(reason) {
  return new ScenarioCommandError(
    "verification_failed",
    `Scenario did not reach its deterministic evidence condition: ${reason}`,
  );
}

function executeExternalCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(args)) {
      reject(new Error("invalid command contract"));
      return;
    }
    execFile(
      command,
      args,
      {
        shell: false,
        encoding: "utf8",
        timeout: options.timeoutMilliseconds,
        maxBuffer: options.maxBufferBytes,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            Object.assign(new Error("external command failed"), {
              code: error.code,
              exitCode: Number.isInteger(error.code) ? error.code : undefined,
              stdout: typeof stdout === "string" ? stdout : "",
              timedOut: error.killed === true && error.signal !== null,
              stderr: typeof stderr === "string" ? stderr : "",
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseJsonFile(filePath) {
  const source = readBoundedFile(filePath);
  return JSON.parse(source);
}

function readBoundedFile(filePath) {
  const entry = lstatSync(filePath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_FILE_BYTES) {
    throw new Error();
  }
  return readFileSync(filePath, "utf8");
}

function assertRealDirectory(directoryPath) {
  const entry = lstatSync(directoryPath);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error();
}

function assertRegularFileWithoutSymlinkComponents(root, filePath) {
  const relative = path.relative(root, filePath);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) throw new Error();
    if (current === filePath ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error();
    }
  }
}

function assertContainedPath(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error();
  }
}

function assertExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error();
  }
}

function assertNonEmptyUniqueStringArray(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error();
  const seen = new Set();
  for (const item of value) {
    assertNormalizedString(item);
    if (seen.has(item)) throw new Error();
    seen.add(item);
  }
}

function validateLabelMap(value) {
  assertPlainObject(value);
  if (Object.keys(value).length === 0) throw new Error();
  for (const [key, labelValue] of Object.entries(value)) {
    assertNormalizedString(key);
    assertNormalizedString(labelValue);
  }
  return value;
}

function validateUpstreamLabelMap(value) {
  try {
    return validateLabelMap(value);
  } catch {
    throw upstreamContractError();
  }
}

function assertNormalizedString(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error();
  }
}

function assertNormalizedUpstreamString(value) {
  try {
    assertNormalizedString(value);
  } catch {
    throw upstreamContractError();
  }
}

function assertPlainObject(value) {
  if (!isPlainObject(value)) throw new Error();
}

function assertPlainUpstreamObject(value) {
  if (!isPlainObject(value)) throw upstreamContractError();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseUpstreamJson(rawJson) {
  if (
    typeof rawJson !== "string" ||
    Buffer.byteLength(rawJson, "utf8") > COMMAND_OUTPUT_LIMIT_BYTES
  ) {
    throw upstreamContractError();
  }
  try {
    return JSON.parse(rawJson);
  } catch {
    throw upstreamContractError();
  }
}

function upstreamContractError() {
  return new ScenarioCommandError(
    "upstream_contract_invalid",
    "Kubernetes API returned data outside the supported contract",
  );
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp)) {
    throw new ScenarioCommandError(
      "clock_invalid",
      "Verification clock returned an invalid timestamp",
    );
  }
  return timestamp;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertAction(action) {
  if (!VALID_ACTIONS.has(action)) {
    throw new ScenarioCommandError(
      "invalid_arguments",
      "Expected one scenario action: list, apply, verify, or cleanup",
    );
  }
}

function invalidArguments(message) {
  return new ScenarioCommandError("invalid_arguments", message);
}

function normalizeRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "") {
    throw new ScenarioCommandError(
      "scenario_contract_invalid",
      "Repository root must be a path",
    );
  }
  return path.resolve(repositoryRoot);
}

function repositoryRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  try {
    const request = parseCliRequest(process.argv.slice(2));
    const result = await runScenarioCommand(
      request.action,
      request.scenarioId,
      request.dependencies,
    );
    console.info(JSON.stringify(result, null, 2));
  } catch (error) {
    const knownError = error instanceof ScenarioCommandError;
    const code = knownError ? error.code : "scenario_command_failed";
    const message = knownError ? error.message : "Scenario command failed";
    console.error(`FAIL ${code} ${message}`);
    process.exitCode = 1;
  }
}

function parseCliRequest(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw invalidArguments(
      "Expected list or one scenario action with a scenario identifier",
    );
  }
  const [action, scenarioId, ...optionValues] = argv;
  if (action === "list") {
    if (scenarioId !== undefined) {
      throw invalidArguments("The list action does not accept arguments");
    }
    return { action, scenarioId: undefined, dependencies: {} };
  }
  if (scenarioId === undefined || optionValues.length % 2 !== 0) {
    throw invalidArguments(
      "Scenario actions require an identifier and complete profile options",
    );
  }
  const dependencies = {};
  for (let index = 0; index < optionValues.length; index += 2) {
    const option = optionValues[index];
    const value = optionValues[index + 1];
    if (option === "--profile" && dependencies.profile === undefined) {
      dependencies.profile = value;
      continue;
    }
    if (option === "--context" && dependencies.context === undefined) {
      dependencies.context = value;
      continue;
    }
    throw invalidArguments("Scenario profile options are invalid or repeated");
  }
  return { action, scenarioId, dependencies };
}
