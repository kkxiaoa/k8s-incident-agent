# Release candidates

Status: candidate tooling implemented; real two-platform build/startup and hosted CI acceptance are still pending. Registry publication, manual release approval and public HTTPS deployment are not implemented by this change. An artifact is not an approved release or evidence of cluster/diagnosis/repair acceptance.

## One source and one manifest

`release.json` is generated alongside `console-oci/` and `runtime-oci/`, not committed into its own source revision. It contains `schemaVersion: 1`, the full `sourceRevision`, and an `images` entry for each component. Each image entry has a fixed `repository`, `indexDigest`, and `platforms` map with exactly `linux/amd64` and `linux/arm64` child digests.

The repositories are `ghcr.io/kkxiaoa/k8s-incident-agent-console` and `ghcr.io/kkxiaoa/k8s-incident-agent-runtime`. Migration, Validator, ownership initialization and the not-yet-enabled Executor reuse Runtime. These names are canonical references, not proof of registry availability.

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

Smoke requires Docker, `openssl`, and actual amd64/arm64 execution support (native or QEMU). It pulls the pinned Skopeo utility and imports each selected platform into the local Docker store, verifies its image config ID against the OCI graph, then runs that exact ID with no external network, no host ports, a read-only filesystem and temporary writable data. Imported image cache remains local; only the invocation's containers and scratch data are removed.

- Console: launch the image's real command and require `/api/healthz` = 204.
- Runtime: migrate an empty temporary database, launch its real Uvicorn factory and require healthy startup with model diagnosis unavailable. A loopback TLS Kubernetes stub supplies version/access-review responses; generated test credentials have no cluster authority. No model or real Kubernetes calls are made.

This proves packaging/startup only when actually executed successfully. Mock-Docker orchestration tests do not count as those four smoke results. The standalone `pack` command verifies content, **not** previous smoke success; CI ordering and later publication provenance must establish that evidence.

## Candidate CI and transport

[CI](../.github/workflows/ci.yml) runs candidate generation only after all four quality jobs succeed, for a push to `refs/heads/main` in `kkxiaoa/k8s-incident-agent`. Checkout is bound to that push's SHA. PRs, forks and failed checks do not generate candidates. The job has read-only repository permission and no publishing, SSH, model or cluster credentials; it does not consume PR artifacts or executable caches.

Actions are full-SHA pinned; Buildx, BuildKit, QEMU and Skopeo are fixed in the tool lock. Build, four-platform/component startup checks, then packaging must all succeed before upload. The artifact is named `oci-candidate-<source SHA>-<run attempt>`, retained for seven days, and contains only `candidate.tar.gz` plus `SHA256SUMS`. The archive includes `release.json` and the verified OCI graph, omitting unrelated or unreferenced files—even inside a layout directory.

Archive checksum proves transport integrity; OCI digests prove image content; GitHub run/artifact IDs locate the producing run. None is interchangeable with approval. Expired artifacts, insufficient storage and failed startup remain failures, not permission to use `latest` or rebuild during publication. Safe untrusted-archive import and trusted run/approval checks belong to the subsequent publication task; do not extract arbitrary downloaded archives as an installer.

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

Implementation references: [OCI Image Spec v1.1.1](https://github.com/opencontainers/image-spec/tree/v1.1.1), [Docker OCI exporter](https://docs.docker.com/build/exporters/oci-docker/), [Buildx setup inputs](https://github.com/docker/setup-buildx-action/blob/f87e5991a6d7451dcb8d9637bfbc97413f497069/action.yml), [QEMU setup inputs](https://github.com/docker/setup-qemu-action/blob/99012661954931238ded8c8b007157a8430204e1/action.yml), [Skopeo v1.20 copy](https://github.com/containers/skopeo/blob/v1.20.0/docs/skopeo-copy.1.md), [artifact upload inputs](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml). Future GHCR transfer must preserve index/child bytes; the smoke-only Docker archive conversion is not a publication path.
