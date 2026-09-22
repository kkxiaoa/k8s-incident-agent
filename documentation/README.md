# Documentation

Guides to the product's architecture, operation, safety boundaries and development tools.

| Read this | For |
| --- | --- |
| [Getting started](getting-started.md) | A synthetic local UI, real Runtime prerequisites, authentication and configuration |
| [Architecture](architecture.md) | Components, trust boundaries, diagnosis and human-approved repair flows |
| [Data model](data-model.md) | Business SQLite, actual foreign keys, audit records and separate workflow checkpoints |
| [Security and safety](security.md) | Read/write identities, public-readonly access, exact approval and unknown outcomes |
| [Evaluation and evidence](evaluation.md) | What deterministic checks and live evidence prove—and what they do not |
| [Release candidates](releases.md) | Exact-source OCI bundles, isolated smoke and explicit release selection |
| [Selected architecture decisions](decisions/README.md) | Accepted choices, trade-offs and conditions for reconsidering them |

For commands and source contracts, see [contributing](../CONTRIBUTING.md), [operational scripts](../scripts/README.md), the [monitoring catalog](../monitoring/catalog/README.md) and [fault-injection scenarios](../scenarios/README.md). Vulnerability reporting is governed by [SECURITY.md](../SECURITY.md).

## Diagrams

Mermaid blocks in Markdown are the maintained public diagram source. The [component diagram](../README.md#architecture) lives in the English README, with an identical copy in the Chinese README; workflow and ER diagrams live in this directory. GitHub can render them directly. Update the diagrams with the code they describe; do not maintain parallel editable images. The schema view describes the migration target, not the contents or upgrade status of an existing installation.
