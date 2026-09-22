#!/usr/bin/env node
// Subprocess double for registry operations only; OCI validation/import stays real.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const filename = process.env.PUBLICATION_TEST_STATE;
const state = JSON.parse(readFileSync(filename, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(filename, JSON.stringify(state));
const fail = message => { save(); process.stderr.write(message); process.exit(1); };
if (args[0] === "pull") {
  assert.match(args[1], /^quay.io\/skopeo\/stable:v1\.20\.0@sha256:[a-f0-9]{64}$/);
  save();
  process.exit(0);
}
assert.equal(args[0], "run");
for (const flag of ["--rm", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]) assert.ok(args.includes(flag));
const auth = args.find(arg => arg.endsWith(":/auth.json:ro")).slice(0, -14);
assert.equal(statSync(auth).mode & 0o777, 0o600);
assert.ok(JSON.parse(readFileSync(auth, "utf8")).auths["ghcr.io"].auth);
state.authFiles.push(auth);
const reference = args.at(-1).replace("docker://", "");
if (args.includes("inspect")) {
  assert.ok(args.includes("--raw"));
  if (state.authFailure) fail("unauthorized: access denied");
  if (args[args.indexOf("--authfile") + 1] === "/anonymous-auth.json") {
    const emptyAuth = args.find(arg => arg.endsWith(":/anonymous-auth.json:ro")).split(":")[0];
    assert.deepEqual(JSON.parse(readFileSync(emptyAuth, "utf8")), { auths: {} });
    if (state.privatePackages) fail("unauthorized: public access denied");
  }
  if (!Object.hasOwn(state.content, reference)) fail("manifest unknown: requested tag is absent");
  process.stdout.write(state.content[reference]);
} else {
  assert.ok(args.includes("copy") && args.includes("--all") && args.includes("--preserve-digests"));
  if (state.failRuntimeOnce && reference.includes("-runtime:")) {
    state.failRuntimeOnce = false;
    fail("connection reset while uploading");
  }
  const bundle = args.find(arg => arg.endsWith(":/bundle:ro")).slice(0, -11);
  const component = reference.includes("-console:") ? "console" : "runtime";
  const layout = path.join(bundle, `${component}-oci`);
  const descriptor = JSON.parse(readFileSync(path.join(layout, "index.json"), "utf8")).manifests[0];
  const raw = readFileSync(path.join(layout, "blobs/sha256", descriptor.digest.slice(7)), "utf8");
  const repository = reference.split(":")[0];
  state.content[reference] = state.rewriteIndex ? `${raw} ` : raw;
  state.content[`${repository}@${descriptor.digest}`] = raw;
  for (const child of JSON.parse(raw).manifests) {
    state.content[`${repository}@${child.digest}`] = readFileSync(path.join(layout, "blobs/sha256", child.digest.slice(7)), "utf8");
  }
}
save();
