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
- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  (`feat:`, `fix:`, …; `!` or a `BREAKING CHANGE:` footer for breaking changes). They
  drive the version and `CHANGELOG.md` entries of the release PR, so edit
  `CHANGELOG.md` and `.release-please-manifest.json` only in that PR; see
  [releases](documentation/releases.md).
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
npx next typegen
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

## Pull-request CI

[CI](.github/workflows/ci.yml) runs on pull requests and pushes to `main` with
read-only repository access on ephemeral hosted runners. It checks Runtime lint,
types and unit/execution tests; script/Kustomize/promtool contracts and OpenAPI
drift; Web lint/types/component tests, a production build and fake E2E; public
Markdown links, Mermaid rendering, workflow policy and redacted Git-history scans.
Missing Docker or the locked Prometheus image fails CI rather than skipping rules.

The documentation/check tooling has a separate lockfile, not a production dependency:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci --prefix .github/ci --ignore-scripts
npm test --prefix .github/ci
node .github/ci/check-policy.mjs
node .github/ci/check-docs.mjs --render
```

Rendering uses the installed Chrome channel, as do fake E2E tests. Action SHAs and
download checksums are pinned; application tool versions come from the existing
repository locks. Hosted OS and Chrome maintenance still follow the runner image.
CI restores no cross-run caches and does not upload traces, credentials or
databases. Only the owning-main candidate job uploads the bounded OCI transport
artifact described in [releases](documentation/releases.md). No production secrets,
model calls, cluster access or publishing are part of this workflow; release PR
maintenance and approved publication are separate workflows with their own
permissions. Maintainers configure log retention and check hosted/fork behavior
separately from local checks.

The policy script only guards contribution triggers, read-only token permissions,
secret references/passing, full-SHA external Action/workflow references, and checkout
credential persistence. Workflow syntax belongs to `actionlint`; runner selection,
job layout, timeouts, concurrency, cache isolation and artifact contents require
review. This same-repository check catches accidental regressions; it is not a
security boundary against a pull request that changes the checker itself, and
does not inspect the internals of referenced Actions or reusable workflows.

Secret-scan exceptions in [.github/ci/gitleaksignore](.github/ci/gitleaksignore)
identify reviewed historical synthetic sanitizer fixtures by exact fingerprint.
Do not exclude a whole test directory or detector rule to suppress a finding.
Investigate genuine findings privately, revoke/rotate first, and follow
[SECURITY.md](SECURITY.md); deleting a current file does not remove Git history.

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
