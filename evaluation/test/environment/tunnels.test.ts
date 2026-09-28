import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import type { FetchLike } from "../../src/environment/http.ts";
import {
  ENDPOINTS,
  endpointOrigin,
  openPortForwards,
  type Spawn,
  type SpawnedProcess,
} from "../../src/environment/tunnels.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { PORT_FORWARD_TIMEOUT_MILLISECONDS } from "../../src/shared/wait.ts";

class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    this.signalCode = signal;
    this.emit("exit");
    return true;
  }

  forward(port: number) {
    this.stdout.write(`Forwarding from 127.0.0.1:${port} -> 8000\n`);
  }

  die(code = 1) {
    this.exitCode = code;
    this.emit("exit");
  }
}

interface Spawned {
  args: string[];
  child: FakeChild;
}

function fakeCluster(t: TestContext, options: { readyStatus?: (url: string) => number; autoForward?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const spawned: Spawned[] = [];
  const spawn: Spawn = (command, args) => {
    assert.equal(command, "kubectl");
    const child = new FakeChild();
    spawned.push({ args: [...args], child });
    if (options.autoForward !== false) {
      const port = Number(args[6].split(":")[0]);
      queueMicrotask(() => child.forward(port));
    }
    return child;
  };
  const probes: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    probes.push(String(input));
    return new Response(null, { status: options.readyStatus?.(String(input)) ?? 200 });
  };
  const sleep = async (milliseconds: number) => {
    t.mock.timers.tick(milliseconds);
  };
  return { spawn, spawned, probes, fetchImpl, sleep };
}

const coded = (code: string) => (error: unknown) => error instanceof EvaluationError && error.code === code;

test("the four fixed endpoints are forwarded on loopback and probed on their ready paths", async (t) => {
  const cluster = fakeCluster(t);
  const tunnels = await openPortForwards("kind-k8s-incident-agent", cluster);
  assert.deepEqual(cluster.spawned.map((entry) => entry.args), [
    ["--context", "kind-k8s-incident-agent", "--namespace", "k8s-incident-agent", "port-forward", "service/agent-runtime", "18080:8000", "--address=127.0.0.1"],
    ["--context", "kind-k8s-incident-agent", "--namespace", "k8s-incident-agent", "port-forward", "service/incident-console", "13000:80", "--address=127.0.0.1"],
    ["--context", "kind-k8s-incident-agent", "--namespace", "k8s-incident-monitoring", "port-forward", "service/prometheus", "19090:9090", "--address=127.0.0.1"],
    ["--context", "kind-k8s-incident-agent", "--namespace", "k8s-incident-monitoring", "port-forward", "service/alertmanager", "19093:9093", "--address=127.0.0.1"],
  ]);
  assert.deepEqual(cluster.probes.sort(), [
    "http://127.0.0.1:13000/api/healthz",
    "http://127.0.0.1:18080/healthz",
    "http://127.0.0.1:19090/-/ready",
    "http://127.0.0.1:19093/-/ready",
  ]);
  assert.equal(endpointOrigin("prometheus"), "http://127.0.0.1:19090");
  assert.equal(ENDPOINTS.console.readyPath, "/api/healthz");

  await tunnels.close();
  assert.ok(cluster.spawned.every((entry) => entry.child.kills.length === 1 && entry.child.kills[0] === "SIGTERM"));
  await tunnels.close();
  assert.ok(cluster.spawned.every((entry) => entry.child.kills.length === 1));
});

test("a forward that exits before its ready line fails the tunnel set and stops the others", async (t) => {
  const cluster = fakeCluster(t, { autoForward: false });
  const opening = openPortForwards("ctx", cluster);
  await new Promise((resolve) => setImmediate(resolve));
  // Only the forwarding line means ready; other output keeps the tunnel set pending.
  for (const entry of cluster.spawned) entry.child.stdout.write("Handling connection for 0\n");
  const pending = Symbol("pending");
  assert.equal(await Promise.race([opening.then(() => "opened"), new Promise((resolve) => setImmediate(() => resolve(pending)))]), pending);
  assert.deepEqual(cluster.probes, []);
  cluster.spawned[0].child.forward(18_080);
  cluster.spawned[1].child.die();
  await assert.rejects(opening, coded("port_forward_failed"));
  assert.deepEqual(cluster.spawned.map((entry) => entry.child.kills), [["SIGTERM"], [], ["SIGTERM"], ["SIGTERM"]]);
});

test("a ready line that never arrives fails after the port-forward budget", async (t) => {
  const cluster = fakeCluster(t, { autoForward: false });
  const opening = openPortForwards("ctx", cluster);
  opening.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(PORT_FORWARD_TIMEOUT_MILLISECONDS);
  await assert.rejects(opening, coded("port_forward_failed"));
});

test("an endpoint whose ready probe keeps failing times out as not ready", async (t) => {
  const failing = fakeCluster(t, { readyStatus: (url) => (url.includes("19093") ? 503 : 200) });
  await assert.rejects(openPortForwards("ctx", failing), coded("port_forward_not_ready"));
  assert.ok(failing.probes.filter((url) => url.includes("19093")).length > 1);
  assert.ok(failing.spawned.every((entry) => entry.child.kills.length === 1));
});

test("a forward that dies while its endpoint is being probed is reported as failed", async (t) => {
  const dying = fakeCluster(t, {
    readyStatus: (url) => {
      if (url.includes("18080")) {
        dying.spawned[0].child.die(137);
        return 503;
      }
      return 200;
    },
  });
  await assert.rejects(openPortForwards("ctx", dying), coded("port_forward_failed"));
});

test("restart stops every forward and spawns a fresh set", async (t) => {
  const cluster = fakeCluster(t);
  const tunnels = await openPortForwards("ctx", cluster);
  await tunnels.restart();
  assert.equal(cluster.spawned.length, 8);
  assert.ok(cluster.spawned.slice(0, 4).every((entry) => entry.child.kills.length === 1));
  assert.ok(cluster.spawned.slice(4).every((entry) => entry.child.kills.length === 0));
  await tunnels.close();
  assert.ok(cluster.spawned.slice(4).every((entry) => entry.child.kills.length === 1));
});
