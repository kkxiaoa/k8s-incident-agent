import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { lstatSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadKindVersionContract,
  parseKubectlClientVersion,
  parseSemanticVersion,
} from "./doctor.mjs";

const CLUSTER_NAME = "k8s-incident-agent";
const CONTEXT_NAME = "kind-k8s-incident-agent";
const SCENARIO_NAMESPACE = "k8s-incident-scenarios";
const SERVICE_ACCOUNT_NAME = "diagnostic-agent";
const KUBECONFIG_FILENAME = "diagnostic.kubeconfig";
const TOKEN_REQUEST_EXPIRATION_SECONDS = 28_800;
const TOKEN_EXPIRATION_TOLERANCE_MILLISECONDS = 60_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const READ_COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const MUTATING_COMMAND_TIMEOUT_MILLISECONDS = 5 * 60_000;
const VALID_ACTIONS = new Set([
  "up",
  "status",
  "bootstrap-access",
  "down",
]);

class NormalizedClusterProjection {
  constructor(server, certificateAuthorityData) {
    this.server = server;
    this.certificateAuthorityData = certificateAuthorityData;
  }
}

class KindClusterContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "KindClusterContractError";
  }
}

export async function loadKindContract(repositoryRoot) {
  const normalizedRoot = normalizeRepositoryRoot(repositoryRoot);
  const versions = await loadKindVersionContract(normalizedRoot);
  const kindConfigPath = path.join(
    normalizedRoot,
    "deploy",
    "kind",
    "config.yaml",
  );
  const rbacManifestPath = path.join(
    normalizedRoot,
    "deploy",
    "kind",
    "rbac",
    "diagnostic.yaml",
  );

  return {
    clusterName: CLUSTER_NAME,
    contextName: CONTEXT_NAME,
    scenarioNamespace: SCENARIO_NAMESPACE,
    serviceAccountName: SERVICE_ACCOUNT_NAME,
    kindVersion: versions.kind,
    kubernetesVersion: versions.kubernetes,
    kubectlVersion: versions.kubectl,
    nodeImage: versions.nodeImage,
    kindConfigPath,
    rbacManifestPath,
  };
}

export function resolveRuntimePaths(repositoryRoot, environment) {
  const normalizedRoot = normalizeRepositoryRoot(repositoryRoot);
  const configuredValue = environment?.RUNTIME_DATA_DIR;
  if (
    configuredValue !== undefined &&
    (typeof configuredValue !== "string" || configuredValue.trim() === "")
  ) {
    throw new KindClusterContractError(
      "RUNTIME_DATA_DIR must be a non-empty path when configured",
    );
  }

  const runtimeDataDirectory = path.resolve(
    normalizedRoot,
    configuredValue === undefined ? ".runtime" : configuredValue,
  );
  const relativeDirectory = path.relative(
    normalizedRoot,
    runtimeDataDirectory,
  );
  if (
    relativeDirectory === "" ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    throw new KindClusterContractError(
      "RUNTIME_DATA_DIR must be a dedicated directory inside the repository, not a broad or external path",
    );
  }
  const ignoredRuntimeRoot = path.join(normalizedRoot, ".runtime");
  if (!isPathAtOrBelow(ignoredRuntimeRoot, runtimeDataDirectory)) {
    throw new KindClusterContractError(
      "RUNTIME_DATA_DIR must be the Git-ignored .runtime directory or one of its descendants",
    );
  }

  assertPathHasNoSymbolicLinks(
    normalizedRoot,
    runtimeDataDirectory,
    "RUNTIME_DATA_DIR",
  );
  const diagnosticKubeconfig = path.join(
    runtimeDataDirectory,
    KUBECONFIG_FILENAME,
  );
  assertPathHasNoSymbolicLinks(
    normalizedRoot,
    diagnosticKubeconfig,
    "diagnostic kubeconfig",
  );

  return {
    runtimeDataDirectory,
    diagnosticKubeconfig,
  };
}

export function buildClusterCommand(action, contract) {
  assertAction(action);
  assertFixedContract(contract);

  if (action === "up") {
    return commandSpec(
      "kind",
      [
        "create",
        "cluster",
        "--name",
        contract.clusterName,
        "--config",
        contract.kindConfigPath,
        "--image",
        contract.nodeImage,
      ],
      MUTATING_COMMAND_TIMEOUT_MILLISECONDS,
    );
  }
  if (action === "status") {
    return commandSpec(
      "kind",
      ["get", "clusters"],
      READ_COMMAND_TIMEOUT_MILLISECONDS,
    );
  }
  if (action === "bootstrap-access") {
    return commandSpec(
      "kubectl",
      [
        "--context",
        contract.contextName,
        "apply",
        "--filename",
        contract.rbacManifestPath,
      ],
      MUTATING_COMMAND_TIMEOUT_MILLISECONDS,
    );
  }
  return commandSpec(
    "kind",
    ["delete", "cluster", "--name", contract.clusterName],
    MUTATING_COMMAND_TIMEOUT_MILLISECONDS,
  );
}

export function parseTokenRequest(rawJson, now) {
  const document = parseJsonObject(rawJson, "TokenRequest response");
  if (
    document.apiVersion !== "authentication.k8s.io/v1" ||
    document.kind !== "TokenRequest"
  ) {
    throw new KindClusterContractError(
      "TokenRequest response has an unexpected apiVersion or kind",
    );
  }

  const token = document.status?.token;
  if (typeof token !== "string") {
    throw new KindClusterContractError(
      "TokenRequest response is missing status.token",
    );
  }

  const expirationTimestamp = document.status?.expirationTimestamp;
  if (
    typeof expirationTimestamp !== "string" ||
    expirationTimestamp.trim() === ""
  ) {
    throw new KindClusterContractError(
      "TokenRequest response is missing status.expirationTimestamp",
    );
  }
  const expirationMilliseconds = Date.parse(expirationTimestamp);
  if (!Number.isFinite(expirationMilliseconds)) {
    throw new KindClusterContractError(
      "TokenRequest status.expirationTimestamp is invalid",
    );
  }

  const nowDate = normalizeDate(now, "current time");
  const nowMilliseconds = nowDate.getTime();
  if (expirationMilliseconds <= nowMilliseconds) {
    throw new KindClusterContractError(
      "TokenRequest status.expirationTimestamp is not in the future",
    );
  }

  const jwtExpirationSeconds = parseJwtExpiration(token);
  const jwtExpirationMilliseconds = jwtExpirationSeconds * 1000;
  if (jwtExpirationMilliseconds <= nowMilliseconds) {
    throw new KindClusterContractError(
      "TokenRequest JWT is already expired",
    );
  }
  if (
    Math.abs(jwtExpirationMilliseconds - expirationMilliseconds) >
    TOKEN_EXPIRATION_TOLERANCE_MILLISECONDS
  ) {
    throw new KindClusterContractError(
      "JWT exp and TokenRequest expirationTimestamp differ by more than 60 seconds",
    );
  }

  return { token };
}

export function buildDiagnosticKubeconfig(clusterProjection, token) {
  return serializeDiagnosticKubeconfig(
    normalizeClusterProjection(clusterProjection),
    token,
  );
}

function normalizeClusterProjection(clusterProjection) {
  if (clusterProjection instanceof NormalizedClusterProjection) {
    return clusterProjection;
  }
  if (
    clusterProjection === null ||
    typeof clusterProjection !== "object" ||
    Array.isArray(clusterProjection)
  ) {
    throw new KindClusterContractError(
      "Cluster projection must be an object",
    );
  }
  const server = validateLoopbackServer(clusterProjection.server);
  const certificateAuthorityData =
    clusterProjection.certificateAuthorityData;
  if (
    typeof certificateAuthorityData !== "string" ||
    certificateAuthorityData.trim() === "" ||
    /[\u0000-\u001f\u007f]/.test(certificateAuthorityData)
  ) {
    throw new KindClusterContractError(
      "Cluster projection is missing certificate authority data",
    );
  }

  return new NormalizedClusterProjection(server, certificateAuthorityData);
}

function serializeDiagnosticKubeconfig(clusterProjection, token) {
  const { server, certificateAuthorityData } = clusterProjection;
  if (
    typeof token !== "string" ||
    token.trim() === "" ||
    /[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new KindClusterContractError("Diagnostic token has an invalid shape");
  }

  return `${JSON.stringify(
    {
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: CLUSTER_NAME,
          cluster: {
            server,
            "certificate-authority-data": certificateAuthorityData,
          },
        },
      ],
      contexts: [
        {
          name: CONTEXT_NAME,
          context: {
            cluster: CLUSTER_NAME,
            namespace: SCENARIO_NAMESPACE,
            user: SERVICE_ACCOUNT_NAME,
          },
        },
      ],
      users: [
        {
          name: SERVICE_ACCOUNT_NAME,
          user: { token },
        },
      ],
      "current-context": CONTEXT_NAME,
    },
    null,
    2,
  )}\n`;
}

export async function runClusterCommand(action, dependencies = {}) {
  assertAction(action);
  const repositoryRoot = normalizeRepositoryRoot(
    dependencies.repositoryRoot ?? repositoryRootFromModule(),
  );
  const execute = dependencies.execute ?? executeExternalCommand;
  const logger = dependencies.logger ?? console;
  const contract = await loadKindContract(repositoryRoot);

  assertActionFiles(action, contract);
  await verifyPinnedCliVersions(action, contract, execute);

  if (action === "up") {
    const clusterNames = await listClusterNames(contract, execute);
    if (clusterNames.has(contract.clusterName)) {
      await verifyExistingCluster(contract, execute);
      logger.info("Kind cluster already matches the pinned baseline");
      return;
    }

    await executeCommand(
      execute,
      buildClusterCommand("up", contract),
      "Kind cluster creation",
    );
    await verifyExistingCluster(contract, execute);
    logger.info("Kind cluster created with the pinned baseline");
    return;
  }

  if (action === "status") {
    const clusterNames = await listClusterNames(contract, execute);
    requireTargetCluster(clusterNames, contract);
    await verifyExistingCluster(contract, execute);
    logger.info("Kind cluster matches the pinned baseline");
    return;
  }

  if (action === "down") {
    const clusterNames = await listClusterNames(contract, execute);
    if (!clusterNames.has(contract.clusterName)) {
      logger.info("Kind cluster is already absent");
      return;
    }
    await executeCommand(
      execute,
      buildClusterCommand("down", contract),
      "Kind cluster deletion",
    );
    logger.info("Kind cluster deleted");
    return;
  }

  const paths = resolveRuntimePaths(
    repositoryRoot,
    dependencies.environment ?? process.env,
  );
  const clusterNames = await listClusterNames(contract, execute);
  requireTargetCluster(clusterNames, contract);
  const clusterProjection = await verifyExistingCluster(
    contract,
    execute,
    true,
  );
  await bootstrapDiagnosticAccess({
    contract,
    clusterProjection,
    paths,
    execute,
    logger,
    now: dependencies.now ?? (() => new Date()),
    renameFile: dependencies.renameFile ?? rename,
  });
}

async function bootstrapDiagnosticAccess({
  contract,
  clusterProjection,
  paths,
  execute,
  logger,
  now,
  renameFile,
}) {
  await executeCommand(
    execute,
    buildClusterCommand("bootstrap-access", contract),
    "Diagnostic RBAC bootstrap",
  );

  const tokenRequestRaw = await executeCommand(
    execute,
    tokenRequestCommand(contract),
    "ServiceAccount TokenRequest",
  );
  const { token } = parseTokenRequest(tokenRequestRaw, now());
  const kubeconfig = buildDiagnosticKubeconfig(clusterProjection, token);

  await writeVerifiedCredential({
    paths,
    kubeconfig,
    execute,
    renameFile,
  });
  logger.info("Diagnostic kubeconfig replaced after access verification");
}

async function writeVerifiedCredential({
  paths,
  kubeconfig,
  execute,
  renameFile,
}) {
  await mkdir(paths.runtimeDataDirectory, { recursive: true, mode: 0o700 });
  await assertRuntimeDirectory(paths.runtimeDataDirectory);
  await chmod(paths.runtimeDataDirectory, 0o700);
  await assertCredentialTarget(paths.diagnosticKubeconfig);

  const temporaryPath = path.join(
    paths.runtimeDataDirectory,
    `.${KUBECONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(kubeconfig, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);

    const accessResult = await executeCommand(
      execute,
      commandSpec(
        "kubectl",
        [
          "--kubeconfig",
          temporaryPath,
          "auth",
          "can-i",
          "create",
          "selfsubjectaccessreviews.authorization.k8s.io",
        ],
        READ_COMMAND_TIMEOUT_MILLISECONDS,
      ),
      "SelfSubjectAccessReview access check",
    );
    if (accessResult.trim().toLowerCase() !== "yes") {
      throw new KindClusterContractError(
        "Diagnostic identity lacks SelfSubjectAccessReview permission",
      );
    }

    try {
      await renameFile(temporaryPath, paths.diagnosticKubeconfig);
    } catch {
      throw new KindClusterContractError(
        "Failed to atomically replace the diagnostic credential",
      );
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await removeTemporaryCredential(temporaryPath);
    throw error;
  }
}

async function verifyPinnedCliVersions(action, contract, execute) {
  const kindVersionRaw = await executeCommand(
    execute,
    commandSpec(
      "kind",
      ["version"],
      READ_COMMAND_TIMEOUT_MILLISECONDS,
    ),
    "Kind version check",
  );
  let actualKindVersion;
  try {
    actualKindVersion = parseSemanticVersion(kindVersionRaw);
  } catch {
    throw new KindClusterContractError("Kind returned invalid version output");
  }
  if (actualKindVersion !== contract.kindVersion) {
    throw new KindClusterContractError(
      "Installed Kind version does not match the pinned baseline",
    );
  }

  if (action === "down") return;

  const kubectlVersionRaw = await executeCommand(
    execute,
    commandSpec(
      "kubectl",
      ["version", "--client", "--output=json"],
      READ_COMMAND_TIMEOUT_MILLISECONDS,
    ),
    "kubectl version check",
  );
  let actualKubectlVersion;
  try {
    actualKubectlVersion = parseKubectlClientVersion(kubectlVersionRaw);
  } catch {
    throw new KindClusterContractError(
      "kubectl returned invalid client version output",
    );
  }
  if (actualKubectlVersion !== contract.kubectlVersion) {
    throw new KindClusterContractError(
      "Installed kubectl version does not match the pinned baseline",
    );
  }
}

async function listClusterNames(contract, execute) {
  const output = await executeCommand(
    execute,
    buildClusterCommand("status", contract),
    "Kind cluster enumeration",
  );
  return new Set(nonEmptyLines(output));
}

function requireTargetCluster(clusterNames, contract) {
  if (!clusterNames.has(contract.clusterName)) {
    throw new KindClusterContractError(
      "The fixed Kind cluster does not exist; run cluster up explicitly",
    );
  }
}

async function verifyExistingCluster(
  contract,
  execute,
  includeCertificateAuthority = false,
) {
  const nodesOutput = await executeCommand(
    execute,
    commandSpec(
      "kind",
      ["get", "nodes", "--name", contract.clusterName],
      READ_COMMAND_TIMEOUT_MILLISECONDS,
    ),
    "Kind node enumeration",
  );
  const nodes = nonEmptyLines(nodesOutput);
  const expectedNode = `${contract.clusterName}-control-plane`;
  if (nodes.length !== 1 || nodes[0] !== expectedNode) {
    throw new KindClusterContractError(
      "The same-name Kind cluster has an incompatible node topology",
    );
  }

  const nodeImage = (
    await executeCommand(
      execute,
      commandSpec(
        "docker",
        ["inspect", "--format", "{{.Config.Image}}", expectedNode],
        READ_COMMAND_TIMEOUT_MILLISECONDS,
      ),
      "Kind node image inspection",
    )
  ).trim();
  if (nodeImage !== contract.nodeImage) {
    throw new KindClusterContractError(
      "The same-name Kind cluster node image is incompatible with the pinned baseline",
    );
  }

  const clusterProjection = await readAndValidateClusterProjection(
    contract,
    execute,
    includeCertificateAuthority,
  );

  const serverVersionRaw = await executeCommand(
    execute,
    commandSpec(
      "kubectl",
      ["--context", contract.contextName, "version", "--output=json"],
      READ_COMMAND_TIMEOUT_MILLISECONDS,
    ),
    "Kubernetes server version check",
  );
  const actualServerVersion = parseKubernetesServerVersion(serverVersionRaw);
  if (
    versionMinor(actualServerVersion) !==
    versionMinor(contract.kubernetesVersion)
  ) {
    throw new KindClusterContractError(
      "The same-name cluster Kubernetes minor is incompatible with the pinned baseline",
    );
  }
  return clusterProjection;
}

async function readAndValidateClusterProjection(
  contract,
  execute,
  includeCertificateAuthority,
) {
  const rawProjection = await executeCommand(
    execute,
    commandSpec(
      "kubectl",
      [
        "--context",
        contract.contextName,
        "config",
        "view",
        ...(includeCertificateAuthority ? ["--raw"] : []),
        "--minify",
        "--output=jsonpath-as-json={.clusters[0].cluster}",
      ],
      READ_COMMAND_TIMEOUT_MILLISECONDS,
    ),
    "Kind kubeconfig projection",
  );
  return projectClusterSettings(
    rawProjection,
    includeCertificateAuthority,
  );
}

function projectClusterSettings(rawJson, includeCertificateAuthority) {
  const entries = parseJsonArray(rawJson, "Kind cluster projection");
  const clusterSettings = entries[0];
  if (
    entries.length !== 1 ||
    clusterSettings === null ||
    typeof clusterSettings !== "object" ||
    Array.isArray(clusterSettings) ||
    clusterSettings["insecure-skip-tls-verify"] === true ||
    clusterSettings["proxy-url"] !== undefined
  ) {
    throw new KindClusterContractError(
      "Kind kubeconfig cluster projection is invalid",
    );
  }

  const server = validateLoopbackServer(clusterSettings.server);
  if (!includeCertificateAuthority) return undefined;

  return normalizeClusterProjection({
    server,
    certificateAuthorityData: clusterSettings["certificate-authority-data"],
  });
}

function tokenRequestCommand(contract) {
  const endpoint = `/api/v1/namespaces/${contract.scenarioNamespace}/serviceaccounts/${contract.serviceAccountName}/token`;
  const input = `${JSON.stringify({
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenRequest",
    spec: { expirationSeconds: TOKEN_REQUEST_EXPIRATION_SECONDS },
  })}\n`;
  return commandSpec(
    "kubectl",
    [
      "--context",
      contract.contextName,
      "create",
      "--raw",
      endpoint,
      "--filename=-",
    ],
    READ_COMMAND_TIMEOUT_MILLISECONDS,
    input,
  );
}

function commandSpec(command, args, timeoutMilliseconds, input) {
  if (typeof command !== "string" || !Array.isArray(args)) {
    throw new KindClusterContractError(
      "External commands require a binary and argument array",
    );
  }
  return {
    command,
    args: [...args],
    options: {
      timeoutMilliseconds,
      maxBufferBytes: COMMAND_OUTPUT_LIMIT_BYTES,
      ...(input === undefined ? {} : { input }),
    },
  };
}

async function executeCommand(execute, spec, label) {
  try {
    const output = await execute(spec.command, spec.args, spec.options);
    if (typeof output !== "string") {
      throw new Error("external command returned non-text output");
    }
    return output;
  } catch {
    throw new KindClusterContractError(`${label} failed`);
  }
}

function executeExternalCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(args)) {
      reject(
        new KindClusterContractError(
          "External command contract requires an argument array",
        ),
      );
      return;
    }

    const child = execFile(command, args, {
      shell: false,
      encoding: "utf8",
      timeout: options.timeoutMilliseconds,
      maxBuffer: options.maxBufferBytes,
    }, (error, stdout) => {
      if (error !== null) {
        reject(new KindClusterContractError("External command failed"));
        return;
      }
      resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

function parseKubernetesServerVersion(rawJson) {
  const document = parseJsonObject(rawJson, "Kubernetes version response");
  const gitVersion = document.serverVersion?.gitVersion;
  if (typeof gitVersion !== "string" || gitVersion.trim() === "") {
    throw new KindClusterContractError(
      "Kubernetes version response is missing serverVersion.gitVersion",
    );
  }
  try {
    return parseSemanticVersion(gitVersion);
  } catch {
    throw new KindClusterContractError(
      "Kubernetes server returned invalid version output",
    );
  }
}

function parseJwtExpiration(token) {
  const segments = token.split(".");
  if (segments.length !== 3 || segments[1] === "") {
    throw new KindClusterContractError(
      "TokenRequest status.token is not a three-segment JWT",
    );
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new KindClusterContractError("TokenRequest JWT payload is invalid");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= 0
  ) {
    throw new KindClusterContractError(
      "TokenRequest JWT payload is missing a valid exp",
    );
  }
  return payload.exp;
}

function validateLoopbackServer(rawServer) {
  if (typeof rawServer !== "string" || rawServer.trim() === "") {
    throw new KindClusterContractError(
      "Cluster projection is missing an HTTPS server",
    );
  }
  let server;
  try {
    server = new URL(rawServer);
  } catch {
    throw new KindClusterContractError(
      "Cluster projection server is not a valid URL",
    );
  }
  if (server.protocol !== "https:") {
    throw new KindClusterContractError(
      "Cluster projection server must use HTTPS",
    );
  }
  if (
    server.username !== "" ||
    server.password !== "" ||
    server.search !== "" ||
    server.hash !== "" ||
    (server.pathname !== "" && server.pathname !== "/")
  ) {
    throw new KindClusterContractError(
      "Cluster projection server URL contains unsupported components",
    );
  }
  const hostname = server.hostname.replace(/^\[|\]$/g, "");
  const addressKind = net.isIP(hostname);
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (addressKind === 4 && hostname.startsWith("127."));
  if (!loopback) {
    throw new KindClusterContractError(
      "Cluster projection server must use a loopback host",
    );
  }
  return server.toString().replace(/\/$/, "");
}

function assertFixedContract(contract) {
  if (
    contract === null ||
    typeof contract !== "object" ||
    contract.clusterName !== CLUSTER_NAME ||
    contract.contextName !== CONTEXT_NAME ||
    contract.scenarioNamespace !== SCENARIO_NAMESPACE ||
    contract.serviceAccountName !== SERVICE_ACCOUNT_NAME
  ) {
    throw new KindClusterContractError(
      "Cluster contract does not use the fixed project identities",
    );
  }
}

function isPathAtOrBelow(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function assertAction(action) {
  if (!VALID_ACTIONS.has(action)) {
    throw new KindClusterContractError(
      "Expected one cluster action: up, status, bootstrap-access, or down",
    );
  }
}

function normalizeRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "") {
    throw new KindClusterContractError("Repository root must be a path");
  }
  return path.resolve(repositoryRoot);
}

function assertRegularRepositoryFile(filePath, label) {
  let entry;
  try {
    entry = lstatSync(filePath);
  } catch {
    throw new KindClusterContractError(`${label} is missing`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new KindClusterContractError(
      `${label} must be a regular repository file`,
    );
  }
}

function assertActionFiles(action, contract) {
  if (action === "up") {
    assertRegularRepositoryFile(contract.kindConfigPath, "Kind configuration");
  }
  if (action === "bootstrap-access") {
    assertRegularRepositoryFile(
      contract.rbacManifestPath,
      "diagnostic RBAC manifest",
    );
  }
}

function assertPathHasNoSymbolicLinks(repositoryRoot, targetPath, label) {
  const relative = path.relative(repositoryRoot, targetPath);
  let current = repositoryRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new KindClusterContractError(`${label} could not be inspected`);
    }
    if (entry.isSymbolicLink()) {
      throw new KindClusterContractError(`${label} cannot use a symbolic link`);
    }
    if (current !== targetPath && !entry.isDirectory()) {
      throw new KindClusterContractError(
        `${label} has a non-directory parent component`,
      );
    }
  }
}

async function assertRuntimeDirectory(directoryPath) {
  const entry = await lstat(directoryPath);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new KindClusterContractError(
      "RUNTIME_DATA_DIR must be a real directory",
    );
  }
}

async function assertCredentialTarget(credentialPath) {
  try {
    const entry = await lstat(credentialPath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new KindClusterContractError(
        "Diagnostic kubeconfig target must be a regular file",
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function removeTemporaryCredential(temporaryPath) {
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new KindClusterContractError(
      "Failed to remove the temporary diagnostic credential",
    );
  }
}

function parseJsonObject(rawJson, label) {
  const document = parseJson(rawJson, label);
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new KindClusterContractError(`${label} must be a JSON object`);
  }
  return document;
}

function parseJsonArray(rawJson, label) {
  const document = parseJson(rawJson, label);
  if (!Array.isArray(document)) {
    throw new KindClusterContractError(`${label} must be a JSON array`);
  }
  return document;
}

function parseJson(rawJson, label) {
  if (
    typeof rawJson !== "string" ||
    Buffer.byteLength(rawJson, "utf8") > COMMAND_OUTPUT_LIMIT_BYTES
  ) {
    throw new KindClusterContractError(`${label} is not bounded JSON text`);
  }
  let document;
  try {
    document = JSON.parse(rawJson);
  } catch {
    throw new KindClusterContractError(`${label} is not valid JSON`);
  }
  return document;
}

function normalizeDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new KindClusterContractError(`${label} must be a valid Date`);
  }
  return value;
}

function nonEmptyLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function versionMinor(value) {
  return value.split(".").slice(0, 2).join(".");
}

function repositoryRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const [action, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0) {
    console.error(
      "FAIL cluster command accepts exactly one fixed action: up, status, bootstrap-access, or down",
    );
    process.exitCode = 1;
  } else {
    try {
      await runClusterCommand(action);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown cluster command failure";
      console.error(`FAIL ${message}`);
      process.exitCode = 1;
    }
  }
}
