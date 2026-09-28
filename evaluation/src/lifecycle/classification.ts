import type { OutcomeClass, ScenarioResult } from "../contracts/records.ts";

// Which failure the operator is looking at: the fixture, the intake, the Run, the expectation or a later gate.
export function classifyFailure(result: Pick<ScenarioResult, "checks" | "failure">): OutcomeClass {
  // Until Alertmanager fires, the input has not reached the product: fixture, monitoring or control problems.
  if (!result.checks.alertmanagerFiring) return "infrastructure_invalid";
  // A fired alert that yields no unique Incident, or a healthy control that alerts, is a product intake failure.
  if (!result.checks.uniqueIncident) return "intake_failed";
  const code = result.failure?.code;
  if (code === "diagnosis_not_terminal") return "run_not_terminal";
  if (code === "terminal_outcome_mismatch") return "outcome_mismatch";
  return "contract_failed";
}
