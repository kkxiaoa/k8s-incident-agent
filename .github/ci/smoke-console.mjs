import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Runs inside the exact candidate image, without a network interface or host ports.
const [architecture, rawCommand] = process.argv.slice(2);
assert.equal(process.arch, architecture === "amd64" ? "x64" : "arm64");
const [program, ...args] = JSON.parse(rawCommand);
const child = spawn(program, args, { stdio: "ignore", env: { ...process.env, HOSTNAME: "127.0.0.1" } });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120 && child.exitCode === null; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:3000/api/healthz", { signal: AbortSignal.timeout(1000) });
      ready = response.status === 204;
      if (ready) break;
    } catch { /* The real server has not started yet. */ }
    await delay(500);
  }
  assert.ok(ready, "Candidate Console did not become ready");
} finally {
  child.kill("SIGTERM");
  const stop = setTimeout(() => child.kill("SIGKILL"), 5000);
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  clearTimeout(stop);
}
