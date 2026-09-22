# K8s Incident Agent

[简体中文](README.zh-CN.md)

An evidence-first Kubernetes incident response agent: discover failures, investigate with bounded read-only tools, and prepare controlled remediation for human review.

The product targets supported real Kubernetes environments. **Today, validation is limited to fixed Kind and single-node K3s sandboxes—not production clusters or arbitrary Kubernetes installations.**

## What it does

- Persists incidents, repeatable diagnosis runs, evidence references and audit events.
- Combines Kubernetes workload, event, bounded log and catalog-driven Prometheus evidence. Missing evidence stays missing; model inference is not presented as a cluster fact.
- Shows monitoring, diagnosis, recommendations, proposals and live progress in a Chinese-language Console.
- Separates broad diagnostic recommendations from executable remediation. The current controlled action is an evidence-bound Deployment container-image change, not arbitrary YAML or shell execution.
- Implements isolated dry-run validation, exact human approval, execution receipts, recovery observation and separately approved rollback. **Execution is disabled by default; this newer execution/recovery chain has not completed final cluster live acceptance.** An unknown write outcome stays frozen; it is not automatically retried.

Selected diagnosis scenarios have fixed Kind/K3s live evidence. That is not a statistical accuracy benchmark, complete coverage of the expanded alerts, or proof of production compatibility. Public HTTPS demo and published installation artifacts are not yet available.

## Try the UI locally — synthetic data

No Kubernetes cluster or model API key is needed. This is a development fixture, **not a real diagnosis or automatic-repair demo**.

Prerequisites: Node.js **24.19.0**, npm **11.17.0**, Python **3.13.15** and uv **0.12.3**. Use the repository's `.nvmrc`, Python version file and lockfiles. Commands below assume a POSIX shell.

```bash
git clone https://github.com/kkxiaoa/k8s-incident-agent.git
cd k8s-incident-agent
npm ci
uv sync --project services/agent-runtime --locked
install -d -m 700 "$HOME/.config/k8s-incident-agent"
uv run --project services/agent-runtime runtime operator init \
  --output "$HOME/.config/k8s-incident-agent/operator-verifier"
```

Choose a dedicated password (a password manager can generate it). The interactive prompt does not echo it; only a private verifier file is saved. There is no default password. Existing verifier files are not overwritten—reuse yours or choose a new path.

In terminal 1, from the repository root:

```bash
OPERATOR_VERIFIER_FILE="$HOME/.config/k8s-incident-agent/operator-verifier" \
  node tests/e2e/manual-runtime.mjs
```

In terminal 2, also from the repository root:

```bash
AGENT_RUNTIME_URL=http://127.0.0.1:18080 YAML_ASSISTANT_URL= \
  npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open <http://127.0.0.1:3000> and sign in with the password you chose. Keep this exact hostname: the manual fixture fixes its Origin to this address. The sibling YAML assistant is optional and is not started or required.

The fixture loads 19 diagnosis/repair-lifecycle cases and synthetic monitoring trends; some intentionally show missing monitoring. It does not run a model, Validator or Executor. Approval can reach “waiting for execution”; later outcomes are separate fixture snapshots, not simulated Kubernetes writes. Restarting resets fake data and sessions. Stop both processes with Ctrl+C; no real Runtime database is touched. Do not expose this test server publicly.

For dependency setup, authentication, real Runtime configuration, troubleshooting and public-readonly restrictions, see [Getting started](documentation/getting-started.md).

## Safety and access

Default access is private, with one operator and a one-hour sliding idle session. There is no registration, multi-role system or SSO. An explicitly enabled public-readonly mode allows viewing reviewed data; **all manual business actions still require authentication**. Public mode is not an authentication bypass and has not completed public HTTPS acceptance.

The browser never holds Kubernetes credentials or accesses Prometheus/database directly. The diagnostic Agent has no write or shell tools. The isolated executor must enforce the exact still-valid approved change; UI controls and prompts cannot replace server-side gates. See [Security policy](SECURITY.md).

## Development and documentation

```bash
npm run lint
npm run build
```

[Contributing](CONTRIBUTING.md) lists the full checks and additional kubectl/Docker/Chrome prerequisites. `npm test` is not an npm-only check; live model and cluster evaluations are separate, explicitly authorized operations.

- [Getting started and configuration](documentation/getting-started.md)
- [Operational scripts](scripts/README.md)
- [Monitoring and alert catalog](monitoring/catalog/README.md)
- [Fault-injection scenarios and safety](scenarios/README.md)

Web/BFF: Next.js, React, TypeScript. Runtime: Python, FastAPI, LangGraph for deterministic workflow and LangChain for bounded diagnosis. Persistence: SQLite with a separate workflow checkpoint store. Monitoring: Prometheus, Alertmanager and kube-state-metrics. The current model baseline is `deepseek-flash`, non-thinking. Exact versions live in repository manifests and locks.

## License

[Apache-2.0](LICENSE). Third-party dependencies retain their own licenses.
