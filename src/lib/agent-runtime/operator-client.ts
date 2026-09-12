/* eslint-disable @next/next/no-location-assign-relative-destination -- Session loss must discard authenticated client router state via a full navigation. */
import { OPERATOR_CSRF_HEADER, parseOperatorSession, type OperatorSessionView } from "./operator-contracts";

export async function readOperatorSession(): Promise<OperatorSessionView | null> {
  const response = await fetch("/api/runtime/operator/session", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status === 401) return null;
  if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) throw new Error("Authentication unavailable");
  const session = parseOperatorSession(await response.json());
  if (session === null) throw new Error("Authentication unavailable");
  return session;
}

export async function checkOperatorSession(): Promise<void> {
  try {
    if (await readOperatorSession() === null) window.location.assign("/login");
  } catch {
    // A disconnected Runtime is not proof that the user's session was revoked.
  }
}

export async function authenticatedFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method !== undefined && !["GET", "HEAD"].includes(init.method)) {
    const session = await readOperatorSession();
    if (session === null) {
      window.location.assign("/login");
      return new Response(null, { status: 401 });
    }
    headers.set(OPERATOR_CSRF_HEADER, session.csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", redirect: "error", signal: init.signal ?? AbortSignal.timeout(15_000) });
  if (response.status === 401) window.location.assign("/login");
  return response;
}
