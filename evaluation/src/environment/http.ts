import {
  contractError,
  EvaluationError,
  responseTooLarge,
  TransientEvaluationError,
} from "../shared/errors.ts";
import { parseJson, type ReadJson, type ReadOptions } from "../shared/json.ts";
import { HTTP_TIMEOUT_MILLISECONDS } from "../shared/wait.ts";

export const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RequestOptions extends ReadOptions {
  accept?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

interface RequestResult {
  body: string;
  ok: boolean;
  status: number;
}

export async function request(
  fetchImpl: FetchLike,
  origin: string,
  pathname: string,
  options: RequestOptions = {},
): Promise<RequestResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${pathname}`, {
      headers: { Accept: options.accept ?? "application/json", ...options.headers },
      method: options.method ?? "GET",
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS),
    });
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new TransientEvaluationError(
      "http_unavailable",
      "An evaluation endpoint is temporarily unavailable",
    );
  }
  const body = await readResponseBytes(response, MAX_HTTP_BODY_BYTES);
  return {
    body: new TextDecoder("utf-8", { fatal: true }).decode(body),
    ok: response.ok,
    status: response.status,
  };
}

export async function requestText(
  fetchImpl: FetchLike,
  origin: string,
  pathname: string,
  options: RequestOptions = {},
): Promise<string> {
  const result = await request(fetchImpl, origin, pathname, options);
  if (!result.ok) {
    if (options.transientStatuses?.has(result.status)) {
      throw new TransientEvaluationError(
        "http_unavailable",
        "An evaluation endpoint is temporarily unavailable",
      );
    }
    throw contractError(
      "http_request_failed",
      "An evaluation endpoint returned an unexpected status",
    );
  }
  return result.body;
}

export async function requestJson(
  fetchImpl: FetchLike,
  origin: string,
  pathname: string,
  options: RequestOptions = {},
): Promise<unknown> {
  return parseJson(await requestText(fetchImpl, origin, pathname, options));
}

export async function requestStatus(
  fetchImpl: FetchLike,
  origin: string,
  pathname: string,
  options: RequestOptions = {},
): Promise<number> {
  return (await request(fetchImpl, origin, pathname, options)).status;
}

export function bindJsonReader(fetchImpl: FetchLike, origin: string): ReadJson {
  return (pathname, options) => requestJson(fetchImpl, origin, pathname, options);
}

export async function readResponseBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw responseTooLarge();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel();
  }
}

// Streams the persisted event replay; the consumer says when the cursor has been reached so
// the rest of the open stream is cancelled instead of read.
export async function readEventStream(
  fetchImpl: FetchLike,
  origin: string,
  pathname: string,
  consume: (chunk: string) => boolean,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetchImpl(`${origin}${pathname}`, {
      headers: { "Last-Event-ID": "0", Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      throw contractError("sse_replay_failed", "SSE replay was not available");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let stopped = false;
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_BODY_BYTES) throw responseTooLarge();
      stopped = consume(decoder.decode(value, { stream: true }));
    }
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
