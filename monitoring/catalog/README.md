# Stage 2 alert coverage matrix

`catalog.json` contains only alert entries that have a current Runtime production consumer. Pending fault families remain in this matrix until their own Task supplies a complete catalog entry; they are not silently removed from the Stage 2 denominator.

| Fault family | Alert intake | Metrics | Evidence-first diagnosis | Console charts | Evaluation |
| --- | --- | --- | --- | --- | --- |
| `ImagePullBackOff` | Task 1 + Task 9 live | Task 3 + Task 9 live | Task 3 + Task 9 live; Task 10 rollout Evidence offline | Task 4 + Task 9 live | Task 9 prior v1 composite live PASS; Task 10 v2 offline, live pending Task 13 |
| `CrashLoopBackOff` | Task 5 + Task 9 live | Task 5 + Task 9 live | Task 5 + Task 9 live | Task 5 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |
| Service selector / Pod label mismatch | Task 6 + Task 9 live | Task 6 + Task 9 live | Task 6 + Task 9 live | Task 6 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |
| readiness / liveness probe misconfiguration | Task 7 + Task 9 live | Task 7 + Task 9 live | Task 7 + Task 9 live | Task 7 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |
| PVC Pending | Task 8 + Task 9 live | Task 8 + Task 9 live | Task 8 + Task 9 live | Task 8 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |
| Recent OOM kill | DC-4A rule, promtool offline | DC-4A trigger panel offline | DC-4A policy offline | DC-4 components | Live pending DC-8 |
| Abnormal container exit | DC-4A rule, promtool offline | DC-4A trigger panel offline | DC-4A policy offline | DC-4 components | Live pending DC-8 |
| Container memory near limit, K3s kubelet only | DC-4A rule, promtool offline | DC-4A trigger panel offline | DC-4A policy offline | DC-4 components | Live pending DC-8 |
| Sustained CPU throttling, K3s kubelet only | DC-4A rule, promtool offline | DC-4A trigger panel offline | DC-4A policy offline | DC-4 components | Live pending DC-8 |
| Probe failures outside the readiness / liveness rules, K3s kubelet only | DC-4A rule, promtool offline | DC-4A trigger panel offline | DC-4A policy offline | DC-4 components | Live pending DC-8 |
| Pod unschedulable | DC-4A rule, promtool offline | DC-4A trigger panel offline | DC-4A policy offline | DC-4 components | Live pending DC-8 |

`Watchdog` is monitoring-path health evidence. It does not create an Incident and is not a fault family. Task 9 live evidence is composite rather than a single final-revision seven-scenario artifact: each fixed cluster combines an earlier 5/7 full run with a final affected 2/2 rerun. Task 10 changes only the ImagePull scenario/tool contract to catalog `2026-09-06.1`; its healthy-revision → fault-injection sequence and rollout Evidence currently have offline tests only and do not inherit Task 9 live status.

Startup that exceeds its window reuses `K8sIncidentDeploymentReplicasUnavailable`; DC-4A adds no separate rule for it. The OOM and abnormal-exit rules stand down for 10 minutes after an overlapping symptom alert on the same Deployment, so one crash episode does not reopen Incidents under new start times. The kubelet-backed rows have no series on Kind, which means not enabled rather than covered.

`healthAlerts` are monitoring-chain rules: a collection target down, repeated KSM list failures, a configured kubelet job without targets while regular containers run, and rule evaluation failures. They never create an Incident; the Runtime reads their firing state and rule health from Prometheus for `/monitoring/health`. The image repair entry lists its `recoveryAlerts` explicitly, so discovery rules never join the recovery gate.
