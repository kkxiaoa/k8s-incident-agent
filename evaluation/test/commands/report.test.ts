import assert from "node:assert/strict";
import test from "node:test";

import { runReportCommand } from "../../src/commands/report.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { campaign, review } from "../review/layout.ts";

const invalid = (error: unknown) => error instanceof EvaluationError && error.code === "invalid_arguments";

test("the report command validates its one argument and delegates to the campaign report", async (t) => {
  const { file } = campaign(t, { reviews: [review()] });
  const report = await runReportCommand(file);
  assert.equal(report.scenarios[0].review.status, "pass");
  for (const argument of [undefined, "", " padded", "-flag", "x".repeat(4097), 42]) {
    await assert.rejects(runReportCommand(argument), invalid, JSON.stringify(argument));
  }
});
