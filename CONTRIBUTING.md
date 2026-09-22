# Contributing

K8s Incident Agent investigates Kubernetes runtime incidents using tool-backed
evidence. It is not a general operations chatbot or a deployment-time YAML authoring
assistant. Contributions should preserve that boundary.

## Before making a change

- Discuss changes to architecture, authentication, cluster permissions, persistence,
  model behavior, or supported environments before implementing them.
- Keep a pull request focused on one observable behavior. Describe the problem,
  direct consumers, scope, risks, and what remains unverified.
- Reuse existing typed contracts and normalization boundaries. Derive external
  contracts from the pinned producer's documentation or a reproducible sanitized
  response, not from a hand-written test expectation.
- Never replace a real failure with a hard-coded diagnosis, a fake tool success,
  an implicit in-memory fallback, or a UI-only safety check. Deterministic fixtures
  belong in tests or the scenario catalog, not in production fallback paths.
- For security concerns, follow [SECURITY.md](SECURITY.md), not a public bug report.

## Local checks

Use the versions pinned in `.nvmrc`, `package.json`,
`services/agent-runtime/.python-version`, `services/agent-runtime/pyproject.toml`,
and the deployment version files. Do not upgrade runtime, framework, model, and
cluster baselines together as part of an unrelated change.

From the repository root, with the pinned tools installed:

```sh
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run openapi:check
npm run build
```

`npm test` also runs script contracts: some require the pinned `kubectl` and
Docker/promtool image. Report skipped checks explicitly; a missing dependency is
not evidence that the check passed. OpenAPI checks require the locked Runtime
development environment. See the [script reference](scripts/README.md) for command
scope and prerequisites.

From `services/agent-runtime`, check the Python side:

```sh
uv sync --locked
uv run --locked ruff check src tests
uv run --locked ruff format --check src tests
uv run --locked pyright
uv run --locked pytest tests/unit tests/execution
```

For Console changes, run `npm run test:e2e` from the repository root after a
production build and installation of the browser required by `playwright.config.ts`.
It uses a fake Runtime with synthetic credentials, not a live cluster or model.
Use isolated ports and do not terminate another project's services.

Choose tests for the concrete regression: contract tests for producer boundaries,
integration tests for state/persistence flows, and focused reproduction tests for
bugs. Documentation-only changes normally need link, command, and factual checks,
not a full live regression. Report checks you did not run and why.

## Cluster and model tests are separate

Do not run `live_kind`, `live_model`, evaluation, scenario application, or deployment
commands as an assumed part of a normal test run. Obtain authorization for the
exact sandbox, cost, credentials, mutations, and cleanup first. Read the
[scenario warning](scenarios/README.md). Preserve data and audit records; a fixture
cleanup is not a product rollback.

Prompt, tool, model, graph, or validation changes need a description of the bad
case and evaluation criteria. Record the relevant scenario and artifact versions;
do not claim new model-quality results from mocks or reuse an unrelated release's
live result.

## Pull requests

Include a concise summary, the behavior/safety contract, validation results,
unverified items, and any deployment or migration implications. Use synthetic,
sanitized reproductions. Never attach real secrets, session traffic, databases,
raw traces, or private cluster logs. Keep generated OpenAPI/types and public
documentation synchronized when their contracts change.

Use English Conventional Commit subjects, for example:
`fix(monitoring): preserve missing-data semantics`.
Implementation and risk-proportionate validation require independent review before
merge. Fix confirmed findings and revalidate after the last relevant change; do
not add tests that merely freeze private helper structure or inflate coverage.

The project is licensed under [Apache-2.0](LICENSE). Submit only material you have
the right to contribute. Intentional contributions are subject to the contribution
terms in that license unless explicitly stated otherwise. Preserve third-party
licenses and attribution; the project license does not relicense dependencies or
grant rights to third-party trademarks.
