import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readRepositoryFile = (path) =>
  readFile(resolve(repositoryRoot, path), "utf8");

function readExecCommand(dockerfile) {
  const match = /^CMD (\[[^\n]+\])$/m.exec(dockerfile);
  assert.ok(match, "missing exec-form CMD");
  const command = JSON.parse(match[1]);
  assert.ok(
    Array.isArray(command) && command.every((argument) => typeof argument === "string"),
    "CMD must be a string array",
  );
  return command;
}

function optionValue(command, option) {
  const index = command.indexOf(option);
  assert.notEqual(index, -1, `missing command option: ${option}`);
  assert.ok(index + 1 < command.length, `missing value for command option: ${option}`);
  return command[index + 1];
}

test("container base images are versioned and digest pinned at their only source", async () => {
  const [consoleDockerfile, runtimeDockerfile] = await Promise.all([
    readRepositoryFile("Dockerfile.console"),
    readRepositoryFile("services/agent-runtime/Dockerfile"),
  ]);

  assert.match(
    consoleDockerfile,
    /^FROM node:24\.19\.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS node-base$/m,
  );
  assert.match(
    runtimeDockerfile,
    /^FROM python:3\.13\.15-slim-bookworm@sha256:c45a22ea000adfd9cda29364bbe7edd23001ce5cc2ad15857cfbf7766943b9ca AS python-base$/m,
  );
  assert.match(
    runtimeDockerfile,
    /^FROM ghcr\.io\/astral-sh\/uv:0\.12\.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc AS uv$/m,
  );
  assert.doesNotMatch(`${consoleDockerfile}\n${runtimeDockerfile}`, /:latest\b/);
});

test("console image carries the complete standalone runtime as a non-root process", async () => {
  const dockerfile = await readRepositoryFile("Dockerfile.console");

  assert.match(dockerfile, /RUN npm ci\b/);
  assert.match(dockerfile, /RUN npm run build\b/);
  assert.ok(dockerfile.includes("vitest.config.mts"));
  assert.ok(dockerfile.includes("vitest.setup.ts"));
  assert.match(dockerfile, /\/workspace\/\.next\/standalone \.\//);
  assert.match(dockerfile, /\/workspace\/\.next\/static \.\/\.next\/static/);
  assert.match(dockerfile, /\/workspace\/public \.\/public/);
  assert.match(dockerfile, /^USER 10001:10001$/m);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  const command = readExecCommand(dockerfile);
  assert.equal(command[0], "node");
  assert.ok(command.includes("server.js"));
});

test("runtime image preserves the locked source, migration, and catalog layouts", async () => {
  const dockerfile = await readRepositoryFile(
    "services/agent-runtime/Dockerfile",
  );

  const syncCommands = dockerfile
    .split("\n")
    .filter((line) => line.startsWith("RUN uv sync"));
  assert.ok(syncCommands.length > 0, "missing locked production dependency sync");
  for (const command of syncCommands) {
    const arguments_ = command.split(/\s+/);
    assert.ok(arguments_.includes("--locked"));
    assert.ok(arguments_.includes("--no-dev"));
  }
  assert.ok(
    syncCommands.some((command) => command.split(/\s+/).includes("--no-install-project")),
    "dependency layer must not install source before it is copied",
  );
  for (const asset of [
    "services/agent-runtime/migrations",
    "services/agent-runtime/src",
    "/workspace/scenarios",
    "/workspace/monitoring/catalog",
  ]) {
    assert.ok(dockerfile.includes(asset), `missing runtime asset: ${asset}`);
  }
  assert.match(dockerfile, /RUNTIME_DATA_DIR=\/var\/lib\/k8s-incident-agent\/runtime/);
  assert.match(dockerfile, /SCENARIO_CATALOG_DIR=\/workspace\/scenarios/);
  assert.match(dockerfile, /ALERT_CATALOG_DIR=\/workspace\/monitoring\/catalog/);
  assert.match(dockerfile, /^USER 10001:10001$/m);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  const command = readExecCommand(dockerfile);
  assert.equal(command[0], "uvicorn");
  assert.ok(command.includes("k8s_incident_agent.api:create_runtime_app"));
  assert.ok(command.includes("--factory"));
  assert.equal(optionValue(command, "--host"), "0.0.0.0");
  assert.equal(optionValue(command, "--port"), "8000");
  assert.equal(optionValue(command, "--workers"), "1");
  assert.equal(optionValue(command, "--timeout-graceful-shutdown"), "5");
});

test("container build context excludes local credentials and generated state", async () => {
  const dockerignore = await readRepositoryFile(".dockerignore");
  const requiredRules = [
    ".git",
    ".next",
    ".runtime",
    "node_modules",
    "**/.env",
    "**/.env.*",
    "**/.venv",
    "*.kubeconfig",
    "*.key",
    "*.pem",
  ];

  for (const rule of requiredRules) {
    assert.ok(
      dockerignore.split("\n").includes(rule),
      `missing .dockerignore rule: ${rule}`,
    );
  }

  const dockerfiles = await Promise.all([
    readRepositoryFile("Dockerfile.console"),
    readRepositoryFile("services/agent-runtime/Dockerfile"),
  ]);
  const combined = dockerfiles.join("\n");
  assert.doesNotMatch(combined, /^\s*(?:ARG|ENV)\s+.*(?:API_KEY|TOKEN|PASSWORD|SECRET)/im);
  assert.doesNotMatch(combined, /^COPY\s+\.\s+/m);
});
