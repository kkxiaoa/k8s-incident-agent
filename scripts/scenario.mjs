import { execFile } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAll } from "js-yaml";

import {
  DeploymentContractError,
  verifyDeploymentStatus,
} from "./deployment.mjs";
import { runClusterCommand } from "./kind-cluster.mjs";

const CLUSTER_NAME = "k8s-incident-agent";
const CONTEXT_NAME = "kind-k8s-incident-agent";
const NAMESPACE = "k8s-incident-scenarios";
const SCENARIO_SCHEMA_VERSION = 1;
const SCENARIO_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const EXPECTED_IMAGE = "registry.invalid/k8s-incident-agent/missing:v1";
const WAITING_REASONS = new Set(["ErrImagePull", "ImagePullBackOff"]);
const VALID_ACTIONS = new Set(["list", "apply", "verify", "cleanup"]);
const VALID_EXECUTION_PROFILES = new Set([
  "kind-evaluation",
  "k3s-evaluation",
]);
const NOOP_LOGGER = { info() {}, error() {} };

class ScenarioCommandError extends Error {
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
    validateDeploymentManifest(manifestPath, definition);
    return manifestPath;
  });

  return { definition, manifestPaths };
}

function validateScenarioDefinition(definition, directoryName) {
  assertPlainObject(definition);
  assertExactKeys(definition, [
    "schema_version",
    "scenario_id",
    "scenario_version",
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
  if (definition.scenario_version !== SCENARIO_VERSION) throw new Error();
  assertNormalizedString(definition.scenario_id);
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(definition.scenario_id)) {
    throw new Error();
  }
  if (definition.scenario_id !== directoryName) throw new Error();
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
  if (
    definition.target.cluster !== CLUSTER_NAME ||
    definition.target.namespace !== NAMESPACE ||
    definition.target.api_version !== "apps/v1" ||
    definition.target.kind !== "Deployment" ||
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
  const forbidden = new Set(definition.forbidden_tools);
  if (definition.allowed_tools.some((tool) => forbidden.has(tool))) {
    throw new Error();
  }

  assertPlainObject(definition.deterministic_verifier);
  assertExactKeys(definition.deterministic_verifier, [
    "kind",
    "timeout_seconds",
    "poll_interval_seconds",
  ]);
  if (
    definition.deterministic_verifier.kind !== "image_pull_backoff" ||
    definition.deterministic_verifier.timeout_seconds !== 120 ||
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

function validateDeploymentManifest(manifestPath, definition) {
  const source = readBoundedFile(manifestPath);
  const documents = [];
  loadAll(source, (document) => documents.push(document));
  if (documents.length !== 1) throw new Error();
  const manifest = documents[0];
  assertPlainObject(manifest);
  if (
    manifest.apiVersion !== definition.target.api_version ||
    manifest.kind !== definition.target.kind
  ) {
    throw new Error();
  }
  assertPlainObject(manifest.metadata);
  if (
    manifest.metadata.name !== definition.target.name ||
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
  if (
    workload === undefined ||
    workload.image !== EXPECTED_IMAGE ||
    workload.imagePullPolicy !== "Always"
  ) {
    throw new Error();
  }
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
  const verb = action === "apply" ? "apply" : "delete";
  const args = [
    "--context",
    context,
    "--namespace",
    NAMESPACE,
    verb,
  ];
  for (const manifestPath of entry.manifestPaths) {
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
  const deploymentRaw = await executeKubectlQuery(
    [
      "--context",
      context,
      "--namespace",
      NAMESPACE,
      "get",
      "deployment.apps",
      definition.target.name,
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
  const deploymentMetadata = requireMetadata(deployment, definition.target);
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
      name: definition.target.name,
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

  const events = parseKubectlList(
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
  for (const candidate of waitingPods) {
    const podMetadata = requireMetadata(candidate.pod, { namespace: NAMESPACE });
    const event = events.items.find((item) => {
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
