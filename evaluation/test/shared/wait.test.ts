import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  contractError,
  EvaluationError,
  TransientEvaluationError,
} from "../../src/shared/errors.ts";
import { POLL_INTERVAL_MILLISECONDS, waitUntil } from "../../src/shared/wait.ts";

function fakeClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const slept: number[] = [];
  const sleep = async (milliseconds: number) => {
    slept.push(milliseconds);
    t.mock.timers.tick(milliseconds);
  };
  return { sleep, slept };
}

test("the first truthy value ends the wait", async (t) => {
  const { sleep, slept } = fakeClock(t);
  const values: Array<{ id: number } | undefined> = [undefined, undefined, { id: 3 }];

  const value = await waitUntil("incident_not_created", async () => values.shift(), 60_000, sleep);

  assert.deepEqual(value, { id: 3 });
  assert.deepEqual(slept, [POLL_INTERVAL_MILLISECONDS, POLL_INTERVAL_MILLISECONDS]);
});

test("the last poll sleeps only the remaining budget before the condition code is raised", async (t) => {
  const { sleep, slept } = fakeClock(t);

  await assert.rejects(
    waitUntil("diagnosis_not_terminal", async () => false, 3_000, sleep),
    (error: unknown) =>
      error instanceof EvaluationError &&
      !(error instanceof TransientEvaluationError) &&
      error.code === "diagnosis_not_terminal" &&
      error.message === "A bounded evaluation condition was not observed",
  );
  assert.deepEqual(slept, [POLL_INTERVAL_MILLISECONDS, 1_000]);
});

test("transient failures are retried and the last one is rethrown at the deadline", async (t) => {
  const { sleep, slept } = fakeClock(t);
  const first = new TransientEvaluationError("http_unavailable", "first");
  const last = new TransientEvaluationError("http_unavailable", "last");
  const failures = [first, last];

  await assert.rejects(
    waitUntil("monitoring_not_healthy", async () => {
      throw failures.shift() ?? last;
    }, 4_000, sleep),
    (error: unknown) => error === last,
  );
  assert.deepEqual(slept, [POLL_INTERVAL_MILLISECONDS, POLL_INTERVAL_MILLISECONDS]);
});

test("a transient failure followed by success returns the value", async (t) => {
  const { sleep } = fakeClock(t);
  let attempts = 0;

  const value = await waitUntil(
    "port_forward_not_ready",
    async () => {
      attempts += 1;
      if (attempts === 1) throw new TransientEvaluationError("http_unavailable", "warming up");
      return "ready";
    },
    60_000,
    sleep,
  );

  assert.equal(value, "ready");
  assert.equal(attempts, 2);
});

test("non-transient errors propagate without polling", async (t) => {
  const { sleep, slept } = fakeClock(t);
  const failure = contractError("http_request_failed", "unexpected status");

  await assert.rejects(
    waitUntil("incident_not_created", async () => {
      throw failure;
    }, 60_000, sleep),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(slept, []);
});
