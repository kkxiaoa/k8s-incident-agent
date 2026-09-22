# Evaluation and evidence

How to run scenario checks, interpret their evidence and distinguish deterministic assertions from diagnosis-quality judgments.

## Different checks answer different questions

| Evidence | What it can show | What it cannot show |
| --- | --- | --- |
| Static checks, unit/contract/integration tests | Types, projections, safety gates and deterministic failure behavior | Model diagnosis quality or real-cluster compatibility |
| Fake Runtime + browser tests | UI/API contracts, state presentation and interaction | Actual Kubernetes facts, model reasoning, dry-run or writes |
| Versioned scenario driver against a fixed live cluster | Fault injection, discovery, real Runtime/tool chain and specified deterministic observations | Statistical accuracy, unrestricted fault coverage or production support |
| Manual evidence review | Whether a particular conclusion is supported, temporally relevant and appropriately uncertain | A calibrated automated quality benchmark or broad generalization |
| Separately authorized execution/recovery acceptance | Exact approval, write receipt and observed recovery in that tested environment | Success merely because a diagnosis or dry-run passed |

Commands and prerequisites are maintained in [CONTRIBUTING.md](../CONTRIBUTING.md) and [scripts/README.md](../scripts/README.md). Scenario apply/cleanup changes cluster resources; use only an explicitly authorized sandbox and exact scope. This document is not authorization to run it.

## Existing scenario evaluation path

The [scenario catalog](../scenarios/README.md) describes reproducible injected faults and expected observable evidence. [scripts/evaluation.mjs](../scripts/evaluation.mjs) drives that existing catalog through the real Runtime chain. It is a scenario harness with deterministic assertions, not a general model-based judge.

For the selected scenarios, the harness checks applicable discovery/intake behavior, diagnosis completion, persisted Evidence and references, proposal gates, monitoring panels, REST/SSE visibility, repeat-delivery behavior and cleanup/resolved observations. It records release/source identity so results cannot silently be transferred to a different image. A resolved alert is specifically not accepted as proof that the Incident recovered.

A focused run explicitly records unselected scenarios and non-executed infrastructure checks as `not_run`; it is not a disguised full regression. Combining earlier full-run evidence with final targeted evidence is valid only when the source/artifact relationship, tested changes and remaining gaps are stated. Do not convert a combination into a fresh full-suite run.

**`pending_manual_review` is the harness's successful automatic-check outcome, not semantic PASS.** The CLI uses exit code `2` for that condition. Preserve the artifact status and inspect the corresponding evidence rather than relabeling it as either a generic process failure or a completed quality benchmark.

## Review the diagnosis, not just a code or phrase

Machine-checkable coverage includes required evidence kinds, supported targets, legal states and bounded output. A generated diagnosis code or exact sentence is not, by itself, a correctness oracle. Manual review should ask:

1. Do the cited observations exist, belong to the right resource/Run and support the claim?
2. Does the diagnosis distinguish alert occurrence, investigation time and current state? Is historical evidence being mistaken for a present condition?
3. Are observed facts separated from inferred causes, with missing evidence and competing explanations retained?
4. Does a recommendation follow from the evidence without pretending that an unsupported action is executable?
5. If a proposal exists, are its eligibility, scope, unchanged content and validation meaningful? A dry-run result is not a recovery claim.

For example, `OOMKilled` without a memory trend can establish the recorded termination reason but not its pressure source. A throttling spike and slow startup can coexist without proving causality. Expanding an evidence-code allowlist to accept a model answer is not a substitute for these checks.

When changing tools, prompts, model settings or diagnostic behavior, retain the bad case, exact source/model configuration, trace references and the before/after judgment. Use the production multi-turn Agent path where diagnosis behavior is being assessed. A hand-crafted replay or a fake page proves only its declared scope. Share bounded, reviewed summaries—not credentials, raw sensitive logs or unrestricted traces.

## Environment and result scope

Bind each result to its source, image digests, scenario version, selected checks and tested environment. Evidence from one release or environment does not establish compatibility for another. Kind is the development/CI baseline; K3s profiles target a fixed single-node sandbox. The scenario count is not the number of Kubernetes faults the product can diagnose or repair.

Metric collection, alert firing, Incident intake, diagnosis, controlled execution and recovery are separate assertions. Neither a firing alert nor an offline contract test proves that the complete chain succeeded. Report only the checks actually executed; focused runs and synthetic fixtures are not statistical accuracy benchmarks.
