# Stage 2 alert coverage matrix

`catalog.json` contains only alert entries that have a current Runtime production consumer. Pending fault families remain in this matrix until their own Task supplies a complete catalog entry; they are not silently removed from the Stage 2 denominator.

| Fault family | Alert intake | Metrics | Evidence-first diagnosis | Console charts | Evaluation |
| --- | --- | --- | --- | --- | --- |
| `ImagePullBackOff` | Task 1 | Task 3 offline | Task 3 offline | Pending Task 4 | Pending |
| `CrashLoopBackOff` | Pending | Pending | Pending | Pending | Pending |
| Service selector / Pod label mismatch | Pending | Pending | Pending | Pending | Pending |
| readiness / liveness probe misconfiguration | Pending | Pending | Pending | Pending | Pending |
| PVC Pending | Pending | Pending | Pending | Pending | Pending |

`Watchdog` is monitoring-path health evidence. It does not create an Incident and is not a sixth fault family. “Offline” means the production contract and Runtime consumer are implemented and tested against locked producer fixtures; it is not a real managed-monitoring or diagnosis result.
