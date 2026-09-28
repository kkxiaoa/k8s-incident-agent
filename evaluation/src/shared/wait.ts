import {
  contractError,
  TransientEvaluationError,
  type EvaluationErrorCode,
} from "./errors.ts";

export const HTTP_TIMEOUT_MILLISECONDS = 15_000;
export const POLL_INTERVAL_MILLISECONDS = 2_000;
export const HEALTH_TIMEOUT_MILLISECONDS = 2 * 60_000;
export const DIAGNOSIS_TIMEOUT_MILLISECONDS = 5 * 60_000;
export const RESOLUTION_TIMEOUT_MILLISECONDS = 3 * 60_000;
export const POST_RESOLUTION_TIMEOUT_MILLISECONDS = 90_000;
export const ALERT_REPEAT_WAIT_MILLISECONDS = 5 * 60_000 + 30_000;
export const PORT_FORWARD_TIMEOUT_MILLISECONDS = 60_000;
export const COMMAND_TIMEOUT_MILLISECONDS = 5 * 60_000;

export type Sleep = (milliseconds: number) => Promise<void>;

// Polls until the operation yields a truthy value. Transient failures are retried within the
// budget and the last one is rethrown at the deadline; any other error propagates at once.
export async function waitUntil<T>(
  code: EvaluationErrorCode,
  operation: () => Promise<T | false | null | undefined>,
  timeoutMilliseconds: number,
  sleep: Sleep,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastTransient: TransientEvaluationError | undefined;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      if (!(error instanceof TransientEvaluationError)) throw error;
      lastTransient = error;
    }
    await sleep(Math.min(POLL_INTERVAL_MILLISECONDS, deadline - Date.now()));
  }
  if (lastTransient !== undefined) throw lastTransient;
  throw contractError(code, "A bounded evaluation condition was not observed");
}
