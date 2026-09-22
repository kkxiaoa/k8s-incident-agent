# Candidates and approved releases

Build exact-source OCI candidates, publish them with human approval, and download verified installation bundles. An artifact alone is neither an approved release nor proof of cluster diagnosis or repair.

## One source and one manifest

`release.json` is generated alongside `console-oci/` and `runtime-oci/`, not committed into its own source revision. It contains `schemaVersion: 1`, the full `sourceRevision`, and an `images` entry for each component. Each image entry has a fixed `repository`, `indexDigest`, and `platforms` map with exactly `linux/amd64` and `linux/arm64` child digests.

The repositories are `ghcr.io/kkxiaoa/k8s-incident-agent-console` and `ghcr.io/kkxiaoa/k8s-incident-agent-runtime`. Migration, Validator, ownership initialization and the Executor reuse Runtime. These names are canonical references, not proof of registry availability.

The shared loader checks a clean committed checkout at exactly `sourceRevision`, both OCI indices, every manifest/config/layer size and digest, platform identity, revision labels and non-root user. Missing or invalid content fails closed. There is no fallback to old Kustomize locks, ancestor commits, mutable tags or `.runtime/release` contents. A revision label is a build assertion, not independent provenance; trusted source/run selection and human publication approval remain necessary.

## Local candidate commands

Use the pinned Node version from `.nvmrc`, Docker with a multi-platform builder, the build tools in [release-tools.json](../.github/ci/release-tools.json), and an empty output path outside tracked source. Local builds/runs must be explicitly authorized by the environment owner.

```bash
# Run from a clean committed repository root. Each output directory must be new.
node scripts/release.mjs build --output /absolute/new-bundle
node scripts/release.mjs verify --release /absolute/new-bundle/release.json
node scripts/release-smoke.mjs --release /absolute/new-bundle/release.json
node scripts/release.mjs pack --release /absolute/new-bundle/release.json --output /absolute/new-transport
```

Build exports the committed tree with `git archive`; ignored credentials, retained databases, local docs and development files never enter its build context. It builds each image once for both platforms with provenance/SBOM attestations disabled to retain the supported two-child OCI shape. Source symlinks/submodules and overwritten output directories are rejected. Failed output is retained for inspection; the tool only removes its own temporary workspace.

Smoke requires Docker, `openssl`, and actual amd64/arm64 execution support (native or QEMU). It pulls the pinned Skopeo utility and imports each selected platform into the local Docker store, verifies its platform, revision, config and rootfs against the OCI graph, then runs the verified daemon image ID with no external network, no host ports, a read-only filesystem and temporary writable data. The daemon ID need not equal the OCI config digest across Docker stores. Imported image cache remains local; only the invocation's containers and scratch data are removed.

- Console: launch the image's real command and require `/api/healthz` = 204.
- Runtime: migrate an empty temporary database, launch its real Uvicorn factory and require healthy startup with model diagnosis unavailable. A loopback TLS Kubernetes stub supplies version/access-review responses; generated test credentials have no cluster authority. No model or real Kubernetes calls are made.

This proves packaging/startup only when actually executed successfully. Mock-Docker orchestration tests do not count as those four smoke results. The standalone `pack` command verifies content, **not** previous smoke success; CI ordering and later publication provenance must establish that evidence.

## Candidate CI and transport

[CI](../.github/workflows/ci.yml) runs candidate generation only after all four quality jobs succeed, for a push to `refs/heads/main` in `kkxiaoa/k8s-incident-agent`. Checkout is bound to that push's SHA. PRs, forks and failed checks do not generate candidates. The job has read-only repository permission and no publishing, SSH, model or cluster credentials; it does not consume PR artifacts or executable caches.

Actions are full-SHA pinned; Buildx, BuildKit, QEMU and Skopeo are fixed in the tool lock. Build, four-platform/component startup checks, then packaging must all succeed before upload. The artifact is named `oci-candidate-<source SHA>-<run attempt>`, retained for seven days, and contains only `candidate.tar.gz` plus `SHA256SUMS`. The archive includes `release.json` and the verified OCI graph, omitting unrelated or unreferenced files—even inside a layout directory.

Archive checksum proves transport integrity; OCI digests prove image content; GitHub run/artifact IDs locate the producing run. None is interchangeable with approval. Expired artifacts, insufficient storage and failed startup remain failures, not permission to use `latest` or rebuild during publication. Packaging excludes host extended attributes, including macOS AppleDouble sidecar files. Do not extract arbitrary downloaded archives as an installer.

## Manual publication

[Publication](../.github/workflows/release.yml) accepts three strings: `run_id`, `artifact_id` and a stable `version` such as `v0.1.0`. It runs only from the owning repository's `main`. Before enabling it, a maintainer must configure the `release` Environment with required reviewers, verify that the repository plan supports those rules, and grant this repository access to its two GHCR packages. One maintainer may approve their own dispatch; this is human confirmation, not a two-person guarantee. No custom PAT, SSH or deployment credential is required by the workflow.

1. The read-only selection job queries GitHub metadata. It requires a successful owning-main CI push, all five required jobs successful in the **same run attempt**, and the exact unexpired artifact. The summary records source SHA, run/attempt, artifact ID and GitHub's ZIP digest for the reviewer.
2. The publishing job waits for the `release` Environment. It alone has `contents: write` and `packages: write`, plus `actions: read`. After approval, it checks the actual protection configuration, that dispatch's recorded approval, and the selected candidate again. A same-run rerun is rejected: retries use a **fresh dispatch and fresh approval**, avoiding reuse of an approval not tied to a run attempt.
3. It downloads the artifact, verifies GitHub's ZIP digest and the transport checksum, safely imports only allowlisted regular files, then uses the shared OCI loader against a clean checkout of the candidate source. Archive paths, links, special/duplicate files and oversized content are rejected. Limits: 1 GiB ZIP/compressed TAR, 1 GiB per member, 4 GiB extracted content, 4,096 files and 64 KiB per TAR metadata header. Candidate source/artifacts are data, never executed; the publisher uses trusted main tooling and no dependency caches.
4. It refuses conflicting existing version tags, assets or registry content. It creates a draft with `release.json`, `candidate.tar.gz` and `SHA256SUMS`; the pinned Skopeo copies both OCI layouts with `--all --preserve-digests`, without build, conversion or manifest rewriting. Authenticated and anonymous reads must return the exact index and both child digests for each image.
5. Only after both images and all attachments pass, and candidate metadata is checked again, does it create the source tag and publish the draft. No moving `latest` image tag is written. Release notes identify the source, producing CI run/attempt and artifact, and distinguish startup checks from cluster diagnosis and repair validation.

Publication is serialized and does not cancel an in-flight publisher. Version references are write-once **in this publisher**; this does not make GHCR tags inherently immutable or prevent out-of-band administrator changes. Installation always uses exact digests, never the version tag as image authority. Before distributing a release, verify repository/release protection settings and anonymous image pulls.

### Partial failure and retry

- A failed upload, registry digest rewrite, private package or missing final attachment leaves a **draft/partial publication**, not an installable release. The workflow never deletes or rolls back remote content automatically.
- [GHCR packages start private](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images). For the first publication, a maintainer may need to make exactly these two packages public after upload, then start a new dispatch with the same candidate/version. No package visibility settings are changed by the publisher.
- The same content can resume: existing matching attachments/images are verified and retained; only missing content is uploaded. Already-published complete content is a verified no-op. Conflicting content or an incomplete `starter` attachment stops for manual inspection; never choose a new digest just to make the check pass. Missing-tag detection accepts only the registry's `manifest unknown`/`name unknown` response; authorization/network errors are not evidence of an unused tag.
- An expired candidate requires new candidate CI, new validation and new approval. A fresh candidate that differs from partial same-version attachments requires a new version or an explicitly authorized cleanup decision. Do not silently replace the old version.
- Workflow logs deliberately suppress token-bearing subprocess/HTTP details. The publisher removes only its own temporary authentication files and import workspace; uploaded partial content remains visible to maintainers for inspection.

## Download an approved installation bundle

Use the pinned Node and Python versions. Check out the published source tag in a clean repository before fetching (replace the example version with an actually published one):

```bash
git fetch origin tag v0.1.0
git switch --detach v0.1.0
# Ensure the repository's Python pin is available as python3 on PATH.
node scripts/publish.mjs fetch --version v0.1.0 --output /absolute/new-release-download
```

The public download does not require a token; `GH_TOKEN` is optional for GitHub API rate limits. This entry rejects drafts, prereleases, incomplete releases, a mismatched source tag, inconsistent attachments and altered OCI content. On success use `/absolute/new-release-download/bundle/release.json` below. A failed download is not an installation bundle; its new output directory is retained for inspection, never overwritten on retry. Source tooling must include this download command; for an older source without it, invoke the trusted tooling's absolute script path from the clean candidate checkout.

Local candidate commands intentionally remain available for development/evaluation. They do not assert publication approval. Formal installation/CD must use the approved-release download boundary, not point it at a draft's raw attachments to bypass this check. CD and public HTTPS are not enabled by this workflow.

## Deployment and evaluation

Install dependencies for the matching checkout (`npm ci` and the Runtime dependencies needed for evaluation), then select the bundle explicitly:

```bash
node scripts/deployment.mjs render kind-evaluation --release /absolute/bundle/release.json
node scripts/deployment.mjs install k3s-evaluation --preview --release /absolute/bundle/release.json
node scripts/deployment.mjs status k3s-evaluation --context <fixed-context> --release /absolute/bundle/release.json
node scripts/evaluation.mjs run kind-evaluation --release /absolute/bundle/release.json --scenario image-pull-backoff
```

The final command performs live scenario operations and requires separate authorization. For standalone K3s `scenario.mjs` apply/verify/cleanup, supply `--profile k3s-evaluation --context <fixed-context> --release /absolute/bundle/release.json`; the Kind fixture-only path retains its existing cluster baseline check. Evaluation passes the same verified identity into deployment status and all scenario preflights. Its artifact records that manifest, while dataset, split, expected-terminal and diagnosis scoring semantics stay unchanged.

Deployment creates a temporary Kustomize release overlay. Preview/status use that derived content; server dry-run and actual apply receive the same rendered manifest. All application/init images resolve to canonical repository plus exact index digest. Bare `kubectl kustomize` renders source templates only, not an installation-ready release. Third-party monitoring image pins are unchanged.

Node-image preflight still requires the exact canonical references to be present; importing or prefetching images is a separately authorized installation step. Fixed context/namespace, credential, RBAC, admission, retention, ordinary uninstall and destructive confirmation boundaries remain in force. This change neither enables Executor nor authorizes purge, cluster operations or changes to sibling projects.

## Tool contracts

Implementation references: [OCI Image Spec v1.1.1](https://github.com/opencontainers/image-spec/tree/v1.1.1), [Docker OCI exporter](https://docs.docker.com/build/exporters/oci-docker/), [Buildx setup inputs](https://github.com/docker/setup-buildx-action/blob/f87e5991a6d7451dcb8d9637bfbc97413f497069/action.yml), [QEMU setup inputs](https://github.com/docker/setup-qemu-action/blob/99012661954931238ded8c8b007157a8430204e1/action.yml), [Skopeo v1.20 copy](https://github.com/containers/skopeo/blob/v1.20.0/docs/skopeo-copy.1.md), [artifact upload inputs](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml), [GitHub run/approval API](https://docs.github.com/en/rest/actions/workflow-runs), [artifact API](https://docs.github.com/en/rest/actions/artifacts), [release asset API](https://docs.github.com/en/rest/releases/assets). GHCR transfer must preserve index/child bytes; the smoke-only Docker archive conversion is not a publication path.
