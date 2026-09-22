# Fault-injection scenarios

**These fixtures intentionally break Kubernetes workloads. They are not production
examples and must not be applied to an unapproved cluster.**

Use a disposable, explicitly authorized sandbox and the repository's fixed
environment/version contracts. The current scope is the dedicated
`k8s-incident-scenarios` namespace in the supported Kind or fixed K3s evaluation
profile. A namespace name alone is not a safety guarantee; check the actual cluster
identity, profile, resource ownership, and retained data before any mutation.

## What is in this directory

Each scenario has a versioned `scenario.json` and resource manifests. The catalog
defines the trigger, expected evidence, and deterministic verification conditions.
Some scenarios include healthy controls or rollout history. They are test inputs,
not production diagnoses or instructions to the model.

The current fixtures cover crash loops, invalid image references, service selector
mismatches, readiness/liveness failures, a missing StorageClass, and a PVC that
cannot bind. This is a finite test catalog, not a promise that all
Kubernetes failures are supported or that every diagnosis can be repaired.

## Read before running

- Start with `npm run scenario -- list` and the [script reference](../scripts/README.md).
  Listing the catalog does not authorize applying it.
- Use the scenario operator's fixed profile/context checks; do not bypass them
  with a recursive `kubectl apply` of this directory or a production kubeconfig.
- Application creates or changes real resources and may establish a healthy
  baseline before injecting a fault. Verification reads real state; a failure
  does not imply that nothing was created.
- Cleanup deletes the exact scenario-declared resources. Confirm ownership and
  inspect residual Pods **and PVCs** after partial failures; `kubectl get all`
  alone does not list PVCs. Unknown residual resources require a decision, not a
  broader delete command.
- Evaluation is not read-only: it can apply/clean up fixtures, restart components,
  interrupt managed monitoring, rotate test webhook credentials, and invoke a
  paid model. Its scope and cost need separate approval.
- Do not delete namespaces, shared storage, retained audit data, certificates,
  or another project's resources as a shortcut. Ordinary application uninstall
  and scenario cleanup have different scopes; neither authorizes purge.

## Evidence and safety claims

Fixture cleanup is not an approved repair or rollback. Passing a diagnostic
scenario, a dry-run, or an offline Executor test does not prove a successful
production write or recovery. Bind results to the exact source, image digests,
profile, scenario version, and observed outcomes. Keep real credentials and raw
cluster data out of fixtures, screenshots, logs, and published artifacts.

See [SECURITY.md](../SECURITY.md) for the project's trust boundaries and private
vulnerability reporting policy.
