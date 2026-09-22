import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { load, loadAll } from "js-yaml";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const KUBECTL_BINARY = process.env.KUBECTL_BINARY ?? "kubectl";
const RULE_TESTS = path.join(
  REPOSITORY_ROOT,
  "monitoring",
  "tests",
  "alert-rules.promtool.yaml",
);

function lockedPrometheusImage() {
  const lock = load(
    readFileSync(
      path.join(REPOSITORY_ROOT, "deploy", "monitoring", "base", "workloads", "kustomization.yaml"),
      "utf8",
    ),
  );
  const image = lock.images.find(
    (candidate) => candidate.name === "quay.io/prometheus/prometheus",
  );
  return `${image.newName}@${image.digest}`;
}

function renderedRules() {
  const rendered = execFileSync(
    KUBECTL_BINARY,
    ["kustomize", path.join(REPOSITORY_ROOT, "deploy", "application", "overlays", "k3s-evaluation")],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  const documents = [];
  loadAll(rendered, (document) => {
    if (document !== undefined && document !== null) documents.push(document);
  });
  const rules = documents.find(
    (document) =>
      document.kind === "ConfigMap" &&
      document.metadata?.name === "prometheus-rules",
  );
  assert.notEqual(rules, undefined);
  return rules.data["alerts.yaml"];
}

test("managed alert rules pass their promtool unit tests on the locked Prometheus", (t) => {
  const image = lockedPrometheusImage();
  const available = spawnSync("docker", ["image", "inspect", image], {
    stdio: "ignore",
  });
  if (available.error !== undefined || available.status !== 0) {
    assert.notEqual(process.env.CI, "true", "CI requires the locked Prometheus image and a working Docker daemon");
    t.skip(`locked Prometheus image ${image} is not available to docker`);
    return;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "alert-rules-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "alerts.yaml"), renderedRules());
  copyFileSync(RULE_TESTS, path.join(directory, "alert-rules.promtool.yaml"));

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--volume",
      `${directory}:/work:ro`,
      "--workdir",
      "/work",
      "--entrypoint",
      "promtool",
      image,
      "test",
      "rules",
      "alert-rules.promtool.yaml",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SUCCESS/);
});
