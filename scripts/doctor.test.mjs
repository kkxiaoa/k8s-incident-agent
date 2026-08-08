import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCommandFailure,
  classifyKubectlSkew,
  evaluateExactVersion,
  parseKubectlClientVersion,
  parseSemanticVersion,
  validateVersionContract,
} from "./doctor.mjs";

test("parseSemanticVersion accepts known CLI version shapes", () => {
  assert.equal(parseSemanticVersion("v24.19.0"), "24.19.0");
  assert.equal(parseSemanticVersion("Python 3.13.15"), "3.13.15");
  assert.equal(parseSemanticVersion("uv 0.12.3 (Homebrew)"), "0.12.3");
  assert.equal(parseSemanticVersion("kind v0.32.0 go1.24.4 darwin/arm64"), "0.32.0");
});

test("parseSemanticVersion rejects output without one unambiguous version", () => {
  assert.throws(
    () => parseSemanticVersion("version unavailable"),
    /semantic version/i,
  );
  assert.throws(
    () => parseSemanticVersion("client 1.35.0 server 1.36.1"),
    /unambiguous/i,
  );
});

test("parseKubectlClientVersion projects only clientVersion.gitVersion", () => {
  const output = JSON.stringify({
    clientVersion: {
      gitVersion: "v1.36.2",
      gitCommit: "ignored",
    },
    kustomizeVersion: "v5.7.1",
  });

  assert.equal(parseKubectlClientVersion(output), "1.36.2");
  assert.throws(
    () => parseKubectlClientVersion('{"clientVersion":{}}'),
    /clientVersion\.gitVersion/,
  );
});

test("evaluateExactVersion distinguishes exact matches from baseline drift", () => {
  assert.deepEqual(evaluateExactVersion("24.19.0", "24.19.0"), {
    ok: true,
    relation: "exact_match",
  });
  assert.deepEqual(evaluateExactVersion("24.19.1", "24.19.0"), {
    ok: false,
    relation: "baseline_mismatch",
  });
  assert.deepEqual(evaluateExactVersion("25.0.0", "24.19.0"), {
    ok: false,
    relation: "baseline_mismatch",
  });
});

test("classifyKubectlSkew follows the one-minor supported window", () => {
  assert.deepEqual(classifyKubectlSkew("1.36.2", "1.36.1"), {
    ok: true,
    relation: "same_minor",
  });
  assert.deepEqual(classifyKubectlSkew("1.35.9", "1.36.1"), {
    ok: true,
    relation: "adjacent_minor",
  });
  assert.deepEqual(classifyKubectlSkew("1.37.0", "1.36.1"), {
    ok: true,
    relation: "adjacent_minor",
  });
  assert.deepEqual(classifyKubectlSkew("1.33.1", "1.36.1"), {
    ok: false,
    relation: "unsupported_skew",
  });
});

test("classifyCommandFailure keeps missing commands distinct from Docker downtime", () => {
  assert.equal(
    classifyCommandFailure("docker", { code: "ENOENT" }),
    "command_missing",
  );
  assert.equal(
    classifyCommandFailure("docker", { code: 1 }),
    "daemon_unavailable",
  );
  assert.equal(
    classifyCommandFailure("kind", { code: 1 }),
    "command_failed",
  );
});

test("validateVersionContract rejects drift between duplicated consumer files", () => {
  const validContract = {
    node: "24.19.0",
    nodeEngine: ">=24.19.0 <25",
    npm: "11.17.0",
    python: "3.13.15",
    requiresPython: ">=3.13.15,<3.14",
    uv: "0.12.3",
    kind: "0.32.0",
    kubernetes: "1.36.1",
    kubectl: "1.36.2",
    nodeImage:
      "kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5",
  };

  assert.doesNotThrow(() => validateVersionContract(validContract));
  assert.throws(
    () =>
      validateVersionContract({
        ...validContract,
        nodeEngine: ">=24 <25",
      }),
    /Node engine/i,
  );
  assert.throws(
    () =>
      validateVersionContract({
        ...validContract,
        nodeImage:
          "kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95",
      }),
    /node image/i,
  );
});
