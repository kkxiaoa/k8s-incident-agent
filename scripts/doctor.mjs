import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEMANTIC_VERSION_PATTERN = /v?(\d+)\.(\d+)\.(\d+)/g;

export class VersionContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "VersionContractError";
  }
}

export function parseSemanticVersion(rawValue) {
  if (typeof rawValue !== "string") {
    throw new VersionContractError("Expected semantic version output to be text");
  }

  const value = rawValue.trim();
  const knownShape = value.match(
    /^(?:v|Python\s+|uv\s+|kind\s+v?)(\d+)\.(\d+)\.(\d+)/,
  );
  if (knownShape) {
    return knownShape.slice(1, 4).join(".");
  }

  const matches = [...value.matchAll(SEMANTIC_VERSION_PATTERN)];
  if (matches.length === 0) {
    throw new VersionContractError(
      `Could not find a semantic version in ${JSON.stringify(value)}`,
    );
  }
  if (matches.length > 1) {
    throw new VersionContractError(
      `Expected one unambiguous semantic version in ${JSON.stringify(value)}`,
    );
  }

  return matches[0].slice(1, 4).join(".");
}

export function parseKubectlClientVersion(rawValue) {
  let document;
  try {
    document = JSON.parse(rawValue);
  } catch {
    throw new VersionContractError("kubectl did not return valid JSON");
  }

  const gitVersion = document?.clientVersion?.gitVersion;
  if (typeof gitVersion !== "string" || gitVersion.trim() === "") {
    throw new VersionContractError(
      "kubectl JSON is missing clientVersion.gitVersion",
    );
  }

  return parseSemanticVersion(gitVersion);
}

export function evaluateExactVersion(actual, expected) {
  return parseSemanticVersion(actual) === parseSemanticVersion(expected)
    ? { ok: true, relation: "exact_match" }
    : { ok: false, relation: "baseline_mismatch" };
}

export function classifyKubectlSkew(clientVersion, serverVersion) {
  const client = versionParts(clientVersion);
  const server = versionParts(serverVersion);
  if (client.major !== server.major) {
    return { ok: false, relation: "unsupported_skew" };
  }

  const difference = Math.abs(client.minor - server.minor);
  if (difference === 0) {
    return { ok: true, relation: "same_minor" };
  }
  if (difference === 1) {
    return { ok: true, relation: "adjacent_minor" };
  }
  return { ok: false, relation: "unsupported_skew" };
}

export function classifyCommandFailure(tool, failure) {
  if (failure?.code === "ENOENT") {
    return "command_missing";
  }
  if (tool === "docker") {
    return "daemon_unavailable";
  }
  return "command_failed";
}

export function validateVersionContract(contract) {
  for (const key of [
    "node",
    "npm",
    "python",
    "uv",
    "kind",
    "kubernetes",
    "kubectl",
  ]) {
    parseSemanticVersion(contract[key]);
  }

  const node = versionParts(contract.node);
  const expectedNodeEngine = `>=${contract.node} <${node.major + 1}`;
  if (contract.nodeEngine !== expectedNodeEngine) {
    throw new VersionContractError(
      `Node engine must be ${expectedNodeEngine}, received ${contract.nodeEngine}`,
    );
  }

  const python = versionParts(contract.python);
  const expectedRequiresPython = `>=${contract.python},<${python.major}.${python.minor + 1}`;
  if (contract.requiresPython !== expectedRequiresPython) {
    throw new VersionContractError(
      `Python requirement must be ${expectedRequiresPython}, received ${contract.requiresPython}`,
    );
  }

  const expectedImagePrefix = `kindest/node:v${contract.kubernetes}@sha256:`;
  const digest = contract.nodeImage?.slice(expectedImagePrefix.length);
  if (
    typeof contract.nodeImage !== "string" ||
    !contract.nodeImage.startsWith(expectedImagePrefix) ||
    !/^[a-f0-9]{64}$/.test(digest ?? "")
  ) {
    throw new VersionContractError(
      "Kind node image must match the pinned Kubernetes version and SHA-256 digest",
    );
  }

  if (!classifyKubectlSkew(contract.kubectl, contract.kubernetes).ok) {
    throw new VersionContractError(
      "Pinned kubectl version is outside the supported Kubernetes skew",
    );
  }

  return contract;
}

export async function loadVersionContract(repositoryRoot) {
  const agentRuntimeRoot = path.join(
    repositoryRoot,
    "services",
    "agent-runtime",
  );
  const [nodeFile, packageFile, pythonFile, pyprojectFile, kindFile] =
    await Promise.all([
      readFile(path.join(repositoryRoot, ".nvmrc"), "utf8"),
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(path.join(agentRuntimeRoot, ".python-version"), "utf8"),
      readFile(path.join(agentRuntimeRoot, "pyproject.toml"), "utf8"),
      readFile(
        path.join(repositoryRoot, "deploy", "kind", "versions.json"),
        "utf8",
      ),
    ]);

  const packageDocument = parseJson(packageFile, "package.json");
  const kindDocument = parseJson(kindFile, "deploy/kind/versions.json");
  const packageManager = packageDocument.packageManager?.match(/^npm@(.+)$/);
  if (!packageManager) {
    throw new VersionContractError(
      "package.json packageManager must pin npm with npm@<version>",
    );
  }

  const requiresPython = requiredTomlString(pyprojectFile, "requires-python");
  const requiredUv = requiredTomlString(pyprojectFile, "required-version");
  if (!requiredUv.startsWith("==")) {
    throw new VersionContractError(
      "tool.uv.required-version must use an exact == pin",
    );
  }

  return validateVersionContract({
    node: parseSemanticVersion(nodeFile),
    nodeEngine: packageDocument.engines?.node,
    npm: parseSemanticVersion(packageManager[1]),
    python: parseSemanticVersion(pythonFile),
    requiresPython,
    uv: parseSemanticVersion(requiredUv.slice(2)),
    kind: parseSemanticVersion(kindDocument.kind),
    kubernetes: parseSemanticVersion(kindDocument.kubernetes),
    kubectl: parseSemanticVersion(kindDocument.kubectl),
    nodeImage: kindDocument.nodeImage,
  });
}

async function runDoctor() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  let contract;
  try {
    contract = await loadVersionContract(repositoryRoot);
  } catch (error) {
    printCheck({
      ok: false,
      label: "version-contract",
      detail: error instanceof Error ? error.message : "unknown contract error",
    });
    process.exitCode = 1;
    return;
  }

  const checks = [];
  checks.push(
    await checkExactVersion(
      "node",
      contract.node,
      process.execPath,
      ["--version"],
      parseSemanticVersion,
    ),
  );
  checks.push(
    await checkExactVersion(
      "npm",
      contract.npm,
      "npm",
      ["--version"],
      parseSemanticVersion,
    ),
  );
  checks.push(
    await checkExactVersion(
      "uv",
      contract.uv,
      "uv",
      ["--version"],
      parseSemanticVersion,
    ),
  );
  checks.push(await checkPython(contract.python));
  checks.push(await checkDocker());
  checks.push(
    await checkExactVersion(
      "kind",
      contract.kind,
      "kind",
      ["version"],
      parseSemanticVersion,
    ),
  );

  const kubectl = await checkExactVersion(
    "kubectl",
    contract.kubectl,
    "kubectl",
    ["version", "--client", "-o", "json"],
    parseKubectlClientVersion,
  );
  checks.push(kubectl);
  if (kubectl.actual) {
    const skew = classifyKubectlSkew(kubectl.actual, contract.kubernetes);
    checks.push({
      ...skew,
      label: "kubectl-skew",
      expected: `within one minor of ${contract.kubernetes}`,
      actual: kubectl.actual,
    });
  }

  for (const check of checks) {
    printCheck(check);
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

async function checkExactVersion(label, expected, command, args, parser) {
  try {
    const output = await execute(command, args);
    const actual = parser(output);
    return {
      ...evaluateExactVersion(actual, expected),
      label,
      expected,
      actual,
    };
  } catch (error) {
    return {
      ok: false,
      label,
      expected,
      detail:
        error instanceof VersionContractError
          ? "output_invalid"
          : classifyCommandFailure(label, error),
    };
  }
}

async function checkPython(expected) {
  try {
    const interpreter = (
      await execute("uv", [
        "python",
        "find",
        expected,
        "--no-python-downloads",
      ])
    ).trim();
    if (!path.isAbsolute(interpreter)) {
      throw new VersionContractError(
        "uv python find did not return an absolute interpreter path",
      );
    }
    return checkExactVersion(
      "python",
      expected,
      interpreter,
      ["--version"],
      parseSemanticVersion,
    );
  } catch (error) {
    return {
      ok: false,
      label: "python",
      expected,
      detail:
        error instanceof VersionContractError
          ? "output_invalid"
          : classifyCommandFailure("python", error),
    };
  }
}

async function checkDocker() {
  try {
    const actual = (
      await execute("docker", ["info", "--format", "{{.ServerVersion}}"])
    ).trim();
    if (actual === "") {
      throw new VersionContractError("Docker returned an empty server version");
    }
    return {
      ok: true,
      label: "docker",
      expected: "daemon available",
      actual,
      relation: "available",
    };
  } catch (error) {
    return {
      ok: false,
      label: "docker",
      expected: "daemon available",
      detail:
        error instanceof VersionContractError
          ? "output_invalid"
          : classifyCommandFailure("docker", error),
    };
  }
}

async function execute(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function printCheck({ ok, label, expected, actual, relation, detail }) {
  const fields = [ok ? "PASS" : "FAIL", label];
  if (expected) fields.push(`expected=${expected}`);
  if (actual) fields.push(`actual=${actual}`);
  if (relation) fields.push(`relation=${relation}`);
  if (detail) fields.push(`detail=${detail}`);
  console.log(fields.join(" "));
}

function parseJson(rawValue, label) {
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new VersionContractError(`${label} is not valid JSON`);
  }
}

function requiredTomlString(document, key) {
  const expression = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m");
  const match = document.match(expression);
  if (!match) {
    throw new VersionContractError(`pyproject.toml is missing ${key}`);
  }
  return match[1];
}

function versionParts(value) {
  const [major, minor, patch] = parseSemanticVersion(value)
    .split(".")
    .map(Number);
  return { major, minor, patch };
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  await runDoctor();
}
