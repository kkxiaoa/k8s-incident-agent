# Stage 2 alert coverage matrix

`catalog.json` contains only alert entries that have a current Runtime production consumer. Pending fault families remain in this matrix until their own Task supplies a complete catalog entry; they are not silently removed from the Stage 2 denominator.

| Fault family | Alert intake | Metrics | Evidence-first diagnosis | Console charts | Evaluation |
| --- | --- | --- | --- | --- | --- |
| `ImagePullBackOff` | Task 1 + Task 9 live | Task 3 + Task 9 live | Task 3 + Task 9 live; Task 10 rollout Evidence offline | Task 4 + Task 9 live | Task 9 prior v1 composite live PASS; Task 10 v2 offline, live pending Task 13 |
| `CrashLoopBackOff` | Task 5 + Task 9 live | Task 5 + Task 9 live | Task 5 + Task 9 live | Task 5 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |
| Service selector / Pod label mismatch | Task 6 + Task 9 live | Task 6 + Task 9 live | Task 6 + Task 9 live | Task 6 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |
| readiness / liveness probe misconfiguration | Task 7 + Task 9 live | Task 7 + Task 9 live | Task 7 + Task 9 live | Task 7 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |
| PVC Pending | Task 8 + Task 9 live | Task 8 + Task 9 live | Task 8 + Task 9 live | Task 8 via Task 4 components + Task 9 live | Task 9 fixed Kind/K3s composite PASS |

`Watchdog` is monitoring-path health evidence. It does not create an Incident and is not a sixth fault family. Task 9 live evidence is composite rather than a single final-revision seven-scenario artifact: each fixed cluster combines an earlier 5/7 full run with a final affected 2/2 rerun. Task 10 changes only the ImagePull scenario/tool contract to catalog `2026-09-06.1`; its healthy-revision → fault-injection sequence and rollout Evidence currently have offline tests only and do not inherit Task 9 live status.
