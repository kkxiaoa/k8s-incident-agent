# Monitoring and alert catalog

`catalog.json` is the single contract for the fault alerts the Runtime accepts, the Prometheus rule behind each alert, the Console panels that chart its signals and the monitoring-chain health rules. `deployment.mjs` refuses to render Prometheus rules that differ from it. Apart from `Watchdog`, Alertmanager webhook alerts whose name is not in the catalog are ignored and never create an Incident.

## Fault alerts

| Fault family | Alert | Target | Signal source | Clusters | Versioned scenarios |
| --- | --- | --- | --- | --- | --- |
| Image pull failure | `K8sIncidentImagePullBackOff` | Deployment | kube-state-metrics | Kind, K3s | `image-pull-backoff` |
| Container restart loop | `K8sIncidentCrashLoopBackOff` | Deployment | kube-state-metrics | Kind, K3s | `crash-loop-backoff` |
| Deployment replicas unavailable | `K8sIncidentDeploymentReplicasUnavailable` | Deployment | kube-state-metrics | Kind, K3s | — |
| Service selector / Pod label mismatch (opt-in) | `K8sIncidentServiceEndpointsUnavailable` | Service | kube-state-metrics | Kind, K3s | `service-selector-mismatch` |
| Readiness probe misconfiguration (opt-in) | `K8sIncidentReadinessProbeFailure` | Deployment | kube-state-metrics | Kind, K3s | `readiness-probe-misconfigured` |
| Liveness probe misconfiguration (opt-in) | `K8sIncidentLivenessProbeRestart` | Deployment | kube-state-metrics | Kind, K3s | `liveness-probe-misconfigured` |
| Recent OOM kill | `K8sIncidentContainerOOMKilled` | Deployment | kube-state-metrics | Kind, K3s | — |
| Abnormal container exit | `K8sIncidentContainerAbnormalExit` | Deployment | kube-state-metrics | Kind, K3s | — |
| Container memory near limit | `K8sIncidentContainerMemoryNearLimit` | Deployment | kubelet resource metrics | K3s | — |
| Sustained CPU throttling | `K8sIncidentContainerCPUThrottled` | Deployment | kubelet cAdvisor metrics | K3s | — |
| Probe failures outside the readiness / liveness rules | `K8sIncidentContainerProbeFailing` | Deployment | kubelet probe metrics | K3s | — |
| Pod unschedulable | `K8sIncidentPodUnschedulable` | Deployment | kube-state-metrics | Kind, K3s | — |
| PVC Pending (opt-in) | `K8sIncidentPersistentVolumeClaimPending` | PersistentVolumeClaim | kube-state-metrics | Kind, K3s | `pvc-binding-pending`, `pvc-storage-class-missing` |

An accepted alert opens an Incident and schedules its Evidence-first diagnosis; the Console charts that alert's catalog panels. Only `K8sIncidentImagePullBackOff` defines a repair action, `set_container_image`. Its `recoveryAlerts` name the rules that recovery verification requires to be neither pending nor firing for the repaired Deployment, so discovery-only rules never join that gate. Versioned scenarios live in [`scenarios/`](../../scenarios/README.md); an alert without one has no fault-injection fixture.

Opt-in rules only watch objects that carry their label: a Service labelled `k8s-incident-agent.io/monitor-selector: "true"` with candidate Pods that name it in `k8s-incident-agent.io/service`, a container named in `k8s-incident-agent.io/readiness-container` with `k8s-incident-agent.io/readiness-slo: 2m` or in `k8s-incident-agent.io/liveness-container`, and a PVC labelled `k8s-incident-agent.io/pending-policy: immediate`.

## Rule interactions

- Startup that exceeds its window is covered by `K8sIncidentDeploymentReplicasUnavailable`; there is no separate startup rule. Alertmanager suppresses that alert while an image-pull, restart-loop, probe, OOM, abnormal-exit or unschedulable alert fires for the same Deployment.
- The OOM and abnormal-exit rules stand down for 10 minutes after an overlapping symptom alert on the same Deployment, so one crash episode does not reopen Incidents under new start times.
- The kubelet-backed alerts need the node-metrics collection that only the K3s profiles enable. On Kind they have no series, which means not enabled rather than healthy.
- `Watchdog` is monitoring-path health evidence: the Runtime rejects a delivery whose Watchdog names another cluster or severity, and recovery verification requires a recent Watchdog receipt. It does not create an Incident and is not a fault family.

## Monitoring health

`healthAlerts` are monitoring-chain rules: a collection target down, repeated kube-state-metrics list failures, a configured kubelet job without targets while regular containers run, and rule evaluation failures. They never create an Incident; the Runtime reads their firing state and rule health from Prometheus for `/api/v1/monitoring/health`.
