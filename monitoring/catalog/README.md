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

An accepted alert is durably stored as a notification occurrence; notification intake does not create an Incident or Run. The Console charts catalog panels for Incident targets. Only `K8sIncidentImagePullBackOff` defines a repair action, `set_container_image`. Its `recoveryAlerts` name the rules that recovery verification requires to be neither pending nor firing for the repaired Deployment, so discovery-only rules never join that gate. Versioned scenarios live in [`scenarios/`](../../scenarios/README.md); an alert without one has no fault-injection fixture.

`correlationGroup` groups liveness restart, CrashLoop and Deployment replica unavailability for the same reliably observed target UID. Every other alert uses its own ID as its group. Runtime associates actual received occurrences only after their source rules are freshly and completely `FIRING`; a group does not synthesize webhook identities or merge different object UIDs. Run-specific source and catalog revision select diagnosis policy and panels even when an Incident contains more than one alert type.

Opt-in rules only watch objects that carry their label: a Service labelled `k8s-incident-agent.io/monitor-selector: "true"` with candidate Pods that name it in `k8s-incident-agent.io/service`, a container named in `k8s-incident-agent.io/readiness-container` with `k8s-incident-agent.io/readiness-slo: 2m` or in `k8s-incident-agent.io/liveness-container`, and a PVC labelled `k8s-incident-agent.io/pending-policy: immediate`.

## Rule interactions

- Startup that exceeds its window is covered by `K8sIncidentDeploymentReplicasUnavailable`; there is no separate startup rule. Alertmanager suppresses that alert while an image-pull, readiness, generic probe, OOM, abnormal-exit or unschedulable alert fires for the same Deployment.
- CrashLoop and liveness restart notifications do not suppress replica-unavailability notifications. All three symptoms reach Runtime, whose UID correlation and automatic diagnosis limits govern the episode. Install this notification policy together with its matching Runtime and catalog.
- The OOM and abnormal-exit rules stand down for 10 minutes after an overlapping symptom alert on the same Deployment.
- The kubelet-backed alerts need the node-metrics collection that only the K3s profiles enable. On Kind they have no series, which means not enabled rather than healthy.
- `Watchdog` is monitoring-path health evidence: the Runtime rejects a delivery whose Watchdog names another cluster or severity, and recovery verification requires a recent Watchdog receipt. It does not create an Incident and is not a fault family.

## Current source observations

Runtime reconciles registered business rules for persisted targets independently of notification delivery and model availability. Catalog expressions use the locked Prometheus rules API's native query representation. Definition, duration, keep-firing duration, static labels, health and evaluation time must match the source contract before an observation is complete. Each target's actual `ALERTS` and catalog expressions are evaluated at the same query time; a nonempty expression without a corresponding source alert is `UNKNOWN`, not a Python-emulated pending timer.

Native expressions evaluate suppression history. OOM also requires the CrashLoop source rule's contract verdict; abnormal exit requires the CrashLoop, liveness restart, OOM and generic probe source-rule verdicts. An unavailable dependency prevents a complete observation without discarding observed activity. This does not require suppression alert series to exist when no alert was active, nor does it propagate unrelated raw-input failures.

Raw proofs distinguish missing inputs from real zero samples, check timestamps before aggregation, and bind applicable inputs to current SDK identities and container lifetimes. Counter windows use a 15-second coverage grid with a 60-second freshness ceiling across their complete five- or ten-minute window; two recent points cannot repair an earlier gap. Conditional absence is accepted only with the corresponding positive SDK/producer facts. CFS input without provable current cgroup coverage remains unknown; another cgroup cannot dilute the native rule's ratio. Service endpoint addresses are aggregated inside Prometheus, not returned in observations.

Queries retain the HTTP limits of five seconds including queue time, four concurrent requests, 256 KiB, eight returned series and 512 samples. Rule batches are also bounded, and the overall target observation has a separate pass budget. Current source activity is a target-level observation with explicit completeness, not an occurrence identity or proof of Incident closure. An incomplete rule does not erase another rule's known activity. Monitoring-chain health and repair recovery gates retain their own contracts.

## Monitoring health

`healthAlerts` are monitoring-chain rules: a collection target down, repeated kube-state-metrics list failures, a configured kubelet job without targets while regular containers run, and rule evaluation failures. They never create an Incident; the Runtime reads their firing state and rule health from Prometheus for `/api/v1/monitoring/health`.
