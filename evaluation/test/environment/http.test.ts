import assert from "node:assert/strict";
import test from "node:test";

import {
  bindJsonReader,
  MAX_HTTP_BODY_BYTES,
  readEventStream,
  readResponseBytes,
  request,
  requestJson,
  requestStatus,
  requestText,
  type FetchLike,
} from "../../src/environment/http.ts";
import { contractError, EvaluationError, TransientEvaluationError } from "../../src/shared/errors.ts";

const ORIGIN = "http://127.0.0.1:18080";

function coded(code: string, transient = false) {
  return (error: unknown) =>
    error instanceof EvaluationError && error.code === code && (error instanceof TransientEvaluationError) === transient;
}

function responding(status: number, body: string | null = "{}", headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status, headers });
  };
  return { fetchImpl, calls };
}

function streaming(chunks: Uint8Array[], status = 200) {
  let cancelled = false;
  // No read-ahead: the source closes only when a read finds nothing left, so a cancel can be observed.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const fetchImpl: FetchLike = async () => new Response(body, { status });
  return { fetchImpl, wasCancelled: () => cancelled };
}

test("requests send the origin, path, JSON accept header, method, body and a bounded timeout", async () => {
  const { fetchImpl, calls } = responding(201, '{"ok":true}');
  const result = await request(fetchImpl, ORIGIN, "/api/v1/incidents", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(result, { body: '{"ok":true}', ok: true, status: 201 });
  assert.equal(calls[0].url, `${ORIGIN}/api/v1/incidents`);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, "{}");
  assert.deepEqual(calls[0].init?.headers, { Accept: "application/json", "content-type": "application/json" });
  assert.ok(calls[0].init?.signal instanceof AbortSignal);

  const text = responding(200, "<html>");
  await request(text.fetchImpl, ORIGIN, "/", { accept: "text/html" });
  assert.deepEqual(text.calls[0].init?.headers, { Accept: "text/html" });
  assert.equal(text.calls[0].init?.method, "GET");
  assert.equal("body" in (text.calls[0].init ?? {}), false);
});

test("network failures are transient while evaluation errors thrown by the transport pass through", async () => {
  await assert.rejects(request(async () => { throw new TypeError("fetch failed"); }, ORIGIN, "/"), coded("http_unavailable", true));
  const own = contractError("operator_authentication_failed", "auth");
  await assert.rejects(request(async () => { throw own; }, ORIGIN, "/"), (error: unknown) => error === own);
});

test("text reads classify statuses: transient only when the caller allows it, otherwise a request failure", async () => {
  await assert.rejects(
    requestText(responding(503).fetchImpl, ORIGIN, "/", { transientStatuses: new Set([502, 503, 504]) }),
    coded("http_unavailable", true),
  );
  await assert.rejects(requestText(responding(503).fetchImpl, ORIGIN, "/"), coded("http_request_failed"));
  await assert.rejects(requestText(responding(404).fetchImpl, ORIGIN, "/", { transientStatuses: new Set([503]) }), coded("http_request_failed"));
  assert.equal(await requestText(responding(200, "ok").fetchImpl, ORIGIN, "/"), "ok");
  assert.equal(await requestStatus(responding(405, "").fetchImpl, ORIGIN, "/api/v1/incidents", { method: "POST" }), 405);
});

test("JSON reads reject malformed documents and the bound reader forwards options", async () => {
  assert.deepEqual(await requestJson(responding(200, '{"a":1}').fetchImpl, ORIGIN, "/"), { a: 1 });
  await assert.rejects(requestJson(responding(200, "{not json").fetchImpl, ORIGIN, "/"), coded("upstream_contract_invalid"));
  const { fetchImpl, calls } = responding(503, "");
  const read = bindJsonReader(fetchImpl, ORIGIN);
  await assert.rejects(read("/api/v1/monitoring/health", { transientStatuses: new Set([503]) }), coded("http_unavailable", true));
  assert.equal(calls[0].url, `${ORIGIN}/api/v1/monitoring/health`);
});

test("response bodies are bounded, decoded strictly and cancelled after reading", async () => {
  const oversized = streaming([new Uint8Array(MAX_HTTP_BODY_BYTES), new Uint8Array(1)]);
  await assert.rejects(request(oversized.fetchImpl, ORIGIN, "/"), coded("response_too_large"));
  assert.equal(oversized.wasCancelled(), true);

  const exact = streaming([new Uint8Array(MAX_HTTP_BODY_BYTES).fill(0x20)]);
  assert.equal((await request(exact.fetchImpl, ORIGIN, "/")).body.length, MAX_HTTP_BODY_BYTES);

  const invalid = streaming([new Uint8Array([0xff, 0xfe])]);
  await assert.rejects(request(invalid.fetchImpl, ORIGIN, "/"), (error: unknown) => error instanceof TypeError);

  assert.equal((await readResponseBytes(new Response(null), 10)).length, 0);
});

test("the event stream is read until the consumer stops, bounded, and only from a live 200 body", async () => {
  const encoder = new TextEncoder();
  const consumed: string[] = [];
  const stream = streaming([encoder.encode("id: 1\n"), encoder.encode("event: a\n\n"), encoder.encode("id: 2\n\n")]);
  await readEventStream(stream.fetchImpl, ORIGIN, "/api/v1/incidents/x/events", (chunk) => {
    consumed.push(chunk);
    return chunk.endsWith("\n\n");
  });
  assert.deepEqual(consumed, ["id: 1\n", "event: a\n\n"]);
  assert.equal(stream.wasCancelled(), true);

  const headers: Array<Record<string, string>> = [];
  const capturing: FetchLike = async (_input, init) => {
    headers.push(init?.headers as Record<string, string>);
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(null, { status: 200 });
  };
  await assert.rejects(readEventStream(capturing, ORIGIN, "/events", () => true), coded("sse_replay_failed"));
  assert.deepEqual(headers[0], { "Last-Event-ID": "0", Accept: "text/event-stream" });
  await assert.rejects(readEventStream(streaming([], 500).fetchImpl, ORIGIN, "/events", () => true), coded("sse_replay_failed"));

  const oversized = streaming([new Uint8Array(MAX_HTTP_BODY_BYTES), new Uint8Array(1)]);
  await assert.rejects(readEventStream(oversized.fetchImpl, ORIGIN, "/events", () => false), coded("response_too_large"));

  const exhausted = streaming([encoder.encode("id: 1\n")]);
  await readEventStream(exhausted.fetchImpl, ORIGIN, "/events", () => false);
});
