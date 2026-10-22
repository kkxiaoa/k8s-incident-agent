import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Runs inside the exact candidate image, without a network interface or host ports.
const [architecture, rawCommand] = process.argv.slice(2);
// A hang bound, not a startup target: an emulated platform starts many times slower.
const startupSeconds = 300;
const deadline = performance.now() + startupSeconds * 1000;
assert.equal(process.arch, architecture === "amd64" ? "x64" : "arm64");
assert.equal(process.versions.node, process.env.NODE_VERSION);
execFileSync("/bin/true", { timeout: 5000 });
for (const filename of ["/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/yarn",
  "/usr/local/bin/yarnpkg", "/usr/local/lib/node_modules/npm", "/opt/yarn-v1.22.22"]) {
  assert.equal(existsSync(filename), false, `Unexpected runtime package manager: ${filename}`);
}
const require = createRequire(path.resolve("package.json"));
const sharp = require("sharp");
const encoded = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
  .resize(4, 4).webp().toBuffer();
const decoded = await sharp(encoded).metadata();
assert.deepEqual([decoded.format, decoded.width, decoded.height], ["webp", 4, 4]);
const [program, ...args] = JSON.parse(rawCommand);
const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOSTNAME: "127.0.0.1" } });
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => { output = (output + chunk).slice(-2000); });
}
const running = () => child.exitCode === null && child.signalCode === null;
try {
  let ready = false;
  while (!ready && running() && performance.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3000/api/healthz", { signal: AbortSignal.timeout(1000) });
      ready = response.status === 204;
    } catch { /* The real server has not started yet. */ }
    if (!ready) await delay(500);
  }
  const outcome = running() ? `within ${startupSeconds} s` : `and exited with ${child.exitCode ?? child.signalCode}`;
  // Shown only on failure; the smoke holds no credential with authority.
  assert.ok(ready, `Candidate Console did not become ready ${outcome}; output tail:\n${output}`);
} finally {
  child.kill("SIGTERM");
  const stop = setTimeout(() => child.kill("SIGKILL"), 5000);
  await new Promise(resolve => { if (!running()) resolve(); else child.once("exit", resolve); });
  clearTimeout(stop);
}
