import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dump, load, loadAll } from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const application = path.join(root, "deploy/application");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const kubectl = process.env.KUBECTL_BINARY ?? "kubectl";

test("executor component reuses the Runtime image and isolates identity and mounts", () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "task7-render-")));
  try {
    const lock = load(read("deploy/application/base/workloads/kustomization.yaml"));
    writeFileSync(path.join(directory, "kustomization.yaml"), dump({
      apiVersion: "kustomize.config.k8s.io/v1beta1", kind: "Kustomization",
      components: [path.relative(directory, path.join(application, "executor"))], images: lock.images,
    }));
    const documents = loadAll(execFileSync(kubectl, ["kustomize", directory], { encoding: "utf8" }));
    assert.equal(documents.length, 6);
    assert.deepEqual(documents.map((doc) => doc.kind).sort(), ["Deployment", "NetworkPolicy", "NetworkPolicy", "Role", "RoleBinding", "ServiceAccount"].sort());
    const deployment = documents.find((doc) => doc.kind === "Deployment");
    assert.equal(deployment.metadata.namespace, "k8s-incident-agent");
    assert.equal(deployment.spec.replicas, 1);
    assert.equal(deployment.spec.strategy.type, "Recreate");
    const pod = deployment.spec.template.spec;
    assert.equal(pod.serviceAccountName, "sandbox-executor");
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.containers.length, 1);
    const executor = pod.containers[0];
    const image = lock.images.find((entry) => entry.name === "k8s-incident-agent-runtime");
    assert.equal(executor.image, `${image.newName}@${image.digest}`);
    assert.deepEqual(executor.command, ["sandbox-executor"]);
    assert.equal(executor.securityContext.readOnlyRootFilesystem, true);
    assert.equal(executor.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(executor.securityContext.capabilities, { drop: ["ALL"] });
    assert.equal(pod.initContainers, undefined);
    assert.equal(executor.ports, undefined);
    assert.equal(executor.envFrom, undefined);
    assert.deepEqual(pod.volumes.map((entry) => entry.name).sort(), ["executor-auth", "kubernetes-api-access"]);
    assert.ok(executor.volumeMounts.every((entry) => entry.readOnly === true));
    assert.equal(pod.volumes.find((entry) => entry.secret).secret.secretName, "executor-auth");
    const token = pod.volumes.find((entry) => entry.projected).projected.sources[0];
    assert.deepEqual(token, { serviceAccountToken: { expirationSeconds: 600, path: "token" } });
    const role = documents.find((doc) => doc.kind === "Role");
    assert.equal(role.metadata.namespace, "k8s-incident-scenarios");
    assert.deepEqual(role.rules, [{ apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "patch"] }]);
    const binding = documents.find((doc) => doc.kind === "RoleBinding");
    assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "sandbox-executor", namespace: "k8s-incident-agent" }]);
    assert.equal(binding.roleRef.name, role.metadata.name);
    const policies = documents.filter((doc) => doc.kind === "NetworkPolicy");
    const worker = policies.find((doc) => doc.metadata.name === "sandbox-executor-egress").spec;
    assert.deepEqual(worker.ingress, []);
    assert.deepEqual(worker.policyTypes, ["Ingress", "Egress"]);
    assert.equal(worker.egress.length, 3);
    assert.deepEqual(worker.egress[0].to, [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "agent-runtime" } } }]);
    assert.deepEqual(worker.egress[0].ports, [{ protocol: "TCP", port: 8000 }]);
    assert.deepEqual(worker.egress[2], { ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 6443 }] });
    const runtime = policies.find((doc) => doc.metadata.name === "allow-executor-to-runtime").spec;
    assert.deepEqual(runtime.ingress[0].from, [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "sandbox-executor" } } }]);
    assert.deepEqual(runtime.ingress[0].ports, [{ protocol: "TCP", port: 8000 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("existing profiles do not enable or grant the new Executor before Task 12", () => {
  for (const profile of ["kind-evaluation", "k3s-evaluation", "k3s-online"]) {
    const output = execFileSync(kubectl, ["kustomize", path.join(application, "overlays", profile)], { encoding: "utf8" });
    assert.doesNotMatch(output, /sandbox-executor|executor-auth|EXECUTOR_HMAC_KEY_FILE/);
  }
});
