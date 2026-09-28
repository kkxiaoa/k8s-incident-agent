import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

import { verifyDeploymentStatus, type DeploymentExecute } from "../../../scripts/deployment.mjs";
import { loadRelease, ReleaseError, type ReleaseManifest } from "../../../scripts/release.mjs";
import {
  runScenarioCommand,
  ScenarioCommandError,
  type ScenarioAction,
  type ScenarioCommandDependencies,
  type ScenarioExecute,
} from "../../../scripts/scenario.mjs";
import { contractError, producerError, upstreamContractError } from "../shared/errors.ts";
import { isNormalizedString, isPlainObject } from "../shared/guards.ts";
import { parseJson } from "../shared/json.ts";
import { COMMAND_TIMEOUT_MILLISECONDS } from "../shared/wait.ts";
import { APPLICATION_NAMESPACE, MONITORING_NAMESPACE } from "./cluster.ts";

const COMMAND_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export interface CommandOptions {
  cwd?: string;
  timeoutMilliseconds?: number;
  stdin?: string;
  input?: string;
}

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

// The injected executor may answer like the default one (stdout, or a rejection carrying
// exitCode and stdout) or like the deployment script's (a result object).
export type Execute = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<string | CommandResult>;

export type ScenarioRunner = typeof runScenarioCommand;
export type DeploymentStatusCheck = typeof verifyDeploymentStatus;

// The scripts' own entry points are the defaults; commands never reach past this boundary.
export const defaultScenarioRunner: ScenarioRunner = runScenarioCommand;
export const defaultDeploymentStatusCheck: DeploymentStatusCheck = verifyDeploymentStatus;

export interface CommandFailure extends Error {
  exitCode?: number;
  stdout: string;
}

export function executeExternalCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
        timeout: options.timeoutMilliseconds ?? COMMAND_TIMEOUT_MILLISECONDS,
      },
      (error, stdout) => {
        if (error !== null) {
          const failure = error as CommandFailure;
          failure.stdout = typeof stdout === "string" ? stdout : "";
          failure.exitCode = Number.isInteger(error.code) ? (error.code as number) : undefined;
          reject(failure);
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(options.stdin ?? options.input ?? "");
  });
}

export async function executeKubectl(
  execute: Execute,
  context: string,
  args: readonly string[],
  stdin?: string,
): Promise<string> {
  const result = await execute("kubectl", ["--context", context, ...args], {
    timeoutMilliseconds: COMMAND_TIMEOUT_MILLISECONDS,
    stdin,
  });
  if (typeof result === "string") return result;
  if (result?.exitCode === 0 && typeof result.stdout === "string") return result.stdout;
  throw contractError("cluster_command_failed", "A fixed evaluation cluster command failed");
}

export async function scaleMonitoringDeployment(
  name: string,
  replicas: number,
  context: string,
  execute: Execute,
): Promise<void> {
  await executeKubectl(execute, context, [
    "scale",
    `deployment/${name}`,
    "--namespace",
    MONITORING_NAMESPACE,
    `--replicas=${replicas}`,
    "--timeout=120s",
  ]);
  if (replicas === 1) {
    await executeKubectl(execute, context, [
      "rollout",
      "status",
      `deployment/${name}`,
      "--namespace",
      MONITORING_NAMESPACE,
      "--timeout=300s",
    ]);
  }
}

export async function restartFixedPod(
  namespace: string,
  appName: string,
  context: string,
  execute: Execute,
): Promise<void> {
  const raw = await executeKubectl(execute, context, [
    "get",
    "pods",
    "--namespace",
    namespace,
    "--selector",
    `app.kubernetes.io/name=${appName}`,
    "--output=json",
  ]);
  const document = parseJson(raw);
  if (!isPlainObject(document) || document.kind !== "List" || !Array.isArray(document.items) || document.items.length !== 1) {
    throw upstreamContractError();
  }
  const item: unknown = document.items[0];
  const metadata = isPlainObject(item) ? item.metadata : undefined;
  if (!isPlainObject(metadata) || !isNormalizedString(metadata.name)) throw upstreamContractError();
  await executeKubectl(execute, context, [
    "delete",
    "pod",
    metadata.name,
    "--namespace",
    namespace,
    "--wait=true",
    "--timeout=120s",
  ]);
  await executeKubectl(execute, context, [
    "rollout",
    "status",
    `deployment/${appName}`,
    "--namespace",
    namespace,
    "--timeout=300s",
  ]);
}

export async function rotateWebhookCredential(context: string, execute: Execute): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const encodedToken = Buffer.from(token, "utf8").toString("base64");
  for (const namespace of [APPLICATION_NAMESPACE, MONITORING_NAMESPACE]) {
    const manifest = JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "alertmanager-webhook",
        namespace,
        labels: { "app.kubernetes.io/part-of": "k8s-incident-agent" },
      },
      type: "Opaque",
      data: { token: encodedToken },
    });
    await executeKubectl(
      execute,
      context,
      ["apply", "--filename=-", "--validate=strict", "--request-timeout=30s"],
      manifest,
    );
  }
}

export function adaptScenarioExecutor(execute: Execute): ScenarioExecute {
  return async (command, args, options) => {
    const result = await execute(command, args, options);
    if (typeof result === "string") return result;
    if (result?.exitCode === 0 && typeof result.stdout === "string") return result.stdout;
    const error = new Error("Scenario command failed") as CommandFailure;
    error.exitCode = result?.exitCode;
    error.stdout = result?.stdout ?? "";
    throw error;
  };
}

export function adaptDeploymentExecutor(execute: Execute): DeploymentExecute {
  return async (command, args, options) => {
    try {
      const result = await execute(command, args, options);
      return typeof result === "string" ? { stdout: result, exitCode: 0 } : result;
    } catch (error) {
      const failure = error as Partial<CommandFailure> | undefined;
      if (Number.isInteger(failure?.exitCode) && typeof failure?.stdout === "string") {
        return { stdout: failure.stdout, exitCode: failure.exitCode as number };
      }
      throw error;
    }
  };
}

export async function loadReleaseManifest(
  releasePath: string | undefined,
  repositoryRoot: string,
): Promise<ReleaseManifest> {
  try {
    return await loadRelease(releasePath, repositoryRoot);
  } catch (error) {
    if (error instanceof ReleaseError) throw producerError(error.code, error.message);
    throw error;
  }
}

// The runner may be the real scenario script or a test double; either way its own error class
// is carried forward under its own code.
export async function runScenario(
  runner: ScenarioRunner,
  action: ScenarioAction,
  scenarioId: string,
  dependencies: ScenarioCommandDependencies,
): Promise<unknown> {
  try {
    return await runner(action, scenarioId, dependencies);
  } catch (error) {
    if (error instanceof ScenarioCommandError) throw producerError(error.code, error.message);
    throw error;
  }
}
