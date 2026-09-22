# Documentation

Status: current implementation guide, checked against source revision `46dbefd` (2026-09-22). This is not a production-readiness or release certificate.

| Read this | For |
| --- | --- |
| [Getting started](getting-started.md) | A synthetic local UI, real Runtime prerequisites, authentication and configuration |
| [Architecture](architecture.md) | Components, trust boundaries, diagnosis and human-approved repair flows |
| [Data model](data-model.md) | Business SQLite, actual foreign keys, audit records and separate workflow checkpoints |
| [Security and safety](security.md) | Read/write identities, public-readonly access, exact approval and unknown outcomes |
| [Evaluation and evidence](evaluation.md) | What deterministic checks and live evidence prove—and what they do not |
| [Selected architecture decisions](decisions/README.md) | Accepted choices, trade-offs and conditions for reconsidering them |

For commands and source contracts, see [contributing](../CONTRIBUTING.md), [operational scripts](../scripts/README.md), the [monitoring catalog](../monitoring/catalog/README.md) and [fault-injection scenarios](../scenarios/README.md). Vulnerability reporting is governed by [SECURITY.md](../SECURITY.md).

## How to read the status

- **Implemented** means code exists; it does not mean final cluster live acceptance is complete.
- **Validated** is always tied to an environment, source revision and scope. Synthetic fixtures, offline tests and real-cluster evidence are different kinds of evidence.
- **Planned / deferred** is not available or accepted functionality. Public HTTPS deployment, final controlled-execution live acceptance and systematic diagnosis-quality evaluation remain outstanding.

Mermaid blocks in Markdown are the maintained public diagram source. The [component diagram](../README.md#architecture) lives in the English README, with an identical copy in the Chinese README; workflow and ER diagrams live in this directory. GitHub can render them directly. Update the diagrams with the code they describe; do not maintain parallel editable images. The schema view describes the migration target, not the contents or upgrade status of an existing installation.
