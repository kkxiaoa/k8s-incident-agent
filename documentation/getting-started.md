# Getting started

Status: current development instructions. The local UI fixture is usable without Kubernetes or a model. Real deployment requires separately provisioned sandbox infrastructure; published images and a public HTTPS installation have not yet been accepted.

[English overview](../README.md) · [中文概览](../README.zh-CN.md)

## 1. Install pinned tools and dependencies

Use Node.js 24.19.0 (`.nvmrc`), npm 11.17.0, Python 3.13.15 (`services/agent-runtime/.python-version`) and uv 0.12.3 (`pyproject.toml`). Install uv with its [official instructions](https://docs.astral.sh/uv/getting-started/installation/), selecting this project's pinned version rather than upgrading the lockfile. A Node version manager can read `.nvmrc`.

From the repository root:

```bash
npm ci
uv sync --project services/agent-runtime --locked
```

uv can install the pinned Python when it is absent. The first installation needs network access. The manual fixture uses the resulting `services/agent-runtime/.venv/bin/python`; the commands here target macOS/Linux POSIX development, not a validated Windows setup.

Do not copy private configuration from somebody else's workspace. The fake path needs neither `.env` files nor a kubeconfig, model key, Docker, kubectl or a running sibling project.

## 2. Set a login password

Use an interactive terminal:

```bash
install -d -m 700 "$HOME/.config/k8s-incident-agent"
uv run --project services/agent-runtime runtime operator init \
  --output "$HOME/.config/k8s-incident-agent/operator-verifier"
```

The installer chooses the password, preferably using a password manager. Type it twice without echo. The command saves only an Argon2id verifier in a `0600` file, refuses to overwrite an existing file, and never prints the password. Use the original password to sign in—not the file contents. Do not put passwords in command arguments, pipes, URLs, issues or fixtures. Maximum input is 1,024 UTF-8 bytes.

The absolute output path does not depend on the shell's current directory. `uv --project` selects the Python project; it does not mean every application-relative path or `.env` is resolved there. All root commands here explicitly assume the repository root.

For rotation or a forgotten password, initialize a **new** file path, update `OPERATOR_VERIFIER_FILE` and restart the relevant Runtime. Do not delete business data. Ordinary real Runtime restart and logout revoke its sessions.

## 3. Run the synthetic UI fixture

Use the two terminal commands in either README. Ports 18080 and 3000 must be free; do not stop an unrelated process to free them. The current manual fixture fixes `http://127.0.0.1:3000` as its Origin. For isolated automated tests, the existing Playwright configuration supports `PLAYWRIGHT_WEB_PORT` and `PLAYWRIGHT_RUNTIME_PORT`.

The fixture reads only the verifier you explicitly pass. It uses synthetic in-memory incidents and a Python password-verification subprocess, not the production database or Kubernetes clients. It binds to loopback; test-control endpoints must never be exposed publicly.

After login, explore the 19 snapshots in the incident list: 14 repair-lifecycle cases (diagnosis/proposal preparation, awaiting approval, rejection/expiry, execution waiting/claimed/unknown, recovery and rollback outcomes) plus five diagnosis/advice/failed-gate cases. Monitoring curves are synthetic and relative to startup time. Missing-monitoring cases intentionally remain empty. Fixture buttons are not an end-to-end automatic recovery simulation.

Ctrl+C in each terminal stops the process it started. Restarting the fake reconstructs its cases; it does not reset any real database.

## 4. Configure the Console

For real Runtime development, create a local `.env.local` from the root [example](../.env.example), without overwriting existing configuration:

```dotenv
AGENT_RUNTIME_URL=http://127.0.0.1:8000
INCIDENT_INTAKE_MODE=manual
```

Alternatively supply these variables to the command directly. The fake command overrides the Runtime URL to port 18080. Never define `NEXT_PUBLIC_AGENT_RUNTIME_URL`: the upstream is server-only. An absent or invalid Runtime configuration fails; it does not fall back to synthetic data.

`YAML_ASSISTANT_URL` is optional. Unset/empty means no sibling navigation. If you actually operate that app, set an ordinary HTTP(S) URL or a same-origin absolute path such as `/yaml-assistant`. Credentials, query strings, fragments and protocol-relative URLs are rejected by the existing Console validator. This link is not a startup dependency, Runtime endpoint, or authenticated handoff.

Cluster templates likewise omit the link by default. Configure it only in this project's Console ConfigMap and roll out the Console when needed; do not edit the sibling's resources. Deployment status checks the fixed Runtime connection, not availability of an external navigation target.

## 5. Real Runtime: prerequisites, then startup

**This section accesses a real, explicitly authorized fixed sandbox and may incur model costs. It is not needed for the fake UI.** The current implementation is not a generic kubeconfig connector.

Before starting, an installer must provide:

1. The fixed supported Kind sandbox and namespaced Diagnostic identity, or the fixed in-cluster K3s profile. Version contracts live in `deploy/`; use the [scripts reference](../scripts/README.md). Kind's `cluster up` creates a cluster; `cluster bootstrap-access` applies RBAC and writes a short-lived diagnostic kubeconfig. They are not read-only checks.
2. For host-side Kind development, a fresh `diagnostic.kubeconfig` created by that bootstrap command in the **same** `RUNTIME_DATA_DIR` used by Runtime (default repository `.runtime/`). An arbitrary/admin kubeconfig is not accepted. Expired credentials require an authorized refresh.
3. The dedicated operator verifier and the exact Console Origin.
4. A private file containing exactly 32 raw bytes for `PATCH_VALIDATOR_HMAC_KEY_FILE`. Runtime requires it even when persistent execution is disabled. For real proposal validation it must match the independently installed, isolated Validator's key; do not use the login verifier or model key. Provision through the installer's secret-management process, never by printing an existing cluster Secret.
5. Managed Prometheus and, for proposal preparation, the isolated Patch Validator with its mandatory dry-run admission policy. Host-side processes need authorized loopback port-forwards because cluster service DNS is not host DNS. Do not run a host-side Validator with broad credentials or bypass admission.
6. A DeepSeek API key for actual diagnosis. Missing/unavailable model access is explicit degradation, not a synthetic answer. The current baseline is `deepseek-flash`, non-thinking.

Use [the Runtime example](../services/agent-runtime/.env.example) to create `services/agent-runtime/.env` privately; edit it locally and never commit it. Set the actual paths and values, not these placeholders:

```dotenv
OPERATOR_VERIFIER_FILE=/absolute/private/path/operator-verifier
OPERATOR_ORIGIN=http://127.0.0.1:3000
PATCH_VALIDATOR_HMAC_KEY_FILE=/absolute/private/path/patch-validator-key
PATCH_VALIDATOR_BASE_URL=http://127.0.0.1:8081
PROMETHEUS_BASE_URL=http://127.0.0.1:9090
CONSOLE_ACCESS_MODE=private
PUBLIC_DEMO_DATA_APPROVED=false
SANDBOX_EXECUTION_ENABLED=false
```

Keep `DEEPSEEK_API_KEY` private in that file or inject it securely into Runtime only. Restrict the file to owner read/write. Do not shell-source it: Runtime parses its own `.env`. Console reads its root `.env.local` separately. Set an absolute, dedicated `RUNTIME_DATA_DIR` only if necessary, and use the same directory for credential bootstrap, migrations and startup; directories must be `0700`, data files `0600`, with no symlink components.

For an already installed fixed Kind monitoring/Validator profile, separate terminals can keep the authorized tunnels open:

```bash
kubectl --context kind-k8s-incident-agent -n k8s-incident-monitoring \
  port-forward --address 127.0.0.1 service/prometheus 9090:9090
kubectl --context kind-k8s-incident-agent -n k8s-incident-agent \
  port-forward --address 127.0.0.1 service/patch-validator 8081:8081
```

Run each long-lived command in its own terminal. Before changing any existing database, stop its Runtime and follow a backup/upgrade procedure; never reset retained data to make startup pass. For a fresh development database, from the repository root:

```bash
cd services/agent-runtime
uv run alembic upgrade head
uv run agent-runtime
```

Runtime reads `.env` from this working directory, checks the migration head, authentication, credential scope and Kubernetes access, and listens on loopback port 8000. In another terminal at the repository root:

```bash
AGENT_RUNTIME_URL=http://127.0.0.1:8000 \
  npm run dev -- --hostname 127.0.0.1 --port 3000
```

Opening a manual scenario creates an Incident/Run; it does **not** inject the fault. Scenario apply/cleanup are separately authorized cluster writes. Online profiles instead receive Alertmanager intake and prohibit manual Incident creation.

The fixed K3s evaluation Origin placeholder is for private evaluation tunneling, not a public URL or working TLS configuration. K3s online must be configured with this project's real HTTPS Origin and independent TLS resources. Deployment requires an explicitly selected [release bundle](releases.md) and matching clean source; GHCR repository names do not mean images have been published. This guide does not claim a one-command public cluster install. Do not borrow sibling certificates, disable TLS/Origin checks, or enable persistent execution to bypass missing prerequisites.

## 6. Sessions and public-readonly mode

Operator sessions use a one-hour sliding idle window, no absolute deadline. Visible user interactions renew at most once per minute; SSR, polling and SSE do not. Cookies are HttpOnly, Secure and SameSite=Strict; HTTP access is limited to loopback. Remote access requires HTTPS. A stolen session that remains active can persist until revoked.

Default mode is `private`. An installer may select `CONSOLE_ACCESS_MODE=public_demo` only after approving **all retained and continuing data** for public disclosure, with `PUBLIC_DEMO_DATA_APPROVED=true`. Sanitization alone is not approval. Both modes require the operator verifier and fixed Origin; missing authentication never enables public access.

Anonymous users can read history, monitoring, diagnosis/evidence, proposals, approval/execution/recovery results and live progress. All manual create/diagnose/prepare/edit/refresh/withdraw/approve/reject/rollback actions still require login and their existing state/safety gates. Online still forbids manual Incident creation. No guest identity or guest task budget exists.

Public mode does not expose internal Webhook/Validator/Executor routes or raw traces, and does not enable execution. Anonymous reads retain instance-wide limits: 600/minute, 8 concurrent reads and 16 SSE streams; anonymous SSE reconnects after at most five minutes. These are application bounds, not public-network flood protection. Proposal approval expires independently after 15 minutes. Public HTTPS/network acceptance remains pending; do not expose the fake service as a substitute.

## 7. Checks and troubleshooting

See [Contributing](../CONTRIBUTING.md) for commands and prerequisites. Build before Playwright; the current configuration uses installed Google Chrome, not a bundled browser:

```bash
npm run lint
npm run build
PLAYWRIGHT_WEB_PORT=13100 PLAYWRIGHT_RUNTIME_PORT=18180 npm run test:e2e
```

These tests use fresh synthetic credentials and their own fake Runtime, not your operator password. Check those ports are free.

| Symptom | Check |
| --- | --- |
| Cannot clone before publication | The repository may still be private; access/visibility is separate from these local instructions. |
| Fake refuses startup | Absolute verifier path, initialized file, Python virtualenv, and port 18080. |
| Login or mutation rejected | Use the password, not verifier contents; exact Origin/hostname; session expiry; proposal expiry; execution disabled. |
| Empty monitoring in fake | Some snapshots deliberately model unavailable evidence; they are not live charts. |
| Real Runtime refuses startup | Migration head, private file modes, mandatory Validator key, operator config, fresh Diagnostic credential and fixed scope. Keep the actual failure; do not add a fake fallback. |
| No diagnosis / evidence | Model availability/budget and actual tool/monitoring results; an Incident does not itself inject a scenario fault. |
| No sibling link | Expected when `YAML_ASSISTANT_URL` is unset. |
| Real data seems lost | Confirm `RUNTIME_DATA_DIR` and process first; do not reset/purge or delete files. |

Never share passwords, verifiers, kubeconfigs, API keys, raw sensitive logs or databases in support requests.
