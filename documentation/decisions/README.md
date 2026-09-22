# Selected architecture decisions

Status: accepted design choices, summarized for contributors at `46dbefd`. These are selected current decisions, not a copy of internal planning history or a proposal to change the architecture. Implementation and live qualifications remain in [architecture](../architecture.md), [security](../security.md) and [evaluation](../evaluation.md).

## 1. One diagnostic Agent inside a deterministic workflow

**Context.** Investigation benefits from model-guided tool selection, but authorization, budgets and lifecycle transitions need reproducible rules.

**Decision.** LangGraph owns deterministic workflow progression; one LangChain Agent performs bounded read-only diagnosis within it. The model can infer and recommend, but cannot approve, write or choose safety-critical state transitions. Extend evidence capabilities and typed contracts rather than adding one graph branch/Agent per fault class. Keep recommendations broader than the explicitly supported executable actions.

**Consequences.** Missing evidence and tool failures remain typed outcomes. New model/tool behavior needs scenario evidence and a before/after review. This trades unconstrained autonomy for inspectable facts and controlled cost. A new Agent topology or broader action family needs a fresh architectural decision, not just another prompt instruction.

Source: [workflow graph](../../services/agent-runtime/src/k8s_incident_agent/workflow/graph.py), [repair eligibility](../../services/agent-runtime/src/k8s_incident_agent/repair/eligibility.py).

## 2. Runtime authority; BFF transport; two SQLite responsibilities

**Context.** A browser-facing Console needs stable streaming and request adaptation, while resumable workflow progress must not become an alternative approval database.

**Decision.** Keep Next.js as the UI/BFF and FastAPI as the business/auth authority. The BFF uses a fixed Runtime upstream and bounded transport behavior; the browser does not receive kubeconfig or internal keys. Business SQLite owns Incident, Run and audit records. A separate LangGraph SQLite checkpoint store holds execution progress; approval and write outcomes must be reconciled with the business ledger.

**Consequences.** Some BFF transport forwarding is deliberate, not a second domain implementation. There is no distributed transaction across the two stores. Single Runtime/SQLite fits the current fixed demonstration scope; multiple replicas, tenants or a database replacement require renewed persistence and authorization design.

Source: [server client](../../src/lib/agent-runtime/server-client.ts), [database schema](../data-model.md), [supervisor](../../services/agent-runtime/src/k8s_incident_agent/workflow/supervisor.py).

## 3. Three authority boundaries for read, dry-run and write

**Context.** Kubernetes dry-run still needs patch permission, and a successful validation does not authorize a later persistent write.

**Decision.** Separate diagnostic Runtime, Patch Validator and Controlled Executor identities. Validator combines scoped RBAC with an admission policy requiring dry-run. Executor consumes exact, unexpired approval from the ledger and independently enforces the compiled change. HMAC authenticates internal messages; it is not human approval. Ambiguous writes freeze the target, with no automatic PATCH retry. Recovery is separately observed; rollback needs a new approval.

**Consequences.** More explicit services and keys are justified by distinct authority, not by a general microservice strategy. A UI-only gate or prompt promise cannot replace these controls. Current execution stays disabled by default and lacks final live acceptance. Broader writes or enabling a different environment require new evidence and explicit authorization.

Source: [Validator admission policy](../../deploy/application/base/workloads/patch-validator-admission.yaml), [execution worker](../../services/agent-runtime/src/k8s_incident_agent/execution/worker.py), [security boundaries](../security.md).

## 4. Managed evidence and public read access, not public operation

**Context.** A useful demonstration needs visible history and monitoring, without granting anonymous users model spend or cluster mutation authority. Resource metrics are useful only when their identity/time and collection limits are understood.

**Decision.** Use catalog-driven managed Prometheus/Alertmanager evidence. K3s-only node collection has a separate, explicitly authorized shared-response boundary and filters before storage; it does not broaden diagnostic RBAC. Kind remains a development/CI baseline, not the product's supported-environment definition. Public-readonly mode exposes reviewed history and live progress, while every manual business action still requires the single operator session. Anonymous visitor identity and anonymous Run execution are not part of this design.

**Consequences.** Public readers share a dataset, not isolated personal workspaces. Data review, read limits, monitoring health and incomplete live coverage remain visible responsibilities. SSO, multiple roles, tenants, autonomous repair and arbitrary cluster compatibility are outside the current delivery. Reconsider this decision before accepting any of those requirements or collecting shared-node data under a different trust model.

Source: [monitoring catalog](../../monitoring/catalog/catalog.json), [public-read access](../../services/agent-runtime/src/k8s_incident_agent/auth/public_demo.py), [evaluation gaps](../evaluation.md#current-evidence-and-gaps).
