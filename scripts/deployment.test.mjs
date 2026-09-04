import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { load, loadAll } from "js-yaml";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEPLOYMENT_SCRIPT = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "deployment.mjs",
);
const APPLICATION_ROOT = path.join(
  REPOSITORY_ROOT,
  "deploy",
  "application",
);
const KUBECTL_BINARY = process.env.KUBECTL_BINARY ?? "kubectl";
const REAL_KUBECTL =
  process.env.KUBECTL_BINARY ??
  execFileSync("sh", ["-c", "command -v kubectl"], {
    encoding: "utf8",
  }).trim();
const CONSOLE_IMAGE =
  "k8s-incident-agent-console@sha256:62310090946e27a4274680ab09084046e6708994a499761d0e2fed3a69b64fa1";
const RUNTIME_IMAGE =
  "k8s-incident-agent-runtime@sha256:395f13fd3f5c01e28ff9c5656e28563b714b6018e9aa79e81b84cace9d66663d";
const PROMETHEUS_IMAGE =
  "quay.io/prometheus/prometheus@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893";
const ALERTMANAGER_IMAGE =
  "quay.io/prometheus/alertmanager@sha256:690c7b525f4367aa91f73e2f91c632206d32e97c6384bdbf2fb7a861b420340d";
const KUBE_STATE_METRICS_IMAGE =
  "registry.k8s.io/kube-state-metrics/kube-state-metrics@sha256:42cfe3723a5f058171c627537fb57a3ea0f26e4380fa18555a95cb1a1b4cfc5b";

function render(relativePath) {
  return execFileSync(
    KUBECTL_BINARY,
    ["kustomize", path.join(APPLICATION_ROOT, relativePath)],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
}

function documents(rawYaml) {
  const result = [];
  loadAll(rawYaml, (document) => {
    if (document !== undefined && document !== null) result.push(document);
  });
  return result;
}

function identity(document) {
  return [
    document.kind,
    document.metadata?.namespace ?? "",
    document.metadata?.name,
  ].join("/");
}

function indexDocuments(rawYaml) {
  const result = new Map();
  for (const document of documents(rawYaml)) {
    const key = identity(document);
    assert.equal(result.has(key), false, `duplicate rendered identity ${key}`);
    result.set(key, document);
  }
  return result;
}

function getResource(index, kind, name, namespace = "") {
  const key = [kind, namespace, name].join("/");
  assert.equal(index.has(key), true, `missing rendered resource ${key}`);
  return index.get(key);
}

test("all deployment profiles render byte-stably from the shared base", () => {
  const profiles = [
    "overlays/kind-evaluation",
    "overlays/k3s-evaluation",
    "overlays/k3s-online",
  ];
  for (const profile of profiles) {
    const first = render(profile);
    const second = render(profile);
    assert.equal(first, second);
    assert.notEqual(documents(first).length, 0);
    indexDocuments(first);
  }
});

test("profile overlays change only platform storage, ingress, and intake behavior", () => {
  const kind = indexDocuments(render("overlays/kind-evaluation"));
  const evaluation = indexDocuments(render("overlays/k3s-evaluation"));
  const online = indexDocuments(render("overlays/k3s-online"));

  const kindPvc = getResource(
    kind,
    "PersistentVolumeClaim",
    "runtime-data",
    "k8s-incident-agent",
  );
  assert.equal(kindPvc.spec.storageClassName, "k8s-incident-agent-kind");
  assert.equal(kindPvc.spec.volumeName, "k8s-incident-agent-runtime-data");
  const kindPv = getResource(
    kind,
    "PersistentVolume",
    "k8s-incident-agent-runtime-data",
  );
  assert.equal(kindPv.spec.persistentVolumeReclaimPolicy, "Retain");
  assert.equal(kindPv.spec.hostPath.path, "/var/local/k8s-incident-agent");
  assert.equal(
    [...kind.values()].some((resource) => resource.kind === "Ingress"),
    false,
  );
  assert.equal(
    kind.has(
      "NetworkPolicy/k8s-incident-agent/allow-traefik-to-console",
    ),
    false,
  );

  for (const profile of [evaluation, online]) {
    const pvc = getResource(
      profile,
      "PersistentVolumeClaim",
      "runtime-data",
      "k8s-incident-agent",
    );
    assert.equal(pvc.spec.storageClassName, "local-path");
    assert.equal(
      [...profile.values()].some((resource) => resource.kind === "PersistentVolume"),
      false,
    );
    const ingress = getResource(
      profile,
      "Ingress",
      "incident-console",
      "k8s-incident-agent",
    );
    assert.equal(ingress.spec.ingressClassName, "traefik");
    assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, "incident-console");
  }

  for (const [profile, expectedMode] of [
    [kind, "manual"],
    [evaluation, "manual"],
    [online, "online"],
  ]) {
    for (const name of ["agent-runtime-config", "incident-console-config"]) {
      assert.equal(
        Object.hasOwn(
          getResource(
            profile,
            "ConfigMap",
            name,
            "k8s-incident-agent",
          ).data,
          "INCIDENT_INTAKE_MODE",
        ),
        false,
      );
    }
    for (const [deploymentName, containerName] of [
      ["agent-runtime", "runtime"],
      ["incident-console", "console"],
    ]) {
      const deployment = getResource(
        profile,
        "Deployment",
        deploymentName,
        "k8s-incident-agent",
      );
      const container = deployment.spec.template.spec.containers.find(
        (candidate) => candidate.name === containerName,
      );
      assert.equal(
        container.env.find((entry) => entry.name === "INCIDENT_INTAKE_MODE")
          ?.value,
        expectedMode,
      );
    }
  }

  assert.notDeepEqual(
    getResource(
      evaluation,
      "Deployment",
      "agent-runtime",
      "k8s-incident-agent",
    ).spec.template,
    getResource(
      online,
      "Deployment",
      "agent-runtime",
      "k8s-incident-agent",
    ).spec.template,
  );
  assert.notDeepEqual(
    getResource(
      evaluation,
      "Deployment",
      "incident-console",
      "k8s-incident-agent",
    ).spec.template,
    getResource(
      online,
      "Deployment",
      "incident-console",
      "k8s-incident-agent",
    ).spec.template,
  );
});

test("Runtime render preserves one-writer migration, storage, identity, and image contracts", () => {
  const resources = indexDocuments(render("overlays/k3s-evaluation"));
  const runtime = getResource(
    resources,
    "Deployment",
    "agent-runtime",
    "k8s-incident-agent",
  );
  assert.equal(runtime.spec.replicas, 1);
  assert.deepEqual(runtime.spec.strategy, { type: "Recreate" });
  const pod = runtime.spec.template.spec;
  assert.equal(pod.serviceAccountName, "agent-runtime");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(
    {
      fsGroup: pod.securityContext.fsGroup,
      fsGroupChangePolicy: pod.securityContext.fsGroupChangePolicy,
      runAsGroup: pod.securityContext.runAsGroup,
      runAsNonRoot: pod.securityContext.runAsNonRoot,
      runAsUser: pod.securityContext.runAsUser,
    },
    {
      fsGroup: 10001,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 10001,
      runAsNonRoot: true,
      runAsUser: 10001,
    },
  );
  assert.equal(pod.initContainers.length, 1);
  assert.deepEqual(pod.initContainers[0].command, ["alembic", "upgrade", "head"]);
  assert.equal(pod.initContainers[0].image, RUNTIME_IMAGE);
  assert.equal(pod.containers[0].image, RUNTIME_IMAGE);
  assert.deepEqual(pod.initContainers[0].volumeMounts, [
    { mountPath: "/var/lib/k8s-incident-agent", name: "runtime-data" },
  ]);
  assert.equal(
    pod.containers[0].volumeMounts.find((mount) => mount.name === "runtime-data").mountPath,
    "/var/lib/k8s-incident-agent",
  );
  assert.deepEqual(
    pod.volumes.find((volume) => volume.name === "runtime-data").persistentVolumeClaim,
    { claimName: "runtime-data" },
  );
  const projected = pod.volumes.find(
    (volume) => volume.name === "kubernetes-api-access",
  ).projected;
  assert.equal(projected.defaultMode, 0o440);
  assert.deepEqual(projected.sources, [
    { serviceAccountToken: { expirationSeconds: 600, path: "token" } },
    {
      configMap: {
        items: [{ key: "ca.crt", path: "ca.crt" }],
        name: "kube-root-ca.crt",
      },
    },
    {
      downwardAPI: {
        items: [
          {
            fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" },
            path: "namespace",
          },
        ],
      },
    },
  ]);
  assert.deepEqual(pod.containers[0].env, [
    {
      name: "INCIDENT_INTAKE_MODE",
      value: "manual",
    },
    {
      name: "DEEPSEEK_API_KEY",
      valueFrom: {
        secretKeyRef: { key: "api-key", name: "agent-runtime-model" },
      },
    },
  ]);
  assert.equal(
    [...resources.values()].some((resource) => resource.kind === "Secret"),
    false,
  );
});

test("Kind render prepares only the fixed hostPath root before non-root migration", () => {
  const resources = indexDocuments(render("overlays/kind-evaluation"));
  const runtime = getResource(
    resources,
    "Deployment",
    "agent-runtime",
    "k8s-incident-agent",
  );
  const [prepare, migrate] = runtime.spec.template.spec.initContainers;
  assert.equal(prepare.name, "prepare-kind-volume");
  assert.equal(prepare.image, RUNTIME_IMAGE);
  assert.deepEqual(prepare.command, [
    "/usr/bin/chown",
    "10001:10001",
    "/var/lib/k8s-incident-agent",
  ]);
  assert.deepEqual(prepare.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { add: ["CHOWN"], drop: ["ALL"] },
    readOnlyRootFilesystem: true,
    runAsGroup: 0,
    runAsNonRoot: false,
    runAsUser: 0,
  });
  assert.deepEqual(prepare.volumeMounts, [
    { mountPath: "/var/lib/k8s-incident-agent", name: "runtime-data" },
  ]);
  assert.equal(migrate.name, "migrate");
  assert.equal(migrate.image, RUNTIME_IMAGE);
  assert.deepEqual(migrate.command, ["alembic", "upgrade", "head"]);
  assert.equal(runtime.spec.template.spec.securityContext.runAsUser, 10001);
});

test("Console and Runtime exposure and RBAC stay within the fixed read-only boundary", () => {
  const resources = indexDocuments(render("overlays/k3s-online"));
  const console = getResource(
    resources,
    "Deployment",
    "incident-console",
    "k8s-incident-agent",
  );
  assert.equal(console.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(console.spec.template.spec.containers[0].image, CONSOLE_IMAGE);
  assert.equal(
    console.spec.template.spec.volumes?.some((volume) =>
      Object.hasOwn(volume, "projected"),
    ) ?? false,
    false,
  );
  for (const name of ["incident-console", "agent-runtime"]) {
    assert.equal(
      getResource(resources, "Service", name, "k8s-incident-agent").spec.type,
      "ClusterIP",
    );
  }
  const ingress = getResource(
    resources,
    "Ingress",
    "incident-console",
    "k8s-incident-agent",
  );
  assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, "incident-console");
  assert.equal(
    JSON.stringify(ingress).includes("agent-runtime"),
    false,
  );

  const role = getResource(
    resources,
    "Role",
    "diagnostic-agent-read",
    "k8s-incident-scenarios",
  );
  assert.deepEqual(
    role.rules
      .map(({ apiGroups, resources: names, verbs }) => ({
        apiGroups,
        resources: names,
        verbs,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [
      { apiGroups: [""], resources: ["pods"], verbs: ["list"] },
      { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
      { apiGroups: [""], resources: ["services"], verbs: ["get"] },
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["list"] },
      { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["list"] },
      { apiGroups: ["events.k8s.io"], resources: ["events"], verbs: ["list"] },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
  assert.deepEqual(
    getResource(
      resources,
      "RoleBinding",
      "diagnostic-agent-read",
      "k8s-incident-scenarios",
    ).subjects,
    [
      {
        kind: "ServiceAccount",
        name: "agent-runtime",
        namespace: "k8s-incident-agent",
      },
    ],
  );
});

test("managed monitoring render pins topology, collection, rule, and credential boundaries", () => {
  const resources = indexDocuments(render("overlays/k3s-evaluation"));
  const expected = [
    ["prometheus", PROMETHEUS_IMAGE, false],
    ["alertmanager", ALERTMANAGER_IMAGE, false],
    ["kube-state-metrics", KUBE_STATE_METRICS_IMAGE, true],
  ];
  for (const [name, image, automount] of expected) {
    const deployment = getResource(
      resources,
      "Deployment",
      name,
      "k8s-incident-monitoring",
    );
    assert.equal(deployment.spec.replicas, 1);
    assert.equal(deployment.spec.template.spec.serviceAccountName, name);
    assert.equal(
      deployment.spec.template.spec.automountServiceAccountToken,
      automount,
    );
    assert.equal(deployment.spec.template.spec.containers[0].image, image);
    assert.deepEqual(
      deployment.spec.template.spec.containers[0].securityContext.capabilities,
      { drop: ["ALL"] },
    );
    assert.equal(
      deployment.spec.template.spec.containers[0].securityContext
        .readOnlyRootFilesystem,
      true,
    );
  }

  const kubeStateMetrics = getResource(
    resources,
    "Deployment",
    "kube-state-metrics",
    "k8s-incident-monitoring",
  ).spec.template.spec.containers[0];
  assert.deepEqual(kubeStateMetrics.args, [
    "--namespaces=k8s-incident-scenarios",
    "--resources=deployments,endpointslices,pods,replicasets,services",
    "--metric-allowlist=kube_deployment_spec_replicas,kube_deployment_status_replicas_available,kube_endpointslice_endpoints,kube_endpointslice_labels,kube_pod_container_status_ready,kube_pod_container_status_restarts_total,kube_pod_container_status_running,kube_pod_container_status_waiting_reason,kube_pod_labels,kube_pod_owner,kube_replicaset_owner,kube_service_info,kube_service_labels,kube_service_spec_type",
    "--metric-labels-allowlist=endpointslices=[kubernetes.io/service-name],pods=[k8s-incident-agent.io/liveness-container,k8s-incident-agent.io/readiness-container,k8s-incident-agent.io/readiness-slo,k8s-incident-agent.io/service],services=[k8s-incident-agent.io/monitor-selector]",
    "--use-apiserver-cache",
  ]);

  const role = getResource(
    resources,
    "Role",
    "managed-monitoring-read",
    "k8s-incident-scenarios",
  );
  assert.deepEqual(role.rules, [
    {
      apiGroups: [""],
      resources: ["pods", "services"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["apps"],
      resources: ["deployments", "replicasets"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["discovery.k8s.io"],
      resources: ["endpointslices"],
      verbs: ["get", "list", "watch"],
    },
  ]);
  assert.deepEqual(
    getResource(
      resources,
      "RoleBinding",
      "managed-monitoring-read",
      "k8s-incident-scenarios",
    ).subjects,
    [
      {
        kind: "ServiceAccount",
        name: "kube-state-metrics",
        namespace: "k8s-incident-monitoring",
      },
    ],
  );

  const prometheusConfig = load(
    getResource(
      resources,
      "ConfigMap",
      "prometheus-config",
      "k8s-incident-monitoring",
    ).data["prometheus.yaml"],
  );
  assert.deepEqual(prometheusConfig.storage.tsdb.retention, {
    time: "24h",
    size: "1GB",
  });
  assert.equal(prometheusConfig.global.scrape_interval, "15s");
  assert.equal(prometheusConfig.global.evaluation_interval, "15s");

  const rules = load(
    getResource(
      resources,
      "ConfigMap",
      "prometheus-rules",
      "k8s-incident-monitoring",
    ).data["alerts.yaml"],
  ).groups[0].rules;
  assert.deepEqual(
    rules.map((rule) => rule.alert),
    [
      "Watchdog",
      "K8sIncidentImagePullBackOff",
      "K8sIncidentCrashLoopBackOff",
      "K8sIncidentDeploymentReplicasUnavailable",
      "K8sIncidentServiceEndpointsUnavailable",
      "K8sIncidentReadinessProbeFailure",
      "K8sIncidentLivenessProbeRestart",
    ],
  );
  assert.deepEqual(rules[0], {
    alert: "Watchdog",
    expr: "vector(1)",
    labels: { severity: "none" },
  });
  assert.equal(rules[1].for, "30s");
  assert.deepEqual(rules[1].labels, { severity: "warning" });
  assert.equal(rules[2].for, "30s");
  assert.match(
    rules[2].expr,
    /kube_pod_container_status_restarts_total/,
  );
  assert.deepEqual(rules[2].labels, { severity: "warning" });
  assert.equal(rules[3].for, "5m");
  assert.match(rules[3].expr, /kube_deployment_spec_replicas/);
  assert.match(rules[3].expr, /kube_deployment_status_replicas_available/);
  assert.deepEqual(rules[3].labels, { severity: "warning" });
  assert.equal(rules[4].for, "30s");
  assert.match(rules[4].expr, /kube_service_labels/);
  assert.match(rules[4].expr, /kube_endpointslice_endpoints/);
  assert.deepEqual(rules[4].labels, { severity: "warning" });
  assert.equal(rules[5].for, "2m");
  assert.match(rules[5].expr, /kube_pod_container_status_ready == bool 0/);
  assert.match(rules[5].expr, /kube_pod_container_status_running == 1/);
  assert.match(
    rules[5].expr,
    /label_k8s_incident_agent_io_readiness_container/,
    /label_k8s_incident_agent_io_readiness_slo="2m"/,
  );
  assert.deepEqual(rules[5].labels, { severity: "warning" });
  assert.equal(rules[6].for, "30s");
  assert.match(
    rules[6].expr,
    /increase\(kube_pod_container_status_restarts_total\[5m\]\) > 0/,
  );
  assert.match(
    rules[6].expr,
    /label_k8s_incident_agent_io_liveness_container/,
  );
  assert.deepEqual(rules[6].labels, { severity: "warning" });

  const alertmanager = load(
    getResource(
      resources,
      "ConfigMap",
      "alertmanager-config",
      "k8s-incident-monitoring",
    ).data["alertmanager.yaml"],
  );
  assert.deepEqual(alertmanager.inhibit_rules, [
    {
      source_matchers: [
        'alertname=~"K8sIncidentImagePullBackOff|K8sIncidentCrashLoopBackOff|K8sIncidentReadinessProbeFailure|K8sIncidentLivenessProbeRestart"',
      ],
      target_matchers: [
        'alertname="K8sIncidentDeploymentReplicasUnavailable"',
      ],
      equal: ["cluster", "namespace", "deployment"],
    },
  ]);
  const webhook = alertmanager.receivers[0].webhook_configs[0];
  assert.equal(webhook.send_resolved, true);
  assert.equal(webhook.max_alerts, 0);
  assert.equal(webhook.timeout, "10s");
  assert.equal(
    webhook.http_config.authorization.credentials_file,
    "/etc/alertmanager/secrets/webhook/token",
  );
  assert.equal(
    [...resources.values()].some((resource) => resource.kind === "Secret"),
    false,
  );
});

test("monitoring storage is retained and Kind alone prepares its fixed hostPath", () => {
  const kind = indexDocuments(render("overlays/kind-evaluation"));
  const k3s = indexDocuments(render("overlays/k3s-evaluation"));
  const kindPvc = getResource(
    kind,
    "PersistentVolumeClaim",
    "prometheus-data",
    "k8s-incident-monitoring",
  );
  assert.equal(
    kindPvc.spec.storageClassName,
    "k8s-incident-agent-monitoring-kind",
  );
  assert.equal(kindPvc.spec.volumeName, "k8s-incident-agent-prometheus-data");
  const kindPv = getResource(
    kind,
    "PersistentVolume",
    "k8s-incident-agent-prometheus-data",
  );
  assert.equal(kindPv.spec.persistentVolumeReclaimPolicy, "Retain");
  assert.equal(
    kindPv.spec.hostPath.path,
    "/var/local/k8s-incident-monitoring",
  );
  const [prepare] = getResource(
    kind,
    "Deployment",
    "prometheus",
    "k8s-incident-monitoring",
  ).spec.template.spec.initContainers;
  assert.equal(prepare.image, RUNTIME_IMAGE);
  assert.deepEqual(prepare.command, [
    "/usr/bin/chown",
    "65534:65534",
    "/prometheus",
  ]);
  assert.equal(
    getResource(
      k3s,
      "Deployment",
      "prometheus",
      "k8s-incident-monitoring",
    ).spec.template.spec.initContainers,
    undefined,
  );
  assert.equal(
    getResource(
      k3s,
      "PersistentVolumeClaim",
      "prometheus-data",
      "k8s-incident-monitoring",
    ).spec.storageClassName,
    "local-path",
  );
});

test("NetworkPolicy render has default deny plus only the required L3/L4 paths", () => {
  const resources = indexDocuments(render("overlays/k3s-evaluation"));
  const applicationPolicies = [...resources.values()].filter(
    (resource) =>
      resource.kind === "NetworkPolicy" &&
      resource.metadata.namespace === "k8s-incident-agent",
  );
  assert.deepEqual(
    applicationPolicies.map((policy) => policy.metadata.name).sort(),
    [
      "allow-alertmanager-to-runtime",
      "allow-console-runtime-egress",
      "allow-console-to-runtime",
      "allow-dns-egress",
      "allow-runtime-https-egress",
      "allow-runtime-prometheus-egress",
      "allow-traefik-to-console",
      "default-deny",
    ],
  );
  const monitoringPolicies = [...resources.values()].filter(
    (resource) =>
      resource.kind === "NetworkPolicy" &&
      resource.metadata.namespace === "k8s-incident-monitoring",
  );
  assert.deepEqual(
    monitoringPolicies.map((policy) => policy.metadata.name).sort(),
    [
      "allow-alertmanager-runtime-egress",
      "allow-dns-egress",
      "allow-kube-state-metrics-api-egress",
      "allow-prometheus-alertmanager-egress",
      "allow-prometheus-kube-state-metrics-egress",
      "allow-prometheus-to-alertmanager",
      "allow-prometheus-to-kube-state-metrics",
      "allow-runtime-to-prometheus",
      "default-deny",
    ],
  );
  assert.deepEqual(
    getResource(
      resources,
      "NetworkPolicy",
      "default-deny",
      "k8s-incident-agent",
    ).spec,
    { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  );
  const dns = getResource(
    resources,
    "NetworkPolicy",
    "allow-dns-egress",
    "k8s-incident-agent",
  );
  assert.deepEqual(
    dns.spec.egress[0].ports,
    [
      { port: 53, protocol: "UDP" },
      { port: 53, protocol: "TCP" },
    ],
  );
  const https = getResource(
    resources,
    "NetworkPolicy",
    "allow-runtime-https-egress",
    "k8s-incident-agent",
  );
  assert.deepEqual(https.spec.egress, [
    {
      ports: [
        { port: 443, protocol: "TCP" },
        { port: 6443, protocol: "TCP" },
      ],
    },
  ]);
});

test("uninstall renders only non-data resources and never a Namespace or volume", () => {
  for (const profile of ["uninstall/kind", "uninstall/k3s"]) {
    const rendered = render(profile);
    assert.equal(rendered, render(profile));
    const resources = documents(rendered);
    indexDocuments(rendered);
    assert.equal(
      resources.some((resource) =>
        ["Namespace", "PersistentVolume", "PersistentVolumeClaim"].includes(
          resource.kind,
        ),
      ),
      false,
    );
    assert.equal(
      resources
        .flatMap((resource) => resource.spec?.template?.spec?.containers ?? [])
        .every((container) => container.image?.includes("@sha256:")),
      true,
    );
  }
});

test("K3s producer contract stays exact and does not duplicate the kubectl pin", () => {
  const contract = JSON.parse(
    readFileSync(path.join(APPLICATION_ROOT, "versions.json"), "utf8"),
  );
  assert.deepEqual(contract, {
    k3s: "v1.36.2+k3s1",
    kubernetes: "v1.36.2",
    components: {
      coredns: "v1.14.4",
      localPathProvisioner: "v0.0.36",
      traefik: "v3.7.4",
    },
    monitoring: {
      prometheus: {
        version: "v3.13.1",
        repository: "quay.io/prometheus/prometheus",
        digest:
          "sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893",
      },
      alertmanager: {
        version: "v0.34.0",
        repository: "quay.io/prometheus/alertmanager",
        digest:
          "sha256:690c7b525f4367aa91f73e2f91c632206d32e97c6384bdbf2fb7a861b420340d",
      },
      kubeStateMetrics: {
        version: "v2.20.0",
        repository:
          "registry.k8s.io/kube-state-metrics/kube-state-metrics",
        digest:
          "sha256:42cfe3723a5f058171c627537fb57a3ea0f26e4380fa18555a95cb1a1b4cfc5b",
      },
    },
  });
  assert.equal(Object.hasOwn(contract, "kubectl"), false);
});

function runDeployment(args, environment = {}) {
  return spawnSync(process.execPath, [DEPLOYMENT_SCRIPT, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function createFakeKubectl(t, overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deployment-kubectl-"));
  const logPath = path.join(directory, "calls.jsonl");
  const statePath = path.join(directory, "state.json");
  writeFileSync(logPath, "");
  writeFileSync(
    statePath,
    JSON.stringify({ job: null, pods: [], policyPresent: false, sequence: 0 }),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "kubectl");
  const rendered = {
    k3s: indexDocuments(render("overlays/k3s-online")),
    kind: indexDocuments(render("overlays/kind-evaluation")),
  };
  const resourceFixtures = Object.fromEntries(
    Object.entries(rendered).map(([profile, resources]) => [
      profile,
      Object.fromEntries(resources),
    ]),
  );
  const networkPolicyFixtures = Object.fromEntries(
    Object.entries(rendered).map(([profile, resources]) => [
      profile,
      Object.fromEntries(
        ["k8s-incident-agent", "k8s-incident-monitoring"].map((namespace) => [
          namespace,
          [...resources.values()].filter(
            (resource) =>
              resource.kind === "NetworkPolicy" &&
              resource.metadata.namespace === namespace,
          ),
        ]),
      ),
    ]),
  );
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify({ args, input }) + "\\n");
  const contextIndex = args.indexOf("--context");
  const commandArgs = contextIndex === -1 ? args : args.slice(contextIndex + 2);
  const key = commandArgs.join(" ");
  const output = response(key, commandArgs);
  if (output === undefined) {
    process.stderr.write("unexpected fake kubectl command");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(typeof output === "string" ? output : JSON.stringify(output));
});

const resourceFixtures = ${JSON.stringify(resourceFixtures)};
const networkPolicyFixtures = ${JSON.stringify(networkPolicyFixtures)};
const lockedImages = ${JSON.stringify([CONSOLE_IMAGE, RUNTIME_IMAGE])};

function state() {
  return JSON.parse(readFileSync(process.env.FAKE_KUBECTL_STATE, "utf8"));
}

function saveState(value) {
  writeFileSync(process.env.FAKE_KUBECTL_STATE, JSON.stringify(value));
}

function fixture(kind, name, namespace) {
  const profile = process.env.FAKE_PROFILE === "kind-evaluation" ? "kind" : "k3s";
  return structuredClone(resourceFixtures[profile][kind + "/" + namespace + "/" + name]);
}

function deployment(name, namespace = "k8s-incident-agent") {
  const document = fixture("Deployment", name, namespace);
  if (
    namespace === "k8s-incident-agent" &&
    process.env.FAKE_DEPLOYMENT_INTAKE_MODE
  ) {
    const container = document.spec.template.spec.containers[0];
    container.env.find((entry) => entry.name === "INCIDENT_INTAKE_MODE").value = process.env.FAKE_DEPLOYMENT_INTAKE_MODE;
  }
  if (process.env.FAKE_MONITORING_IMAGE_DRIFT === name) {
    document.spec.template.spec.containers[0].image = "registry.example/changed@sha256:" + "f".repeat(64);
  }
  if (process.env.FAKE_MONITORING_PROBE_DRIFT === name) {
    document.spec.template.spec.containers[0].readinessProbe.httpGet.path = "/wrong";
  }
  if (process.env.FAKE_MONITORING_CONFIG_DIGEST_DRIFT === name) {
    document.spec.template.metadata.annotations["k8s-incident-agent.io/config-digest"] = "sha256:" + "f".repeat(64);
  }
  document.metadata.generation = 3;
  document.status = { observedGeneration: 3, replicas: 1, updatedReplicas: 1, availableReplicas: 1 };
  return document;
}

function admittedCutoverJob(document, uid) {
  const job = structuredClone(document);
  job.metadata.uid = uid;
  job.metadata.resourceVersion = "1";
  job.status = {};
  return job;
}

function gatedCutoverPod(job, name, uid) {
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: "k8s-incident-agent",
      uid,
      resourceVersion: "1",
      labels: {
        ...job.spec.template.metadata.labels,
        "batch.kubernetes.io/job-name": "runtime-data-cutover",
      },
      ownerReferences: [{
        apiVersion: "batch/v1",
        kind: "Job",
        name: "runtime-data-cutover",
        uid: job.metadata.uid,
        controller: true,
        blockOwnerDeletion: true,
      }],
    },
    spec: structuredClone(job.spec.template.spec),
    status: {
      phase: "Pending",
      conditions: [{
        type: "PodScheduled",
        status: "False",
        reason: "SchedulingGated",
      }],
    },
  };
  pod.spec.serviceAccountName = "default";
  pod.spec.tolerations = [
    {
      key: "node.kubernetes.io/not-ready",
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 300,
    },
    {
      key: "node.kubernetes.io/unreachable",
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 300,
    },
  ];
  if (process.env.FAKE_CUTOVER_GATE_MISSING === "1") {
    delete pod.spec.schedulingGates;
  }
  if (process.env.FAKE_CUTOVER_EXTRA_CONTAINER === "1") {
    pod.spec.containers.push({ name: "injected", image: "busybox:latest" });
  }
  if (process.env.FAKE_CUTOVER_INIT_DRIFT === "1") {
    pod.spec.initContainers[1].command = ["/usr/bin/false"];
  }
  return pod;
}

function runtimeOutput(command) {
  const mode = command[2] === "--preview" ? "preview" : "confirm";
  if (process.env.FAKE_CUTOVER_OUTPUT_MALFORMED === "1") return "not-json";
  if (process.env.FAKE_CUTOVER_JOB_FAILED === "1") {
    return {
      mode,
      error: { code: "reset_rejected", phase: "preflight" },
    };
  }
  const planDigest = mode === "preview"
    ? "sha256:" + "1".repeat(64)
    : command[3];
  return {
    mode,
    planDigest,
    sourceHead: "20260814_0001",
    state: "stage_one",
    targetHead: "20260901_0002",
    targets: {
      artifactRunIds: ["artifact-run-id"],
      businessFiles: ["incidents.sqlite3"],
      checkpointFiles: ["checkpoints.sqlite3"],
      rowCounts: { incidents: 1, agent_runs: 1 },
      runIds: ["run-id"],
    },
    ...(mode === "confirm" ? {
      deleted: {
        artifactRunIds: ["artifact-run-id"],
        businessFiles: ["incidents.sqlite3"],
        checkpointFiles: ["checkpoints.sqlite3"],
      },
      newHead: "20260901_0002",
      outcome: "reset",
    } : {}),
  };
}

function response(key, args) {
  if (key.startsWith("kustomize ")) {
    const result = spawnSync(process.env.REAL_KUBECTL, args, { encoding: "utf8" });
    if (result.status !== 0) process.exitCode = result.status;
    return result.stdout;
  }
  if (key === "version --client --output=json") {
    return { clientVersion: { gitVersion: process.env.FAKE_CLIENT_VERSION || "v1.36.2" } };
  }
  if (key === "version --output=json") {
    return { serverVersion: { gitVersion: process.env.FAKE_SERVER_VERSION || "v1.36.2+k3s1" } };
  }
  const component = key.match(/^get deployment (coredns|traefik|local-path-provisioner) --namespace kube-system --output=json$/);
  if (component) {
    const versions = { coredns: "1.14.4", traefik: "3.7.4", "local-path-provisioner": "0.0.36" };
    return {
      metadata: { generation: 2 },
      spec: { replicas: 1, template: { spec: { containers: [{ image: "registry.example/" + component[1] + ":" + versions[component[1]] }] } } },
      status: {
        observedGeneration: 2,
        replicas: 1,
        updatedReplicas: process.env.FAKE_COMPONENT_STALE_ROLLOUT === component[1] ? 0 : 1,
        availableReplicas: process.env.FAKE_COMPONENT_UNAVAILABLE === component[1] ? 0 : 1,
      },
    };
  }
  if (key === "get storageclass local-path --output=json") {
    return {
      metadata: { annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
      provisioner: "rancher.io/local-path",
    };
  }
  if (key === 'get secret agent-runtime-model --namespace k8s-incident-agent --output=go-template={{if index .data "api-key"}}present{{else}}missing{{end}}') {
    return process.env.FAKE_SECRET_MISSING === "1" ? "missing\\n" : "present\\n";
  }
  if (
    key === 'get secret alertmanager-webhook --namespace k8s-incident-agent --output=go-template={{if index .data "token"}}present{{else}}missing{{end}}' ||
    key === 'get secret alertmanager-webhook --namespace k8s-incident-monitoring --output=go-template={{if index .data "token"}}present{{else}}missing{{end}}'
  ) {
    return process.env.FAKE_WEBHOOK_SECRET_MISSING === "1"
      ? "missing\\n"
      : "present\\n";
  }
  if (key === "get nodes --output=json") {
    const availableImages = process.env.FAKE_IMAGE_MISSING === "1"
      ? lockedImages.slice(0, 1)
      : process.env.FAKE_CONSOLE_IMAGE_MISSING === "1"
        ? lockedImages.slice(1)
        : lockedImages;
    const imageRepository = process.env.FAKE_IMAGE_REPOSITORY_MISMATCH === "1"
      ? "registry.example/"
      : "docker.io/library/";
    return {
      kind: "List",
      items: [{
        metadata: { name: "single-node" },
        status: {
          conditions: [{ type: "Ready", status: "True" }],
          images: availableImages.map((name) => ({ names: [imageRepository + name] })),
        },
      }],
    };
  }
  if (key === "get namespace k8s-incident-agent --output=json") {
    return {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "k8s-incident-agent",
        uid: process.env.FAKE_NAMESPACE_UID || "namespace-uid",
        labels: { "app.kubernetes.io/part-of": "k8s-incident-agent" },
      },
    };
  }
  if (key === "get job runtime-data-cutover --namespace k8s-incident-agent --ignore-not-found=true --output=json") {
    const current = state();
    if (current.job !== null) return current.job;
    if (process.env.FAKE_CUTOVER_RESIDUE === "1") {
      return { apiVersion: "batch/v1", kind: "Job", metadata: { name: "runtime-data-cutover" } };
    }
    return "";
  }
  if (key === "get pods --namespace k8s-incident-agent --output=json") {
    const items = structuredClone(state().pods);
    if (process.env.FAKE_CUTOVER_OWNER_POD_ONLY === "1") {
      items.push({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "owner-only-residue",
          namespace: "k8s-incident-agent",
          ownerReferences: [{
            apiVersion: "batch/v1",
            kind: "Job",
            name: "runtime-data-cutover",
            uid: "deleted-job-uid",
            controller: true,
          }],
        },
      });
    }
    return { apiVersion: "v1", kind: "List", items };
  }
  if (
    key === "get mutatingwebhookconfigurations.admissionregistration.k8s.io --output=json" ||
    key === "get mutatingadmissionpolicies.admissionregistration.k8s.io --output=json" ||
    key === "get mutatingadmissionpolicybindings.admissionregistration.k8s.io --output=json"
  ) {
    const isWebhookCollection = key.startsWith("get mutatingwebhookconfigurations");
    const unrelatedWebhook = {
      metadata: { name: "cert-manager-webhook" },
      webhooks: [{
        name: "webhook.cert-manager.io",
        rules: [{
          apiGroups: ["cert-manager.io"],
          apiVersions: ["v1"],
          operations: ["CREATE", "UPDATE"],
          resources: ["certificaterequests"],
          scope: "Namespaced",
        }],
      }],
    };
    const relevantWebhook = {
      metadata: { name: "unexpected-mutator" },
      webhooks: [{
        name: "pods.example.test",
        rules: [{
          apiGroups: [""],
          apiVersions: ["v1"],
          operations: ["CREATE", "UPDATE"],
          resources: ["pods"],
          scope: "Namespaced",
        }],
      }],
    };
    let items = [];
    if (isWebhookCollection && process.env.FAKE_UNRELATED_CUTOVER_WEBHOOK === "1") {
      items = [unrelatedWebhook];
    } else if (isWebhookCollection && process.env.FAKE_CUTOVER_MUTATOR === "1") {
      items = [relevantWebhook];
    } else if (
      isWebhookCollection &&
      process.env.FAKE_MALFORMED_CUTOVER_WEBHOOK === "1"
    ) {
      items = [{ metadata: { name: "malformed-mutator" }, webhooks: [{}] }];
    } else if (
      isWebhookCollection &&
      process.env.FAKE_CUTOVER_WILDCARD_GROUP === "1"
    ) {
      items = [{
        metadata: { name: "wildcard-group-mutator" },
        webhooks: [{ rules: [{ apiGroups: ["*"], resources: ["certificaterequests"] }] }],
      }];
    } else if (
      isWebhookCollection &&
      process.env.FAKE_CUTOVER_WILDCARD_RESOURCE === "1"
    ) {
      items = [{
        metadata: { name: "wildcard-resource-mutator" },
        webhooks: [{ rules: [{ apiGroups: ["cert-manager.io"], resources: ["*"] }] }],
      }];
    } else if (
      isWebhookCollection &&
      process.env.FAKE_CUTOVER_EMPTY_GROUPS === "1"
    ) {
      items = [{
        metadata: { name: "empty-groups-mutator" },
        webhooks: [{ rules: [{ apiGroups: [], resources: ["certificaterequests"] }] }],
      }];
    } else if (
      isWebhookCollection &&
      process.env.FAKE_CUTOVER_EMPTY_RESOURCES === "1"
    ) {
      items = [{
        metadata: { name: "empty-resources-mutator" },
        webhooks: [{ rules: [{ apiGroups: ["cert-manager.io"], resources: [] }] }],
      }];
    } else if (
      key.startsWith("get mutatingadmissionpolicies") &&
      process.env.FAKE_CUTOVER_POLICY === "1"
    ) {
      items = [{ metadata: { name: "unexpected-mutator" } }];
    } else if (
      key.startsWith("get mutatingadmissionpolicybindings") &&
      process.env.FAKE_CUTOVER_POLICY_BINDING === "1"
    ) {
      items = [{ metadata: { name: "unexpected-mutator-binding" } }];
    }
    return { apiVersion: "v1", kind: "List", items };
  }
  if (
    key === "create --dry-run=server --output=json --filename=-" ||
    key === "create --output=json --filename=-"
  ) {
    const document = JSON.parse(input);
    const dryRun = key.includes("--dry-run=server");
    if (document.kind === "NetworkPolicy") {
      if (!dryRun) {
        const current = state();
        current.policyPresent = true;
        saveState(current);
      }
      return document;
    }
    if (document.kind === "Job") {
      if (dryRun) {
        const admitted = admittedCutoverJob(document, "dry-run-job-uid");
        if (process.env.FAKE_CUTOVER_JOB_ADMISSION_DRIFT === "1") {
          admitted.spec.template.spec.containers.push({
            name: "injected",
            image: "busybox:latest",
          });
        }
        if (process.env.FAKE_CUTOVER_JOB_NODENAME_DRIFT === "1") {
          admitted.spec.template.spec.nodeName = "single-node";
        }
        return admitted;
      }
      const current = state();
      current.sequence += 1;
      const job = admittedCutoverJob(document, "job-uid-" + current.sequence);
      const pod = gatedCutoverPod(
        job,
        "runtime-data-cutover-" + current.sequence,
        "pod-uid-" + current.sequence,
      );
      current.job = job;
      current.pods = [pod];
      if (process.env.FAKE_CUTOVER_MULTIPLE_PODS === "1") {
        const duplicate = structuredClone(pod);
        duplicate.metadata.name += "-duplicate";
        duplicate.metadata.uid += "-duplicate";
        current.pods.push(duplicate);
      }
      saveState(current);
      return job;
    }
  }
  if (
    key.startsWith("patch pod runtime-data-cutover-") &&
    args.includes("--type=json") &&
    args.includes("--patch") &&
    args.includes("--output=json")
  ) {
    const current = state();
    const pod = current.pods[0];
    const released = structuredClone(pod);
    released.metadata.resourceVersion = "2";
    released.spec.schedulingGates = [];
    const terminal = structuredClone(released);
    terminal.metadata.resourceVersion = "3";
    terminal.spec.nodeName = "single-node";
    const failed = process.env.FAKE_CUTOVER_JOB_FAILED === "1";
    terminal.status = {
      phase: failed ? "Failed" : "Succeeded",
      conditions: [{ type: "PodScheduled", status: "True" }],
      containerStatuses: [{
        name: "runtime-reset",
        ready: false,
        restartCount: 0,
        state: { terminated: { exitCode: failed ? 1 : 0 } },
      }],
    };
    if (process.env.FAKE_CUTOVER_POD_UID_REPLACED === "1") {
      terminal.metadata.uid = "replacement-pod-uid";
    }
    current.pods = [terminal];
    current.job.status = {
      conditions: [{
        type: failed ? "Failed" : "Complete",
        status: "True",
      }],
    };
    saveState(current);
    return released;
  }
  if (key.startsWith("logs pod/runtime-data-cutover-") && key.endsWith("--namespace k8s-incident-agent --container runtime-reset")) {
    const current = state();
    const output = runtimeOutput(current.job.spec.template.spec.containers[0].command);
    if (process.env.FAKE_CUTOVER_POD_UID_REPLACED_AFTER_LOG === "1") {
      current.pods[0].metadata.uid = "replacement-pod-uid-after-log";
      saveState(current);
    }
    return output;
  }
  if (key === "delete --raw /apis/batch/v1/namespaces/k8s-incident-agent/jobs/runtime-data-cutover --filename=-") {
    if (process.env.FAKE_CUTOVER_CLEANUP_FAILED === "1") {
      process.exitCode = 1;
      return "cleanup failed";
    }
    const current = state();
    current.job = null;
    current.pods = [];
    saveState(current);
    return {};
  }
  if (
    key === "wait --for=delete job/runtime-data-cutover --namespace k8s-incident-agent --timeout=300s" ||
    (key.startsWith("wait --for=delete pod/runtime-data-cutover-") &&
      key.endsWith("--namespace k8s-incident-agent --timeout=300s"))
  ) {
    return "ok\\n";
  }
  if (key === "get deployment agent-runtime --namespace k8s-incident-agent --output=json") {
    return deployment("agent-runtime");
  }
  if (key === "get deployment incident-console --namespace k8s-incident-agent --output=json") {
    return deployment("incident-console");
  }
  const monitoringDeployment = key.match(
    /^get deployment (prometheus|alertmanager|kube-state-metrics) --namespace k8s-incident-monitoring --output=json$/,
  );
  if (monitoringDeployment) {
    return deployment(monitoringDeployment[1], "k8s-incident-monitoring");
  }
  if (key === "get pods --namespace k8s-incident-agent --selector=app.kubernetes.io/part-of=k8s-incident-agent --output=json") {
    const pods = [
      ["agent-runtime", "runtime-current"],
      ["incident-console", "console-current"],
    ].map(([appName, name]) => ({
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/name": appName,
          "app.kubernetes.io/part-of": "k8s-incident-agent",
        },
      },
      status: { phase: "Running", containerStatuses: [{ ready: true }] },
    }));
    if (process.env.FAKE_TERMINATING_CONSOLE === "1") {
      pods.push({
        metadata: {
          name: "console-old",
          deletionTimestamp: "2026-08-31T00:00:00Z",
          labels: {
            "app.kubernetes.io/name": "incident-console",
            "app.kubernetes.io/part-of": "k8s-incident-agent",
          },
        },
        status: { phase: "Running", containerStatuses: [{ ready: false }] },
      });
    }
    return { kind: "List", items: pods };
  }
  if (key === "get pods --namespace k8s-incident-monitoring --selector=app.kubernetes.io/part-of=k8s-incident-agent --output=json") {
    const pods = ["prometheus", "alertmanager", "kube-state-metrics"].map(
      (appName) => ({
        metadata: {
          name: appName + "-current",
          labels: {
            "app.kubernetes.io/name": appName,
            "app.kubernetes.io/part-of": "k8s-incident-agent",
          },
        },
        status: {
          phase: "Running",
          containerStatuses: [{ ready: true }],
        },
      }),
    );
    if (process.env.FAKE_MONITORING_POD_UNREADY === "1") {
      pods[0].status.containerStatuses[0].ready = false;
    }
    return { kind: "List", items: pods };
  }
  const service = key.match(/^get service (agent-runtime|incident-console) --namespace k8s-incident-agent --output=json$/);
  if (service) {
    return {
      kind: "Service",
      metadata: { name: service[1], namespace: "k8s-incident-agent" },
      spec: {
        type: "ClusterIP",
        clusterIP: "10.43.0.20",
        selector: { "app.kubernetes.io/name": service[1] },
        ports: [{
          name: "http",
          port: service[1] === "agent-runtime" ? 8000 : 80,
          protocol: "TCP",
          targetPort: "http",
        }],
      },
    };
  }
  const monitoringService = key.match(
    /^get service (prometheus|alertmanager|kube-state-metrics) --namespace k8s-incident-monitoring --output=json$/,
  );
  if (monitoringService) {
    const document = fixture(
      "Service",
      monitoringService[1],
      "k8s-incident-monitoring",
    );
    document.spec.clusterIP = "10.43.0.30";
    return document;
  }
  if (key === "get persistentvolumeclaim runtime-data --namespace k8s-incident-agent --output=json" || key === "get persistentvolumeclaim runtime-data --namespace k8s-incident-agent --ignore-not-found=true --output=json") {
    const kind = process.env.FAKE_PROFILE === "kind-evaluation";
    return {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "runtime-data", namespace: "k8s-incident-agent", uid: "pvc-uid" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: process.env.FAKE_CUTOVER_STORAGE_DRIFT === "1"
          ? "unexpected"
          : kind ? "k8s-incident-agent-kind" : "local-path",
        volumeMode: "Filesystem",
        volumeName: kind ? "k8s-incident-agent-runtime-data" : "pvc-volume",
      },
      status: { phase: "Bound" },
    };
  }
  if (
    key === "get persistentvolumeclaim prometheus-data --namespace k8s-incident-monitoring --output=json" ||
    key === "get persistentvolumeclaim prometheus-data --namespace k8s-incident-monitoring --ignore-not-found=true --output=json"
  ) {
    const kind = process.env.FAKE_PROFILE === "kind-evaluation";
    const document = fixture(
      "PersistentVolumeClaim",
      "prometheus-data",
      "k8s-incident-monitoring",
    );
    document.metadata.uid = "prometheus-pvc-uid";
    document.spec.volumeName = kind
      ? "k8s-incident-agent-prometheus-data"
      : "prometheus-pvc-volume";
    document.status = { phase: "Bound" };
    if (process.env.FAKE_PROMETHEUS_PVC_DRIFT === "1") {
      document.spec.storageClassName = "unexpected";
    }
    return document;
  }
  if (key === "get configmap agent-runtime-config --namespace k8s-incident-agent --output=json" || key === "get configmap incident-console-config --namespace k8s-incident-agent --output=json") {
    const runtime = key.includes("agent-runtime-config");
    return {
      kind: "ConfigMap",
      metadata: {
        name: runtime ? "agent-runtime-config" : "incident-console-config",
        namespace: "k8s-incident-agent",
      },
      data: runtime
        ? {
          KUBERNETES_CLUSTER_ID: "k8s-incident-agent",
          KUBERNETES_CREDENTIAL_MODE: "in_cluster",
          KUBERNETES_DIAGNOSTIC_NAMESPACE: "k8s-incident-scenarios",
          RUNTIME_DATA_DIR: "/var/lib/k8s-incident-agent/runtime",
          SCENARIO_CATALOG_DIR: "/workspace/scenarios",
          ALERT_CATALOG_DIR: "/workspace/monitoring/catalog",
          ALERTMANAGER_WEBHOOK_TOKEN_FILE: "/var/run/secrets/k8s-incident-agent/alertmanager/token",
        }
        : {
          AGENT_RUNTIME_URL: "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000",
          YAML_ASSISTANT_URL: "/k8s-yaml-assistant",
        },
    };
  }
  const monitoringConfigMap = key.match(
    /^get configmap (prometheus-config|prometheus-rules|alertmanager-config) --namespace k8s-incident-monitoring --output=json$/,
  );
  if (monitoringConfigMap) {
    const document = fixture(
      "ConfigMap",
      monitoringConfigMap[1],
      "k8s-incident-monitoring",
    );
    if (process.env.FAKE_MONITORING_CONFIG_DRIFT === monitoringConfigMap[1]) {
      document.data[Object.keys(document.data)[0]] += "\\nchanged: true\\n";
    }
    return document;
  }
  if (key === "get networkpolicies --namespace k8s-incident-agent --output=json") {
    const profile = process.env.FAKE_PROFILE === "kind-evaluation" ? "kind" : "k3s";
    const current = state();
    const items = process.env.FAKE_CUTOVER === "1"
      ? current.policyPresent
        ? [structuredClone(networkPolicyFixtures[profile]["k8s-incident-agent"].find((item) => item.metadata.name === "default-deny"))]
        : []
      : structuredClone(networkPolicyFixtures[profile]["k8s-incident-agent"]);
    if (process.env.FAKE_NETWORK_POLICY_DRIFT === "1") {
      const defaultDeny = items.find((item) => item.metadata.name === "default-deny");
      if (defaultDeny) defaultDeny.spec.ingress = [{}];
      else items.push({ kind: "NetworkPolicy", metadata: { name: "unexpected" }, spec: {} });
    }
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "List",
      items,
    };
  }
  if (key === "get networkpolicies --namespace k8s-incident-monitoring --output=json") {
    const profile = process.env.FAKE_PROFILE === "kind-evaluation" ? "kind" : "k3s";
    const items = structuredClone(
      networkPolicyFixtures[profile]["k8s-incident-monitoring"],
    );
    if (process.env.FAKE_MONITORING_NETWORK_POLICY_DRIFT === "1") {
      items[0].spec.ingress = [{}];
    }
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "List",
      items,
    };
  }
  if (key === "get role managed-monitoring-read --namespace k8s-incident-scenarios --output=json") {
    const document = fixture(
      "Role",
      "managed-monitoring-read",
      "k8s-incident-scenarios",
    );
    if (process.env.FAKE_MONITORING_RBAC_DRIFT === "1") {
      document.rules[0].resources.push("secrets");
    }
    return document;
  }
  if (key === "get rolebinding managed-monitoring-read --namespace k8s-incident-scenarios --output=json") {
    return fixture(
      "RoleBinding",
      "managed-monitoring-read",
      "k8s-incident-scenarios",
    );
  }
  if (key === "get ingress incident-console --namespace k8s-incident-agent --output=json") {
    return {
      kind: "Ingress",
      metadata: { name: "incident-console", namespace: "k8s-incident-agent" },
      spec: {
        ingressClassName: "traefik",
        rules: [{ http: { paths: [{ backend: { service: { name: "incident-console", port: { name: "http" } } } }] } }],
      },
      status: {
        loadBalancer: {
          ingress: process.env.FAKE_INGRESS_UNAVAILABLE === "1" ? [] : [{ ip: "192.0.2.10" }],
        },
      },
    };
  }
  if (key.startsWith("auth can-i ")) {
    const monitoringReader = key.includes(
      "--as=system:serviceaccount:k8s-incident-monitoring:kube-state-metrics",
    );
    if (
      process.env.FAKE_MONITORING_RBAC_ALLOW_DRIFT === "1" &&
      monitoringReader &&
      (" " + key + " ").includes(" get secrets ")
    ) {
      return "yes\\n";
    }
    if (
      (key.includes(
        "--as=system:serviceaccount:k8s-incident-monitoring:prometheus",
      ) ||
        key.includes(
          "--as=system:serviceaccount:k8s-incident-monitoring:alertmanager",
        )) &&
      (" " + key + " ").includes(" list pods ")
    ) {
      process.exitCode = 1;
      return "no\\n";
    }
    const denied = [
      " get secrets ",
      " list configmaps ",
      " list persistentvolumes ",
      " create pods ",
      " create deployments.apps ",
      " update deployments.apps ",
      " patch deployments.apps ",
      " delete deployments.apps ",
    ];
    if (denied.some((needle) => (" " + key + " ").includes(needle))) {
      process.exitCode = 1;
      return "no\\n";
    }
    return "yes\\n";
  }
  if (key.startsWith("apply ") || key.startsWith("rollout status ") || key.startsWith("delete --ignore-not-found=true ") || key.startsWith("wait --for=delete ")) return "ok\\n";
  if (key === "get deployments.apps,replicasets.apps,statefulsets.apps,daemonsets.apps,jobs.batch,cronjobs.batch,replicationcontrollers,pods --namespace k8s-incident-agent --ignore-not-found=true --output=name") {
    return process.env.FAKE_ACTIVE_WORKLOAD === "1" ? "pod/agent-runtime-active\\n" : "";
  }
  if (key === "get persistentvolume pvc-volume --output=json") {
    return {
      apiVersion: "v1",
      kind: "PersistentVolume",
      metadata: { name: "pvc-volume", uid: "pv-uid" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        claimRef: { uid: "pvc-uid", name: "runtime-data", namespace: "k8s-incident-agent" },
        persistentVolumeReclaimPolicy: "Delete",
        storageClassName: "local-path",
        volumeMode: "Filesystem",
      },
    };
  }
  if (key === "get persistentvolume k8s-incident-agent-runtime-data --output=json") {
    return {
      apiVersion: "v1",
      kind: "PersistentVolume",
      metadata: { name: "k8s-incident-agent-runtime-data", uid: "kind-pv-uid" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        claimRef: { uid: "pvc-uid", name: "runtime-data", namespace: "k8s-incident-agent" },
        hostPath: { path: "/var/local/k8s-incident-agent", type: "DirectoryOrCreate" },
        persistentVolumeReclaimPolicy: "Retain",
        storageClassName: "k8s-incident-agent-kind",
        volumeMode: "Filesystem",
      },
    };
  }
  if (key === "delete --raw /api/v1/namespaces/k8s-incident-agent/persistentvolumeclaims/runtime-data --filename=-") return "{}";
  return undefined;
}
`,
    "utf8",
  );
  chmodSync(executable, 0o755);
  return {
    environment: {
      FAKE_KUBECTL_LOG: logPath,
      FAKE_KUBECTL_STATE: statePath,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      REAL_KUBECTL,
      ...overrides,
    },
    calls() {
      const content = readFileSync(logPath, "utf8");
      return content.trim() === ""
        ? []
        : content.trim().split("\n").map((line) => JSON.parse(line));
    },
  };
}

function createdResources(calls, kind) {
  return calls
    .filter(
      (call) =>
        call.args.includes("create") &&
        !call.args.includes("--dry-run=server") &&
        call.input !== "",
    )
    .map((call) => JSON.parse(call.input))
    .filter((document) => document.kind === kind);
}

test("cutover manifest is a fixed tokenless single-Pod reset Job", () => {
  const [job] = documents(
    readFileSync(path.join(APPLICATION_ROOT, "cutover", "job.yaml"), "utf8"),
  );
  assert.equal(job.kind, "Job");
  assert.equal(job.metadata.name, "runtime-data-cutover");
  assert.equal(job.metadata.namespace, "k8s-incident-agent");
  assert.deepEqual(
    {
      parallelism: job.spec.parallelism,
      completions: job.spec.completions,
      backoffLimit: job.spec.backoffLimit,
      activeDeadlineSeconds: job.spec.activeDeadlineSeconds,
    },
    {
      parallelism: 1,
      completions: 1,
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
    },
  );
  const pod = job.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.restartPolicy, "Never");
  assert.deepEqual(pod.schedulingGates, [
    { name: "k8s-incident-agent.io/runtime-data-cutover" },
  ]);
  assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
  assert.deepEqual(
    pod.initContainers.map((container) => ({
      name: container.name,
      image: container.image,
      command: container.command,
    })),
    [
      {
        name: "validate-runtime-data-root",
        image: "k8s-incident-agent-runtime",
        command: [
          "/usr/bin/test",
          "!",
          "-L",
          "/var/lib/k8s-incident-agent/runtime",
        ],
      },
      {
        name: "tighten-runtime-data-permissions",
        image: "k8s-incident-agent-runtime",
        command: [
          "/usr/bin/chmod",
          "--recursive",
          "u=rwX,go=,a-s",
          "/var/lib/k8s-incident-agent/runtime",
        ],
      },
    ],
  );
  assert.equal(pod.containers.length, 1);
  assert.deepEqual(pod.containers[0].command, [
    "runtime",
    "reset-stage-one-data",
    "--preview",
  ]);
  assert.deepEqual(pod.volumes, [
    {
      name: "runtime-data",
      persistentVolumeClaim: { claimName: "runtime-data" },
    },
  ]);
  const serialized = JSON.stringify(job);
  for (const forbidden of [
    "serviceAccountName",
    "secretKeyRef",
    "configMapRef",
    "hostPath",
    "/bin/sh",
    "agent-runtime-model",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("cutover rejects every open or malformed CLI shape before kubectl", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CUTOVER: "1" });
  const cases = [
    ["cutover", "k3s-online", "--context", "demo-k3s", "--preview"],
    ["cutover", "k3s-evaluation", "--preview"],
    ["cutover", "k3s-evaluation", "--context", "--kubeconfig=x", "--preview"],
    ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview", "extra"],
    ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--confirm", "bad"],
    ["cutover", "kind-evaluation", "--context", "other-kind", "--preview"],
  ];
  for (const args of cases) {
    const result = runDeployment(args, fake.environment);
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stderr}`);
  }
  assert.deepEqual(fake.calls(), []);
});

test("cutover preview creates isolation, releases only the admitted gated Pod, and cleans by UID", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CUTOVER: "1" });
  const result = runDeployment(
    ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "preview");
  assert.equal(output.profile, "k3s-evaluation");
  assert.match(output.confirmation, /^cutover:v1:sha256:[a-f0-9]{64}$/);
  assert.deepEqual(output.reset, {
    sourceHead: "20260814_0001",
    targetHead: "20260901_0002",
    state: "stage_one",
    rowCounts: { incidents: 1, agent_runs: 1 },
    businessFileCount: 1,
    checkpointFileCount: 1,
    runCount: 1,
    artifactRunCount: 1,
    planDigest: `sha256:${"1".repeat(64)}`,
  });
  assert.equal(result.stdout.includes("run-id"), false);
  assert.equal(result.stdout.includes("incidents.sqlite3"), false);

  const calls = fake.calls();
  assert.equal(createdResources(calls, "NetworkPolicy").length, 1);
  const jobs = createdResources(calls, "Job");
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].spec.template.spec.containers[0].command, [
    "runtime",
    "reset-stage-one-data",
    "--preview",
  ]);
  const patchCall = calls.find((call) => call.args.includes("--patch"));
  assert.ok(patchCall);
  const patchIndex = patchCall.args.indexOf("--patch");
  assert.deepEqual(JSON.parse(patchCall.args[patchIndex + 1]), [
    { op: "test", path: "/metadata/uid", value: "pod-uid-1" },
    { op: "test", path: "/metadata/resourceVersion", value: "1" },
    {
      op: "test",
      path: "/spec/schedulingGates",
      value: [{ name: "k8s-incident-agent.io/runtime-data-cutover" }],
    },
    { op: "remove", path: "/spec/schedulingGates/0" },
  ]);
  const cleanup = calls.find((call) =>
    call.args.includes(
      "/apis/batch/v1/namespaces/k8s-incident-agent/jobs/runtime-data-cutover",
    ),
  );
  assert.ok(cleanup);
  assert.deepEqual(JSON.parse(cleanup.input), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: "job-uid-1" },
    propagationPolicy: "Foreground",
  });
});

test("Kind cutover uses the fixed context, hostPath PV identity, and only the Runtime image", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_CONSOLE_IMAGE_MISSING: "1",
    FAKE_CUTOVER: "1",
    FAKE_PROFILE: "kind-evaluation",
    FAKE_SERVER_VERSION: "v1.36.1",
  });
  const result = runDeployment(
    [
      "cutover",
      "kind-evaluation",
      "--context",
      "kind-k8s-incident-agent",
      "--preview",
    ],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.cluster.serverVersion, "v1.36.1");
  assert.equal(output.storage.volumeName, "k8s-incident-agent-runtime-data");
  assert.equal(output.storage.pvUid, "kind-pv-uid");
  assert.equal(output.runtimeImage, RUNTIME_IMAGE);
});

test("cutover confirm runs a fresh preview and passes only its plan digest to the destructive Job", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CUTOVER: "1" });
  const args = ["cutover", "k3s-evaluation", "--context", "demo-k3s"];
  const preview = runDeployment([...args, "--preview"], fake.environment);
  assert.equal(preview.status, 0, preview.stderr);
  const confirmation = JSON.parse(preview.stdout).confirmation;

  const confirmed = runDeployment(
    [...args, "--confirm", confirmation],
    fake.environment,
  );
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const output = JSON.parse(confirmed.stdout);
  assert.equal(output.mode, "confirmed");
  assert.equal(output.reset.outcome, "reset");
  assert.equal(output.reset.newHead, "20260901_0002");
  assert.deepEqual(output.reset.deleted, {
    businessFileCount: 1,
    checkpointFileCount: 1,
    artifactRunCount: 1,
  });

  const commands = createdResources(fake.calls(), "Job").map(
    (job) => job.spec.template.spec.containers[0].command,
  );
  assert.deepEqual(commands.slice(-2), [
    ["runtime", "reset-stage-one-data", "--preview"],
    [
      "runtime",
      "reset-stage-one-data",
      "--confirm",
      `sha256:${"1".repeat(64)}`,
    ],
  ]);
  assert.equal(createdResources(fake.calls(), "NetworkPolicy").length, 1);
});

test("stale external target confirmation never creates a destructive Job", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CUTOVER: "1" });
  const args = ["cutover", "k3s-evaluation", "--context", "demo-k3s"];
  const preview = runDeployment([...args, "--preview"], fake.environment);
  assert.equal(preview.status, 0, preview.stderr);
  const confirmation = JSON.parse(preview.stdout).confirmation;
  const result = runDeployment(
    [...args, "--confirm", confirmation],
    { ...fake.environment, FAKE_NAMESPACE_UID: "replacement-namespace-uid" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL cutover_confirmation_mismatch /);
  const commands = createdResources(fake.calls(), "Job").map(
    (job) => job.spec.template.spec.containers[0].command,
  );
  assert.equal(commands.some((command) => command[2] === "--confirm"), false);
});

test("cutover preflight gates fail before Runtime Job creation", (t) => {
  const cases = [
    ["FAKE_ACTIVE_WORKLOAD", "cutover_workload_active"],
    ["FAKE_CUTOVER_MUTATOR", "cutover_mutator_present"],
    ["FAKE_CUTOVER_STORAGE_DRIFT", "cutover_storage_invalid"],
    ["FAKE_IMAGE_MISSING", "image_unavailable"],
    ["FAKE_NETWORK_POLICY_DRIFT", "cutover_network_policy_invalid"],
  ];
  for (const [variable, code] of cases) {
    const fake = createFakeKubectl(t, {
      FAKE_CUTOVER: "1",
      [variable]: "1",
    });
    const result = runDeployment(
      ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
      fake.environment,
    );
    assert.equal(result.status, 1, variable);
    assert.match(result.stderr, new RegExp(`^FAIL ${code} `), variable);
    assert.equal(createdResources(fake.calls(), "Job").length, 0, variable);
  }
});

test("cutover permits a webhook whose rules cannot match cutover resources", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_CUTOVER: "1",
    FAKE_UNRELATED_CUTOVER_WEBHOOK: "1",
  });
  const result = runDeployment(
    ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "preview");
});

test("cutover rejects malformed webhooks and both policy mutator collections", (t) => {
  for (const variable of [
    "FAKE_MALFORMED_CUTOVER_WEBHOOK",
    "FAKE_CUTOVER_WILDCARD_GROUP",
    "FAKE_CUTOVER_WILDCARD_RESOURCE",
    "FAKE_CUTOVER_EMPTY_GROUPS",
    "FAKE_CUTOVER_EMPTY_RESOURCES",
    "FAKE_CUTOVER_POLICY",
    "FAKE_CUTOVER_POLICY_BINDING",
  ]) {
    const fake = createFakeKubectl(t, { FAKE_CUTOVER: "1", [variable]: "1" });
    const result = runDeployment(
      ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
      fake.environment,
    );
    assert.equal(result.status, 1, variable);
    assert.match(result.stderr, /^FAIL cutover_mutator_present /, variable);
    assert.equal(createdResources(fake.calls(), "Job").length, 0, variable);
  }
});

test("admitted Pod drift is rejected before scheduling release and current Job is cleaned", (t) => {
  for (const variable of [
    "FAKE_CUTOVER_GATE_MISSING",
    "FAKE_CUTOVER_EXTRA_CONTAINER",
    "FAKE_CUTOVER_INIT_DRIFT",
    "FAKE_CUTOVER_MULTIPLE_PODS",
  ]) {
    const fake = createFakeKubectl(t, {
      FAKE_CUTOVER: "1",
      [variable]: "1",
    });
    const result = runDeployment(
      ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
      fake.environment,
    );
    assert.equal(result.status, 1, variable);
    assert.equal(
      fake.calls().some((call) => call.args.includes("--patch")),
      false,
      variable,
    );
    assert.equal(
      fake.calls().some((call) =>
        call.args.includes(
          "/apis/batch/v1/namespaces/k8s-incident-agent/jobs/runtime-data-cutover",
        ),
      ),
      true,
      variable,
    );
  }
});

test("server-side Job admission drift is rejected before actual Job creation", (t) => {
  for (const variable of [
    "FAKE_CUTOVER_JOB_ADMISSION_DRIFT",
    "FAKE_CUTOVER_JOB_NODENAME_DRIFT",
  ]) {
    const fake = createFakeKubectl(t, {
      FAKE_CUTOVER: "1",
      [variable]: "1",
    });
    const result = runDeployment(
      ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
      fake.environment,
    );
    assert.equal(result.status, 1, variable);
    assert.match(
      result.stderr,
      /^FAIL cutover_job_contract_invalid /,
      variable,
    );
    assert.equal(createdResources(fake.calls(), "Job").length, 0, variable);
    assert.equal(
      fake.calls().some((call) => call.args.includes("--patch")),
      false,
      variable,
    );
  }
});

test("released Pod identity replacement is rejected before and after log capture", (t) => {
  for (const [variable, expectedLogRead] of [
    ["FAKE_CUTOVER_POD_UID_REPLACED", false],
    ["FAKE_CUTOVER_POD_UID_REPLACED_AFTER_LOG", true],
  ]) {
    const fake = createFakeKubectl(t, {
      FAKE_CUTOVER: "1",
      [variable]: "1",
    });
    const result = runDeployment(
      ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
      fake.environment,
    );
    assert.equal(result.status, 1, variable);
    assert.match(
      result.stderr,
      /^FAIL cutover_pod_identity_changed /,
      variable,
    );
    assert.equal(
      fake.calls().some((call) => call.args.includes("logs")),
      expectedLogRead,
      variable,
    );
    assert.equal(
      fake.calls().some((call) =>
        call.args.includes(
          "/apis/batch/v1/namespaces/k8s-incident-agent/jobs/runtime-data-cutover",
        ),
      ),
      true,
      variable,
    );
  }
});

test("Runtime failure, malformed output, and cleanup failure cannot report cutover success", (t) => {
  const cases = [
    ["FAKE_CUTOVER_JOB_FAILED", "cutover_runtime_failed"],
    ["FAKE_CUTOVER_OUTPUT_MALFORMED", "cutover_runtime_output_invalid"],
    ["FAKE_CUTOVER_CLEANUP_FAILED", "cutover_cleanup_failed"],
  ];
  for (const [variable, code] of cases) {
    const fake = createFakeKubectl(t, {
      FAKE_CUTOVER: "1",
      [variable]: "1",
    });
    const result = runDeployment(
      ["cutover", "k3s-evaluation", "--context", "demo-k3s", "--preview"],
      fake.environment,
    );
    assert.equal(result.status, 1, variable);
    assert.match(result.stderr, new RegExp(`^FAIL ${code} `), variable);
    assert.equal(result.stdout, "", variable);
  }
});

test("the next cutover preview recovers only an exact terminal Job residue", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CUTOVER: "1" });
  const args = [
    "cutover",
    "k3s-evaluation",
    "--context",
    "demo-k3s",
    "--preview",
  ];
  const interrupted = runDeployment(args, {
    ...fake.environment,
    FAKE_CUTOVER_CLEANUP_FAILED: "1",
  });
  assert.equal(interrupted.status, 1);
  assert.match(interrupted.stderr, /^FAIL cutover_cleanup_failed /);
  const recovered = runDeployment(args, fake.environment);
  assert.equal(recovered.status, 0, recovered.stderr);
  const deletes = fake.calls().filter((call) =>
    call.args.includes(
      "/apis/batch/v1/namespaces/k8s-incident-agent/jobs/runtime-data-cutover",
    ),
  );
  assert.equal(deletes.length >= 3, true);
  assert.equal(JSON.parse(deletes.at(-1).input).preconditions.uid, "job-uid-2");
});

test("active cutover residue requires review and is never auto-deleted", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CUTOVER: "1" });
  const args = [
    "cutover",
    "k3s-evaluation",
    "--context",
    "demo-k3s",
    "--preview",
  ];
  const interrupted = runDeployment(args, {
    ...fake.environment,
    FAKE_CUTOVER_CLEANUP_FAILED: "1",
    FAKE_CUTOVER_GATE_MISSING: "1",
  });
  assert.equal(interrupted.status, 1);
  const deletesBefore = fake.calls().filter((call) =>
    call.args.includes(
      "/apis/batch/v1/namespaces/k8s-incident-agent/jobs/runtime-data-cutover",
    ),
  ).length;
  const result = runDeployment(args, fake.environment);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL cutover_residue_active /);
  const deletesAfter = fake.calls().filter((call) =>
    call.args.includes(
      "/apis/batch/v1/namespaces/k8s-incident-agent/jobs/runtime-data-cutover",
    ),
  ).length;
  assert.equal(deletesAfter, deletesBefore);
});

test("install and upgrade reject cutover residue before apply", (t) => {
  for (const action of ["install", "upgrade"]) {
    const fake = createFakeKubectl(t, { FAKE_CUTOVER_RESIDUE: "1" });
    const result = runDeployment(
      [action, "k3s-evaluation", "--context", "demo-k3s", "--confirm"],
      fake.environment,
    );
    assert.equal(result.status, 1, action);
    assert.match(result.stderr, /^FAIL cutover_residue_present /);
    assert.equal(
      fake.calls().some((call) => call.args.includes("apply")),
      false,
      action,
    );
  }
  const ownerOnly = createFakeKubectl(t, {
    FAKE_CUTOVER_OWNER_POD_ONLY: "1",
  });
  const result = runDeployment(
    ["install", "k3s-evaluation", "--context", "demo-k3s", "--confirm"],
    ownerOnly.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL cutover_residue_present /);
  assert.equal(
    ownerOnly.calls().some((call) => call.args.includes("apply")),
    false,
  );
});

test("lifecycle preview is offline and uninstall inventory excludes retained data", () => {
  const install = runDeployment([
    "install",
    "k3s-evaluation",
  ]);
  assert.equal(install.status, 0, install.stderr);
  const installResult = JSON.parse(install.stdout);
  assert.equal(installResult.mode, "preview");
  assert.equal(
    installResult.resources.includes(
      "PersistentVolumeClaim/k8s-incident-agent/runtime-data",
    ),
    true,
  );

  const uninstall = runDeployment([
    "uninstall",
    "k3s-evaluation",
    "--preview",
  ]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  const uninstallResult = JSON.parse(uninstall.stdout);
  assert.equal(
    uninstallResult.resources.some((resource) =>
      resource.startsWith("PersistentVolume"),
    ),
    false,
  );
  assert.equal(
    uninstallResult.resources.some((resource) => resource.startsWith("Namespace/")),
    false,
  );
});

test("kubectl-shaped context input is rejected before external execution", () => {
  const result = runDeployment([
    "status",
    "k3s-online",
    "--context",
    "--kubeconfig=/tmp/other-config",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL invalid_argument /);
});

test("confirmed online install preflights, applies, waits, and reports the real status contract", (t) => {
  const fake = createFakeKubectl(t);
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "install",
    cluster: "k3s",
    deployments: "ready",
    ingress: "traefik-ready",
    intakeMode: "online",
    networkPolicies: "matched",
    networkPolicyEnforcement: "requires-live-probe",
    pods: 2,
    profile: "k3s-online",
    pvc: { name: "runtime-data", phase: "Bound", volumeName: "pvc-volume" },
    rbac: "matched",
    services: "cluster-ip-only",
    monitoring: {
      components: "ready",
      networkPolicies: "matched",
      pods: 3,
      pvc: {
        name: "prometheus-data",
        phase: "Bound",
        volumeName: "prometheus-pvc-volume",
      },
      rbac: "matched",
      rules: "matched",
      secretProjection: "configured",
      services: "cluster-ip-only",
    },
  });
  assert.equal(result.stdout.includes("api-key"), false);
  const calls = fake.calls().map((call) => call.args.join(" "));
  assert.equal(
    calls.some((call) => call.includes("apply --dry-run=server --kustomize")),
    true,
  );
  assert.equal(
    calls.some((call) => call.includes("apply --kustomize")),
    true,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.includes("rollout status deployment/"))
      .map((call) => call.match(/deployment\/[^ ]+/)?.[0])
      .sort(),
    [
      "deployment/agent-runtime",
      "deployment/alertmanager",
      "deployment/incident-console",
      "deployment/kube-state-metrics",
      "deployment/prometheus",
    ],
  );
  const subject =
    "--as=system:serviceaccount:k8s-incident-agent:agent-runtime";
  const namespace = "--namespace k8s-incident-scenarios";
  const applicationNamespace = "--namespace k8s-incident-agent";
  const monitoringNamespace = "--namespace k8s-incident-monitoring";
  assert.deepEqual(
    calls
      .filter(
        (call) => call.includes("auth can-i") && call.includes(subject),
      )
      .map((call) => call.slice(call.indexOf("auth can-i")))
      .sort(),
    [
      `auth can-i get deployments.apps ${subject} ${namespace}`,
      `auth can-i get services ${subject} ${namespace}`,
      `auth can-i list endpointslices.discovery.k8s.io ${subject} ${namespace}`,
      `auth can-i list replicasets.apps ${subject} ${namespace}`,
      `auth can-i list pods ${subject} ${namespace}`,
      `auth can-i get pods --subresource=log ${subject} ${namespace}`,
      `auth can-i list events.events.k8s.io ${subject} ${namespace}`,
      `auth can-i create selfsubjectaccessreviews.authorization.k8s.io ${subject}`,
      `auth can-i get secrets ${subject} ${namespace}`,
      `auth can-i create pods --subresource=exec ${subject} ${namespace}`,
      `auth can-i create pods --subresource=attach ${subject} ${namespace}`,
      `auth can-i create deployments.apps ${subject} ${namespace}`,
      `auth can-i update deployments.apps ${subject} ${namespace}`,
      `auth can-i patch deployments.apps ${subject} ${namespace}`,
      `auth can-i delete deployments.apps ${subject} ${namespace}`,
      `auth can-i get secrets ${subject} ${applicationNamespace}`,
    ].sort(),
  );
  const monitoringSubject =
    "--as=system:serviceaccount:k8s-incident-monitoring:kube-state-metrics";
  assert.deepEqual(
    calls
      .filter(
        (call) =>
          call.includes("auth can-i") && call.includes(monitoringSubject),
      )
      .map((call) => call.slice(call.indexOf("auth can-i")))
      .sort(),
    [
      `auth can-i get pods ${monitoringSubject} ${namespace}`,
      `auth can-i list pods ${monitoringSubject} ${namespace}`,
      `auth can-i watch pods ${monitoringSubject} ${namespace}`,
      `auth can-i get services ${monitoringSubject} ${namespace}`,
      `auth can-i list services ${monitoringSubject} ${namespace}`,
      `auth can-i watch services ${monitoringSubject} ${namespace}`,
      `auth can-i get endpointslices.discovery.k8s.io ${monitoringSubject} ${namespace}`,
      `auth can-i list endpointslices.discovery.k8s.io ${monitoringSubject} ${namespace}`,
      `auth can-i watch endpointslices.discovery.k8s.io ${monitoringSubject} ${namespace}`,
      `auth can-i get deployments.apps ${monitoringSubject} ${namespace}`,
      `auth can-i list deployments.apps ${monitoringSubject} ${namespace}`,
      `auth can-i watch deployments.apps ${monitoringSubject} ${namespace}`,
      `auth can-i get replicasets.apps ${monitoringSubject} ${namespace}`,
      `auth can-i list replicasets.apps ${monitoringSubject} ${namespace}`,
      `auth can-i watch replicasets.apps ${monitoringSubject} ${namespace}`,
      `auth can-i get secrets ${monitoringSubject} ${namespace}`,
      `auth can-i list configmaps ${monitoringSubject} ${namespace}`,
      `auth can-i list persistentvolumes ${monitoringSubject}`,
      `auth can-i create pods ${monitoringSubject} ${namespace}`,
      `auth can-i patch deployments.apps ${monitoringSubject} ${namespace}`,
      `auth can-i get secrets ${monitoringSubject} ${monitoringNamespace}`,
    ].sort(),
  );
  for (const serviceAccount of ["prometheus", "alertmanager"]) {
    const monitoringIdentity =
      `--as=system:serviceaccount:k8s-incident-monitoring:${serviceAccount}`;
    assert.deepEqual(
      calls
        .filter(
          (call) =>
            call.includes("auth can-i") && call.includes(monitoringIdentity),
        )
        .map((call) => call.slice(call.indexOf("auth can-i")))
        .sort(),
      [
        `auth can-i list pods ${monitoringIdentity} ${namespace}`,
        `auth can-i get secrets ${monitoringIdentity} ${monitoringNamespace}`,
      ].sort(),
    );
  }
});

test("Kind status accepts the fixed ownership init and exact producer lists", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_PROFILE: "kind-evaluation",
    FAKE_SERVER_VERSION: "v1.36.1",
  });
  const result = runDeployment(
    [
      "status",
      "kind-evaluation",
      "--context",
      "kind-k8s-incident-agent",
    ],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cluster: "kind",
    deployments: "ready",
    ingress: "not-installed",
    intakeMode: "manual",
    networkPolicies: "matched",
    networkPolicyEnforcement: "requires-live-probe",
    pods: 2,
    profile: "kind-evaluation",
    pvc: {
      name: "runtime-data",
      phase: "Bound",
      volumeName: "k8s-incident-agent-runtime-data",
    },
    rbac: "matched",
    services: "cluster-ip-only",
    monitoring: {
      components: "ready",
      networkPolicies: "matched",
      pods: 3,
      pvc: {
        name: "prometheus-data",
        phase: "Bound",
        volumeName: "k8s-incident-agent-prometheus-data",
      },
      rbac: "matched",
      rules: "matched",
      secretProjection: "configured",
      services: "cluster-ip-only",
    },
  });
});

test("status rejects an additive NetworkPolicy that broadens the fixed profile", (t) => {
  const fake = createFakeKubectl(t, { FAKE_NETWORK_POLICY_DRIFT: "1" });
  const result = runDeployment(
    ["status", "k3s-online", "--context", "demo-k3s"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL installation_not_ready /);
});

test("status rejects monitoring component, storage, config, network, and RBAC drift", (t) => {
  const cases = [
    { FAKE_MONITORING_IMAGE_DRIFT: "prometheus" },
    { FAKE_MONITORING_PROBE_DRIFT: "alertmanager" },
    { FAKE_MONITORING_CONFIG_DIGEST_DRIFT: "prometheus" },
    { FAKE_MONITORING_POD_UNREADY: "1" },
    { FAKE_PROMETHEUS_PVC_DRIFT: "1" },
    { FAKE_MONITORING_CONFIG_DRIFT: "prometheus-rules" },
    { FAKE_MONITORING_NETWORK_POLICY_DRIFT: "1" },
    { FAKE_MONITORING_RBAC_DRIFT: "1" },
    { FAKE_MONITORING_RBAC_ALLOW_DRIFT: "1" },
  ];
  for (const environment of cases) {
    const fake = createFakeKubectl(t, environment);
    const result = runDeployment(
      ["status", "k3s-online", "--context", "demo-k3s"],
      fake.environment,
    );
    assert.equal(result.status, 1, JSON.stringify(environment));
    assert.match(
      result.stderr,
      /^FAIL (?:installation_not_ready|rbac_contract_invalid) /,
      JSON.stringify(environment),
    );
  }
});

test("status rejects an Ingress without a Traefik address", (t) => {
  const fake = createFakeKubectl(t, { FAKE_INGRESS_UNAVAILABLE: "1" });
  const result = runDeployment(
    ["status", "k3s-online", "--context", "demo-k3s"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL installation_not_ready /);
});

test("status ignores an old terminating Console Pod after rollout", (t) => {
  const fake = createFakeKubectl(t, { FAKE_TERMINATING_CONSOLE: "1" });
  const result = runDeployment(
    ["status", "k3s-online", "--context", "demo-k3s"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pods, 2);
});

test("status rejects a deployed intake mode that differs from the profile", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_DEPLOYMENT_INTAKE_MODE: "manual",
  });
  const result = runDeployment(
    ["status", "k3s-online", "--context", "demo-k3s"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL installation_not_ready /);
});

test("confirmed install rejects an unavailable fixed K3s component before apply", (t) => {
  const fake = createFakeKubectl(t, { FAKE_COMPONENT_UNAVAILABLE: "traefik" });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL component_not_ready /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed install rejects a missing namespaced webhook credential before apply", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_WEBHOOK_SECRET_MISSING: "1",
  });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL secret_contract_invalid /);
  assert.equal(
    fake.calls().some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed install rejects a K3s component still serving only old Pods", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_COMPONENT_STALE_ROLLOUT: "traefik",
  });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL component_not_ready /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed install rejects a missing locked node image before apply", (t) => {
  const fake = createFakeKubectl(t, { FAKE_IMAGE_MISSING: "1" });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL image_unavailable /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed install rejects the right digest under an unusable repository name", (t) => {
  const fake = createFakeKubectl(t, {
    FAKE_IMAGE_REPOSITORY_MISMATCH: "1",
  });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL image_unavailable /);
  assert.equal(
    fake.calls().some((call) => call.args.includes("apply")),
    false,
  );
});

test("confirmed write fails before cluster access when kubectl is not the fixed version", (t) => {
  const fake = createFakeKubectl(t, { FAKE_CLIENT_VERSION: "v1.33.1" });
  const result = runDeployment(
    ["install", "k3s-online", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL client_version_mismatch /);
  assert.deepEqual(
    fake.calls().map((call) => call.args),
    [["version", "--client", "--output=json"]],
  );
});

test("uninstall does not depend on a healthy model Secret and preserves the same PVC identity", (t) => {
  const fake = createFakeKubectl(t, { FAKE_SECRET_MISSING: "1" });
  const result = runDeployment(
    ["uninstall", "k3s-evaluation", "--context", "demo-k3s", "--confirm"],
    fake.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "uninstall",
    mode: "confirmed",
    profile: "k3s-evaluation",
    retainedPvcs: ["runtime-data", "prometheus-data"],
  });
  const calls = fake.calls().map((call) => call.args.join(" "));
  assert.equal(calls.some((call) => call.includes("get secret")), false);
  assert.equal(
    calls.some((call) => call.includes("delete --ignore-not-found=true --wait=true --kustomize")),
    true,
  );
});

test("purge binds confirmation to current K3s PVC and PV UIDs before raw deletion", (t) => {
  const fake = createFakeKubectl(t);
  const preview = runDeployment(
    ["purge", "k3s-online", "--context", "demo-k3s", "--preview"],
    fake.environment,
  );
  assert.equal(preview.status, 0, preview.stderr);
  const target = JSON.parse(preview.stdout);
  assert.equal(target.confirmation, "purge:demo-k3s:pvc-uid:pv-uid");

  const rejected = runDeployment(
    [
      "purge",
      "k3s-online",
      "--context",
      "demo-k3s",
      "--confirm",
      "purge:demo-k3s:old-pvc:old-pv",
    ],
    fake.environment,
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /^FAIL purge_confirmation_mismatch /);

  const confirmed = runDeployment(
    [
      "purge",
      "k3s-online",
      "--context",
      "demo-k3s",
      "--confirm",
      target.confirmation,
    ],
    fake.environment,
  );
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const calls = fake.calls();
  const rawDeletes = calls.filter((call) =>
    call.args.includes("/api/v1/namespaces/k8s-incident-agent/persistentvolumeclaims/runtime-data"),
  );
  assert.equal(rawDeletes.length, 1);
  assert.deepEqual(JSON.parse(rawDeletes[0].input), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: "pvc-uid" },
    propagationPolicy: "Foreground",
  });
  assert.deepEqual(
    calls
      .filter((call) => call.args.includes("--for=delete"))
      .flatMap((call) =>
        call.args.filter((argument) => argument.startsWith("persistentvolume")),
      )
      .sort(),
    [
      "persistentvolume/pvc-volume",
      "persistentvolumeclaim/runtime-data",
    ],
  );
});

test("purge rejects a terminating or active workload before reading data targets", (t) => {
  const fake = createFakeKubectl(t, { FAKE_ACTIVE_WORKLOAD: "1" });
  const result = runDeployment(
    ["purge", "k3s-online", "--context", "demo-k3s", "--preview"],
    fake.environment,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL purge_workload_active /);
  assert.equal(
    fake
      .calls()
      .some((call) => call.args.includes("persistentvolumeclaim")),
    false,
  );
  const workloadCheck = fake
    .calls()
    .find((call) => call.args.some((argument) => argument.startsWith("deployments.apps,")));
  assert.ok(workloadCheck);
  assert.equal(
    workloadCheck.args.some((argument) => argument.startsWith("--selector=")),
    false,
  );
});

test("Kind purge fails closed instead of claiming hostPath data deletion", () => {
  const result = runDeployment([
    "purge",
    "kind-evaluation",
    "--context",
    "kind-k8s-incident-agent",
    "--preview",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL purge_unsupported /);
});
