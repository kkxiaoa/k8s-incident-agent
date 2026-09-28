import assert from "node:assert/strict";
import test from "node:test";

import {
  contractError,
  EVALUATION_ERROR_CODES,
  EvaluationError,
  invalidArguments,
  safeFailure,
  TransientEvaluationError,
  upstreamContractError,
} from "../../src/shared/errors.ts";

test("the error code table is a unique set of snake_case codes", () => {
  assert.equal(new Set(EVALUATION_ERROR_CODES).size, EVALUATION_ERROR_CODES.length);
  for (const code of EVALUATION_ERROR_CODES) {
    assert.match(code, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/);
  }
});

test("evaluation errors expose a typed code and the given message", () => {
  const error = contractError("diagnosis_invalid", "Diagnosis shape rejected");

  assert.ok(error instanceof EvaluationError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "EvaluationError");
  assert.equal(error.code, "diagnosis_invalid");
  assert.equal(error.message, "Diagnosis shape rejected");
});

test("transient errors are evaluation errors that keep the shared name", () => {
  const error = new TransientEvaluationError("http_unavailable", "Endpoint busy");

  assert.ok(error instanceof EvaluationError);
  assert.equal(error.name, "EvaluationError");
  assert.equal(error.code, "http_unavailable");
});

test("fixed constructors use their fixed codes", () => {
  assert.equal(upstreamContractError().code, "upstream_contract_invalid");
  assert.equal(invalidArguments().code, "invalid_arguments");
});

test("safe failures keep evaluation errors and fold everything else", () => {
  const evaluation = contractError("incident_not_created", "No Incident within budget");
  assert.deepEqual(safeFailure(evaluation), {
    code: "incident_not_created",
    message: "No Incident within budget",
  });
  assert.deepEqual(safeFailure(new TransientEvaluationError("http_unavailable", "Busy")), {
    code: "http_unavailable",
    message: "Busy",
  });

  const folded = {
    code: "evaluation_failed",
    message: "Scenario evaluation failed without exposing upstream content",
  };
  const leaking = new Error("kubeconfig token abc123");
  assert.deepEqual(safeFailure(leaking), folded);
  assert.doesNotMatch(safeFailure(leaking).message, /abc123/);
  assert.deepEqual(
    safeFailure(Object.assign(new Error("Scenario missing"), { code: "scenario_not_found" })),
    folded,
  );
  assert.deepEqual(safeFailure("scenario_not_found"), folded);
  assert.deepEqual(safeFailure(undefined), folded);
});
