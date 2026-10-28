# Getting started

Run a synthetic local UI without Kubernetes or a model, or configure a real Runtime against separately provisioned sandbox infrastructure.

[English overview](../README.md) · [中文概览](../README.zh-CN.md)

## 1. Install pinned tools and dependencies

Use Node.js 24.19.0 (`.nvmrc`), npm 11.17.0, Python 3.13.15 (`services/agent-runtime/.python-version`) and uv 0.12.3 (`pyproject.toml`). Install uv with its [official instructions](https://docs.astral.sh/uv/getting-started/installation/), selecting this project's pinned version rather than upgrading the lockfile. A Node version manager can read `.nvmrc`.

From the repository root:

```bash
npm ci
uv sync --project services/agent-runtime --locked
```

uv can install the pinned Python when it is absent. The first installation needs network access. The manual fixture uses the resulting `services/agent-runtime/.venv/bin/python`; these commands are for macOS/Linux POSIX shells, not Windows.

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

Use the two terminal commands in either README. Ports 18080 and 3000 must be free; do not stop an unrelated process to free them. The manual fixture fixes `http://127.0.0.1:3000` as its Origin. For isolated automated tests, the Playwright configuration supports `PLAYWRIGHT_WEB_PORT` and `PLAYWRIGHT_RUNTIME_PORT`.

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

`YAML_ASSISTANT_URL` is optional. Unset/empty means no sibling navigation. If you actually operate that app, set an ordinary HTTP(S) URL or a same-origin absolute path such as `/yaml-assistant`. Credentials, query strings, fragments and protocol-relative URLs are rejected by the Console configuration validator. This link is not a startup dependency, Runtime endpoint, or authenticated handoff.

The private cluster profiles omit the YAML link; the `k3s-public` profile points it at `https://yaml.kubesmith.cloud/`. The header also links to the personal homepage at `https://www.kubesmith.cloud/`. Elsewhere, configure the YAML link only in this project's Console ConfigMap and roll out the Console when needed; do not edit the sibling's resources. Deployment status checks only the values the profile renders into the Console ConfigMap (for `k3s-public`, the fixed YAML link and ICP record); keys you add yourself are not compared, and external targets are never probed.

`PUBLIC_ICP_RECORD` is optional. Set to a plain MIIT filing number such as `京ICP备12345678号-1`, the Console footer shows it as a link to `https://beian.miit.gov.cn/`; any other value fails configuration. The formal `k3s-public` profile supplies `豫ICP备2026051618号-1`. Verify that the site's domain and service are covered by that filing before exposing it; other environments should leave it unset unless covered by a Chinese ICP filing.

### Read Incident state and history

The Incident list separates lifecycle, current source alerts and diagnostic/repair progress. `UNKNOWN` means current activity cannot be established; a completed diagnosis does not mean the Incident is closed. Filter by catalog alert type, lifecycle, current alert state or business status to query the full history. The Console loads 20 matching records per page, while the desktop scroll area fits ten data rows. Sorting applies only to loaded records. Historical update times may include notification refreshes and do not necessarily identify new processing activity. Changing a filter clears the previous page and scroll position.

In an Incident detail, expand the notification history and load earlier pages as needed. A last `FIRING` notification can coexist with current `CLEAR` observations. An end time comes from the received notification and does not prove when recovery occurred; missing historical receipt times remain unknown. Closure explains either sustained observed health or recovery backed by repair verification. A reopened Incident labels the retained closure as its previous closure. A deferred diagnosis may show a review time, which does not guarantee that a Run will start then. Selecting a historical Run preserves that Run's results while lifecycle and current observations describe the Incident now.

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

The fixed K3s evaluation Origin placeholder is for private evaluation tunneling, not a public URL or working TLS configuration. `k3s-public` fixes `OPERATOR_ORIGIN` to `https://incident.kubesmith.cloud` and requires the separately issued TLS Secret `incident-console-tls`. Deployment requires an explicitly selected [release bundle](releases.md) and matching clean source; GHCR repository names do not mean images have been published. This guide does not claim a one-command public cluster install. Do not borrow sibling certificates, disable TLS/Origin checks, or enable persistent execution to bypass missing prerequisites.

The public profile explicitly sets `SANDBOX_EXECUTION_ENABLED=false`. Its Console Ingress uses Traefik's `websecure` entrypoint with TLS. An installer separately manages the five [TLS manifests](../deploy/application/platform/k3s-public/tls/): a namespace Issuer and Certificate, the HTTP-01 solver NetworkPolicy, and an HTTP route with an HTTPS redirect middleware. The HTTP route matches only `incident.kubesmith.cloud` and excludes `/.well-known/acme-challenge/`; the solver uses Traefik's `web` entrypoint and a ClusterIP Service. These installer resources are outside release rendering, the deployment gateway's write permissions and ordinary uninstall.

Before installation, verify cert-manager and Traefik CRDs and entrypoint names, the exact domain's DNS and port 80/443 reachability, and the absence of conflicting routes. Apply the solver policy and redirect manifests before requesting the Certificate, then verify Certificate readiness, the issued hostname, HTTP redirects and challenge reachability. Public deployment status requires the exact installer solver policy and HTTPS Ingress annotations, and rejects unknown additional NetworkPolicies. It does not prove certificate issuance, network enforcement or renewal; see the [deployment operations](../scripts/README.md#deploymentmjs) for the installer sequence.

## 6. Sessions and public-readonly mode

Operator sessions use a one-hour sliding idle window, no absolute deadline. Visible user interactions renew at most once per minute; SSR, polling and SSE do not. Cookies are HttpOnly, Secure and SameSite=Strict; HTTP access is limited to loopback. Remote access requires HTTPS. A stolen session that remains active can persist until revoked.

Default mode is `private`. An installer may select `CONSOLE_ACCESS_MODE=public_demo` only after approving **all retained and continuing data** for public disclosure, with `PUBLIC_DEMO_DATA_APPROVED=true`. Sanitization alone is not approval. Both modes require the operator verifier and fixed Origin; missing authentication never enables public access.

Anonymous users can read history, monitoring, diagnosis/evidence, proposals, approval/execution/recovery results and live progress. All manual create/diagnose/prepare/edit/refresh/withdraw/approve/reject/rollback actions still require login and their existing state/safety gates. Online still forbids manual Incident creation. No guest identity or guest task budget exists.

Public mode does not expose internal Webhook/Validator/Executor routes or raw traces, and does not enable execution. Anonymous reads retain instance-wide limits: 600/minute, 8 concurrent reads and 16 SSE streams; anonymous SSE reconnects after at most five minutes. These are application bounds, not public-network flood protection. Proposal approval expires independently after 15 minutes. Do not expose the fake service to public networks.

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
| Cannot clone | Check the repository URL and your access permissions. |
| Fake refuses startup | Absolute verifier path, initialized file, Python virtualenv, and port 18080. |
| Login or mutation rejected | Use the password, not verifier contents; exact Origin/hostname; session expiry; proposal expiry; execution disabled. |
| Empty monitoring in fake | Some snapshots deliberately model unavailable evidence; they are not live charts. |
| Real Runtime refuses startup | Migration head, private file modes, mandatory Validator key, operator config, fresh Diagnostic credential and fixed scope. Keep the actual failure; do not add a fake fallback. |
| No diagnosis / evidence | Model availability/budget and actual tool/monitoring results; an Incident does not itself inject a scenario fault. |
| No sibling link | Expected when `YAML_ASSISTANT_URL` is unset. |
| Real data seems lost | Confirm `RUNTIME_DATA_DIR` and process first; do not reset/purge or delete files. |

Never share passwords, verifiers, kubeconfigs, API keys, raw sensitive logs or databases in support requests.

## Retained-data upgrades

Ordinary `deployment upgrade` does not automatically stop Runtime or take a backup. Before changing a retained installation, stop its Runtime and take a consistent cold backup of the business database, checkpoint database and run artifacts using the candidate Runtime's `runtime backup --destination /absolute/backup/directory`. The destination must already exist; preserve its manifest and checksums and keep an independent copy outside the installation. The candidate accepts only Alembic revisions present in its own migration history, including known older revisions.

Install the matching Runtime, Console, catalog and monitoring configuration as one candidate. The compatible-symptom notification policy must not be enabled separately against an older Runtime that lacks UID correlation and bounded automatic diagnosis. Migrate the restored or stopped data forward, then verify schema head, retained Incident/Run IDs, approvals/executions, checkpoints and readable history before restoring traffic. Rehearse these steps against an isolated nonempty copy before a retained installation.

If migration or startup validation fails, stop the candidate and restore the complete pre-upgrade backup together with a compatible prior release. Do not ask an old binary to read the new schema, reset the database, or assume an automatic downgrade can preserve new lifecycle facts. The restricted deployment gateway has its own drain/backup/apply sequence; see the [deployment and backup contract](../scripts/README.md).

## 8. Explicit retention maintenance

Pruning is destructive, separately authorized maintenance of a specific installation. It is not part of normal startup or a way to repair stale-looking history. First identify the intended `RUNTIME_DATA_DIR`, stop its Runtime, and make a consistent backup of its business database, checkpoint database and artifacts. Keep the same private-directory and no-symlink requirements used for startup.

From `services/agent-runtime`, with that installation's configuration selected:

```bash
uv run runtime prune --preview
```

Inspect the exact Incident/Run/artifact targets and any resolved-only occurrence targets. The default retention window is seven days (`RUNTIME_RETENTION_DAYS`, allowed range 1–30). CLOSED Incidents use their last `closedAt`, including those with no Runs; resolved-only unassigned occurrences use their last receipt time and require trusted source reconciliation. OPEN or undetermined historical lifecycle, active/waiting work, ambiguous execution and unresolved facts remain protected.

Only after approving deletion for this installation:

```bash
uv run runtime prune --confirm
```

Both commands require the maintenance lock. Confirm performs a fresh eligibility scan; it is not bound to a saved preview digest, so review changes and rerun preview if circumstances have changed. Artifact/checkpoint deletion precedes the final business-ledger deletion and is not a cross-store atomic operation. If any step fails, preserve the remaining data and investigate the explicit error; do not manually remove ledger rows or reset the installation. Deleted history has no application undo and requires a consistent backup to restore.
