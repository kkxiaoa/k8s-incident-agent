# Security policy

## Reporting a vulnerability

Do not report vulnerabilities, credentials, kubeconfigs, session cookies, raw
cluster logs, or private infrastructure details in public issues or pull requests.

The intended private reporting channel is the repository's
[Security advisories page](https://github.com/kkxiaoa/k8s-incident-agent/security/advisories).
Use **Report a vulnerability** when that button is available. Private reporting
has not yet been verified for this repository; maintainers must enable and verify
it as part of publication acceptance before announcing a public release. If the button is unavailable, request a private contact
channel without including vulnerability details. Do not send a report to an
unverified address or post the report publicly as a fallback.

Include the affected commit or release, a description of the trust boundary at
risk, expected and observed behavior, and a minimal reproduction using synthetic
data in a disposable environment. Remove identifiers and credentials before
sharing attachments. If a real credential may have leaked, revoke or rotate it
through its issuer; deleting a file does not invalidate a credential.

## Support scope

This is a development-stage project. Security fixes target the current development
line; there is no established maintained-release matrix, backport commitment,
response-time guarantee, or production-readiness claim. Include the exact revision
in reports. An accepted design, passing unit test, or successful container start
is not proof that a cluster deployment is safe.

The currently validated environments are fixed Kind and single-node K3s sandbox
baselines. Other distributions, versions, network/storage configurations, and
production environments are not implicitly supported. Public HTTPS demo deployment
and the complete live approval/execution/recovery validation remain pending.

## Trust boundaries

- The browser talks to the Console/BFF. It must not hold a kubeconfig or connect
  directly to Kubernetes, Prometheus, the database, or internal control endpoints.
- The Runtime owns Incident, Run, session, approval, and audit state. Hiding a UI
  button or asking a model to obey a rule is not an authorization boundary.
- The diagnostic Agent has typed, bounded, read-only tools. It has no arbitrary
  shell, Kubernetes write, approval, or rollback tool.
- Patch validation uses an isolated identity and API-server-enforced dry-run.
  The separate Controlled Executor is intended to apply only an exact, still-valid
  approved change in the fixed sandbox scope. Execution is disabled by default;
  enabling it requires the outstanding deployment and live safety gates.
- A successful write is not proof of recovery. An unknown write outcome must not
  cause an automatic retry or an unapproved rollback.
- `private` is the default access mode. Explicit `public_demo` allows anonymous
  reading of approved public projections, not anonymous business actions. All
  manual diagnosis, proposal, and approval actions require authentication and
  their existing server-side gates. Do not expose retained data without review.

Use a dedicated environment and least-privilege identities. Keep internal webhook,
Validator, Executor, monitoring, database, and raw trace interfaces private. Never
disable TLS verification, Origin/CSRF checks, policy checks, or admission gates to
make a demo pass. Do not reuse another project's credentials or deployment runner.

## Sensitive data and experiments

Keep model credentials, operator verifier files, service keys, kubeconfigs, runtime
databases, and raw traces outside version control and publication artifacts.
Redaction reduces risk; it is not a guarantee that arbitrary workload logs contain
no sensitive information. Review what the system may send to the model provider
and what public projections may reveal before enabling either path.

[Scenario fixtures](scenarios/README.md) deliberately create failures. Real model
tests can incur costs; cluster tests can create/delete workloads, interrupt
monitoring, or rotate test credentials. Never run them against a production or
unapproved shared cluster, and never use broad namespace deletion or purge as
routine cleanup.
