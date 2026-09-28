import { spawn as spawnChild } from "node:child_process";

import { contractError } from "../shared/errors.ts";
import {
  HTTP_TIMEOUT_MILLISECONDS,
  PORT_FORWARD_TIMEOUT_MILLISECONDS,
  waitUntil,
  type Sleep,
} from "../shared/wait.ts";
import { APPLICATION_NAMESPACE, MONITORING_NAMESPACE } from "./cluster.ts";
import type { FetchLike } from "./http.ts";

interface Endpoint {
  namespace: string;
  resource: string;
  localPort: number;
  remotePort: number;
  readyPath: string;
}

export const ENDPOINTS = Object.freeze({
  runtime: Object.freeze({
    namespace: APPLICATION_NAMESPACE,
    resource: "service/agent-runtime",
    localPort: 18_080,
    remotePort: 8_000,
    readyPath: "/healthz",
  }),
  console: Object.freeze({
    namespace: APPLICATION_NAMESPACE,
    resource: "service/incident-console",
    localPort: 13_000,
    remotePort: 80,
    readyPath: "/api/healthz",
  }),
  prometheus: Object.freeze({
    namespace: MONITORING_NAMESPACE,
    resource: "service/prometheus",
    localPort: 19_090,
    remotePort: 9_090,
    readyPath: "/-/ready",
  }),
  alertmanager: Object.freeze({
    namespace: MONITORING_NAMESPACE,
    resource: "service/alertmanager",
    localPort: 19_093,
    remotePort: 9_093,
    readyPath: "/-/ready",
  }),
}) satisfies Readonly<Record<string, Endpoint>>;

export type EndpointName = keyof typeof ENDPOINTS;

export function endpointOrigin(name: EndpointName): string {
  return `http://127.0.0.1:${ENDPOINTS[name].localPort}`;
}

// The subset of a child process the tunnel supervision relies on.
export interface SpawnedProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "error" | "exit", listener: (...args: unknown[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export type Spawn = (command: string, args: readonly string[]) => SpawnedProcess;

export interface Tunnels {
  restart(): Promise<void>;
  close(): Promise<void>;
}

interface TunnelDependencies {
  fetchImpl: FetchLike;
  sleep: Sleep;
  spawn?: Spawn;
}

interface PortForward {
  name: EndpointName;
  child: SpawnedProcess;
  ready: Promise<void>;
  isFailed: () => boolean;
}

const defaultSpawn: Spawn = (command, args) =>
  spawnChild(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });

export async function openPortForwards(
  context: string,
  dependencies: TunnelDependencies,
): Promise<Tunnels> {
  const spawn = dependencies.spawn ?? defaultSpawn;
  const names = Object.keys(ENDPOINTS) as EndpointName[];
  let active: PortForward[] = [];
  const start = async () => {
    active = names.map((name) => startPortForward(name, context, spawn));
    try {
      await Promise.all(active.map((forward) => forward.ready));
      await Promise.all(
        names.map((name) =>
          waitUntil(
            "port_forward_not_ready",
            async () => {
              requirePortForwardRunning(active, name);
              try {
                const response = await dependencies.fetchImpl(
                  `${endpointOrigin(name)}${ENDPOINTS[name].readyPath}`,
                  { signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS) },
                );
                requirePortForwardRunning(active, name);
                return response.status >= 200 && response.status < 500;
              } catch {
                return false;
              }
            },
            PORT_FORWARD_TIMEOUT_MILLISECONDS,
            dependencies.sleep,
          ),
        ),
      );
    } catch (error) {
      await stopAll(active);
      active = [];
      throw error;
    }
  };
  await start();
  return {
    async restart() {
      await stopAll(active);
      active = [];
      await start();
    },
    async close() {
      await stopAll(active);
      active = [];
    },
  };
}

function startPortForward(name: EndpointName, context: string, spawn: Spawn): PortForward {
  const endpoint = ENDPOINTS[name];
  const child = spawn("kubectl", [
    "--context",
    context,
    "--namespace",
    endpoint.namespace,
    "port-forward",
    endpoint.resource,
    `${endpoint.localPort}:${endpoint.remotePort}`,
    "--address=127.0.0.1",
  ]);
  let failed = false;
  let readinessOutput = "";
  const expectedReadyLine = `Forwarding from 127.0.0.1:${endpoint.localPort} -> `;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      failed = true;
      reject(portForwardFailed(name));
    }, PORT_FORWARD_TIMEOUT_MILLISECONDS);
    const finish = (operation: () => void) => {
      clearTimeout(timeout);
      operation();
    };
    const inspect = (chunk: unknown) => {
      readinessOutput = `${readinessOutput}${String(chunk)}`.slice(-1024);
      if (readinessOutput.includes(expectedReadyLine)) finish(resolve);
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", () => {
      failed = true;
      finish(() => reject(portForwardFailed(name)));
    });
    child.once("exit", () => {
      failed = true;
      finish(() => reject(portForwardFailed(name)));
    });
  });
  return { name, child, ready, isFailed: () => failed };
}

function requirePortForwardRunning(forwards: PortForward[], name: EndpointName): void {
  const forward = forwards.find((candidate) => candidate.name === name);
  if (
    forward === undefined ||
    forward.isFailed() ||
    forward.child.exitCode !== null ||
    forward.child.signalCode !== null
  ) {
    throw portForwardFailed(name);
  }
}

function portForwardFailed(name: EndpointName) {
  return contractError(
    "port_forward_failed",
    `The fixed ${name} evaluation port forward did not become or remain available`,
  );
}

async function stopAll(forwards: PortForward[]): Promise<void> {
  for (const { child } of forwards) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    forwards.map(
      ({ child }) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          setTimeout(resolve, 2_000);
        }),
    ),
  );
}
