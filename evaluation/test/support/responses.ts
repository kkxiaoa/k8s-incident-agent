export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export function textResponse(value: string): Response {
  return new Response(value, { status: 200 });
}
