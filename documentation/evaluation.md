# Evaluation and evidence

Status: description of existing checks and evidence at `46dbefd`, not a new evaluator or a claim that planned acceptance has run.

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

## Current evidence and gaps

The latest recorded seven-scenario K3s evidence is associated with source `3fcd376` and release-lock revision `d92218a`: four accepted automatic scenario checks from the full-run attempt plus three from final targeted runs. The aggregate covers seven selected scenario checks; artifacts remain `pending_manual_review`. It is **not** seven-scene semantic acceptance, a statistical success rate, or a fresh live run of the documentation revision `46dbefd`.

Earlier fixed Kind/K3s seven-scenario results belong to their historical releases; they are not a current compatibility matrix. Kind is the development/CI baseline, K3s the first fixed deployment target. The scenario count is not the number of Kubernetes fault types the product can diagnose or repair.

Outstanding qualifications:

- Expanded metric collection has partial K3s TLS/RBAC/filtering/budget evidence. The init-container exclusion live counterexample, target-down behavior and final consumer convergence are not closed.
- Six new discovery alerts are implemented: OOM termination, abnormal exit, near-limit memory, CPU throttling, additional probe failures and unschedulable Pods. Abnormal-exit firing was observed, but its own full Incident intake path was not established; the other five dedicated new-scenario checks remain unrun. Slow startup reuses the Deployment-unavailable discovery path; it is not an additional dedicated alert.
- Final controlled execution, recovery, separately approved rollback and restart/failure-boundary acceptance on the final release remain incomplete. Offline tests and implemented manifests do not close this gate.
- A public HTTPS demonstration and supported arbitrary-cluster compatibility have not been accepted.
- A systematic diagnosis-quality evaluation framework, calibrated quality baseline and broader held-out coverage are not claimed here. Designing that work does not turn current harness output into its results.

Keep these distinctions when publishing release notes. If a check was not run, say so; if a gate is deferred, preserve it. No aggregate “accuracy” or “all live tests passed” claim follows from the evidence above.
