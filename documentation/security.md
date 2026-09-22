# Security and safety boundaries

Read/write identities, authentication and safety contracts. This guide is not a security certification. For vulnerability reporting and supported scope, use [SECURITY.md](../SECURITY.md).

## Access is enforced by Runtime

Default mode is private. One operator initializes a password verifier; there are no default credentials, registration, account management, multi-role access or SSO. Sessions use an HttpOnly cookie and a one-hour sliding idle window, with no additional absolute lifetime. Explicit interaction can renew the session; passive polling and SSE do not. Runtime restart revokes existing sessions. Non-loopback use requires HTTPS; local HTTP is an explicit development exception, not a public deployment pattern.

State-changing browser requests require the operator session and applicable Origin/CSRF checks. Route availability also depends on the installation profile and execution gates: authenticating does not make every action available. The BFF's fixed upstream and transport checks complement these controls; hiding buttons or redirecting to a login page is not authorization.

In explicitly enabled `public_demo` mode, anonymous readers can view history, monitoring, Evidence, diagnoses, recommendations, proposals, approval/execution/recovery results and live progress. They cannot create an Incident, start or repeat a Run, prepare/adjust repair, approve, reject or request rollback. There is no guest identity or anonymous model budget. Public reads have bounded request/concurrency/stream limits; they are not a general DDoS protection service. Anyone able to read the demo can read the published history—there is no per-visitor ownership or privacy boundary.

Source: [session lifecycle](../services/agent-runtime/src/k8s_incident_agent/auth/sessions.py), [HTTP authentication](../services/agent-runtime/src/k8s_incident_agent/auth/http.py), [public-read controls](../services/agent-runtime/src/k8s_incident_agent/auth/public_demo.py), [Runtime routes](../services/agent-runtime/src/k8s_incident_agent/api.py). Configuration and verifier setup are in [getting started](getting-started.md).

## Separate Kubernetes identities

| Identity | Allowed purpose | Must not do |
| --- | --- | --- |
| Browser / BFF | UI and fixed Runtime API transport | Hold kubeconfig, internal service keys, or direct cluster/database access |
| Diagnostic Runtime | Typed bounded reads in the scenario namespace; narrow StorageClass lookup | Patch/apply/delete, shell, arbitrary tools, Secret/ConfigMap-value reads, Node/PV investigation |
| Patch Validator | Independently validate the fixed image-change contract and make a server dry-run | Use its patch RBAC for a persistent write |
| Controlled Executor | Claim and independently recheck an exact approved command; conditional Deployment PATCH | Accept free text/YAML, arbitrary resource writes, or resend an ambiguous PATCH |
| Managed Prometheus | Catalog evidence collection using its own read identity | Confer node permissions on the diagnostic Agent or expose arbitrary queries to the browser |

The fixed action scope is cluster ID `k8s-incident-agent`, namespace `k8s-incident-scenarios`. These are application contracts, not a statement that arbitrary clusters/namespaces are supported. Runtime's [read RBAC](../deploy/application/base/workloads/diagnostic-rbac.yaml), Validator's [RBAC](../deploy/application/base/workloads/patch-validator-rbac.yaml) and Executor's [RBAC](../deploy/application/executor/rbac.yaml) are distinct.

Kubernetes RBAC alone does not make `patch` dry-run-only. The Validator identity is additionally constrained by a fail-closed [ValidatingAdmissionPolicy](../deploy/application/base/workloads/patch-validator-admission.yaml) requiring `request.dryRun == true` for its scoped Deployment updates. Losing that boundary is not permission to fall back to ordinary PATCH. The Executor's image-path and exact-command restrictions are also enforced in code; do not describe its Deployment `patch` Role as field-level RBAC.

## Authenticated channels are not human approval

Runtime→Validator requests and Executor→Runtime claim/report exchanges use separate HMAC channels and keys, with bounded bodies, signatures, freshness and nonce-replay checks. Responses are bound to their request context. HMAC authenticates the internal message and protects integrity; it does **not** encrypt traffic, prove a human approved a change, or replace network isolation/TLS where required. Replay caches are process-local and are not a durable cross-restart exactly-once guarantee; the business ledger enforces the claim and execution lifecycle.

Keys stay in server-side files/Secret mounts; they do not go to the browser, model, URL, trace or fixture. Neither the model nor a tool result can manufacture approval. Source: [HMAC primitive](../services/agent-runtime/src/k8s_incident_agent/internal_auth.py), [validation channel](../services/agent-runtime/src/k8s_incident_agent/repair/auth.py), [execution channel](../services/agent-runtime/src/k8s_incident_agent/execution/auth.py).

## Exact change and uncertain outcomes

The supported action is not generic remediation. Eligibility requires observed facts, a bounded Deployment/container target and a permissible image change. Image-pull failures caused by credentials, connectivity or registry throttling are not automatically permission to replace an image. Current apply eligibility is deliberately narrower: the image must use the reserved `invalid` / `.invalid` registry host, with matching Pod/Event observations and an eligible observed history selection. This does not repair arbitrary real registry failures; see [eligibility](../services/agent-runtime/src/k8s_incident_agent/repair/eligibility.py) and [preparation](../services/agent-runtime/src/k8s_incident_agent/repair/preparation.py).

Schema, Policy and Diff checks precede an independently authenticated dry-run. Approval binds the exact proposal and validation digests and expires with the 15-minute validation window. Execution rechecks scope, identity, expiry, resource preconditions and the short start deadline before sending the compiled PATCH. An approved but unclaimed command can expire without a write.

The claim-once ledger and zero automatic PATCH retries address the dangerous case where the network fails after Kubernetes may have accepted a change. Such an `UNKNOWN` result retains target occupancy and requires explicit investigation. A late receipt is audit information, not permission for a second write. A UI retry, worker restart or repeated webhook cannot authorize replay. Successful execution still requires separate recovery observation; failed observation must not be relabeled success. Rollback is a fresh, separately validated and approved operation, never an autonomous response to failure.

Source: [compiler](../services/agent-runtime/src/k8s_incident_agent/repair/compiler.py), [worker checks](../services/agent-runtime/src/k8s_incident_agent/execution/worker.py), [Kubernetes write boundary](../services/agent-runtime/src/k8s_incident_agent/execution/kubernetes.py), [ledger](../services/agent-runtime/src/k8s_incident_agent/persistence/repositories.py).

## Monitoring and sensitive data

Tool output is projected into bounded evidence contracts with redaction/truncation markers. Logs and Events are untrusted data, not instructions. Raw credentials, kubeconfigs, Secret values and sensitive unsanitized logs must not enter prompts, traces, fixtures or Git. Redaction is not proof that arbitrary source data is safe to publish: an operator must review the dataset before enabling public read access, including workload names, image references and historical evidence.

K3s node-metric collection uses a separate Prometheus identity and an explicitly scoped kubelet endpoint with TLS verification. The shared kubelet HTTP response can contain other workloads' samples **before** filtering. Namespace/Pod-role/regular-container filtering before TSDB storage limits retained metrics; it does not isolate the source response. Enabling this collection on a shared node requires authorization for that read boundary. The Agent receives no `nodes/proxy` or general Node-read capability. Current Kind profiles leave this collector disabled rather than weakening TLS to accept their kubelet certificates.

Evidence queries are catalog-defined, time-bounded and attached to the applicable resource lifecycle. Missing series, stale monitoring or absent termination reasons remain unavailable evidence. Discovery alerts are not automatically added to the narrower recovery-gate set. Watchdog/monitoring-health alerts describe the observability pipeline and do not create workload Incidents.

The managed Prometheus configuration sets both 15-day and 1600 MB retention limits; the size bound can shorten the retained time range. Neither that setting nor bounded API output constitutes a complete retention policy for all Runtime audit/trace data. Review storage, exports and backups separately; do not publish raw live artifacts or infer a cleanup command is safe for sibling resources.

Source: [monitoring configuration](../deploy/monitoring/base/workloads/config-maps.yaml), [K3s collector and filtering](../deploy/monitoring/components/node-metrics/scrape-config.yaml), [catalog](../monitoring/catalog/catalog.json).

## Deployment scope

The system assumes one operator, a fixed sandbox and a single Runtime. Arbitrary-cluster compatibility, tenant isolation, high availability and broader write actions are outside this deployment scope. Execution is disabled by default; enabling it requires environment-specific safety validation. Non-loopback access requires HTTPS. Do not expose Runtime's internal services or reuse another project's certificates, credentials or resources to bypass these gates.
