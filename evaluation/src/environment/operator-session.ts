import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { components } from "../contracts/runtime-api.generated.ts";
import { contractError } from "../shared/errors.ts";
import { isPlainObject } from "../shared/guards.ts";
import { HTTP_TIMEOUT_MILLISECONDS } from "../shared/wait.ts";
import { readResponseBytes, type FetchLike } from "./http.ts";
import { endpointOrigin } from "./tunnels.ts";

export type OperatorSession = components["schemas"]["OperatorSessionResponse"];

const MAX_PASSWORD_BYTES = 1024;
const MAX_SESSION_RESPONSE_BYTES = 8192;

export function isOperatorSession(value: unknown, nowSeconds: number): value is OperatorSession {
  return (
    isPlainObject(value) &&
    value.operatorRef === "sandbox-operator" &&
    Number.isSafeInteger(value.expiresAt) &&
    (value.expiresAt as number) > nowSeconds &&
    typeof value.csrfToken === "string" &&
    /^[a-f0-9]{64}$/.test(value.csrfToken)
  );
}

// Every failure collapses to one code: the reasons would otherwise describe the credential.
function authenticationFailed() {
  return contractError("operator_authentication_failed", "Evaluation operator authentication failed");
}

async function readPassword(filename: unknown): Promise<string> {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) throw authenticationFailed();
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > MAX_PASSWORD_BYTES) {
      throw authenticationFailed();
    }
    const bytes = Buffer.alloc(MAX_PASSWORD_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 1 || bytesRead > MAX_PASSWORD_BYTES) throw authenticationFailed();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

function requireOrigin(profile: string, configured: unknown): URL {
  if (typeof configured !== "string") throw authenticationFailed();
  const origin = new URL(configured);
  if (
    origin.origin !== configured ||
    origin.username ||
    origin.password ||
    (profile === "kind-evaluation"
      ? configured !== endpointOrigin("console")
      : origin.protocol !== "https:")
  ) {
    throw authenticationFailed();
  }
  return origin;
}

function isSessionCookie(cookies: string[]): boolean {
  if (cookies.length !== 1) return false;
  const [cookie] = cookies;
  return (
    cookie.length <= 512 &&
    /^__Host-k8s-incident-session=[A-Za-z0-9_-]{43};/.test(cookie) &&
    /(?:^|;\s*)HttpOnly(?:;|$)/i.test(cookie) &&
    /(?:^|;\s*)Secure(?:;|$)/i.test(cookie) &&
    /(?:^|;\s*)SameSite=strict(?:;|$)/i.test(cookie) &&
    /(?:^|;\s*)Path=\/(?:;|$)/i.test(cookie) &&
    !/(?:^|;\s*)Domain=/i.test(cookie)
  );
}

export async function operatorFetch(
  fetchImpl: FetchLike,
  profile: string,
  environment: Record<string, string | undefined>,
): Promise<FetchLike> {
  let origin: URL;
  let password: string;
  try {
    origin = requireOrigin(profile, environment.OPERATOR_ORIGIN);
    password = await readPassword(environment.OPERATOR_PASSWORD_FILE);
  } catch {
    throw authenticationFailed();
  }
  let cookie = "";
  let csrf = "";
  let expiresAt = 0;
  let pendingLogin: Promise<void> | undefined;
  async function login(): Promise<void> {
    if (pendingLogin) return pendingLogin;
    pendingLogin = (async () => {
      try {
        const response = await fetchImpl(`${endpointOrigin("runtime")}/api/v1/operator/login`, {
          method: "POST",
          headers: { "content-type": "application/json", Origin: origin.origin },
          body: JSON.stringify({ password }),
          redirect: "error",
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS),
        });
        if (response.status !== 200) throw authenticationFailed();
        const bytes = await readResponseBytes(response, MAX_SESSION_RESPONSE_BYTES);
        const session: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const cookies = response.headers.getSetCookie();
        if (!isSessionCookie(cookies) || !isOperatorSession(session, Date.now() / 1000)) {
          throw authenticationFailed();
        }
        cookie = cookies[0].split(";")[0];
        csrf = session.csrfToken;
        expiresAt = session.expiresAt;
      } catch {
        throw authenticationFailed();
      }
    })();
    try {
      await pendingLogin;
    } finally {
      pendingLogin = undefined;
    }
  }
  await login();
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const runtime = url.origin === endpointOrigin("runtime");
    const console = url.origin === endpointOrigin("console");
    if ((!runtime && !console) || url.pathname === "/healthz" || url.pathname === "/api/healthz") {
      return fetchImpl(input, { ...init, redirect: "error" });
    }
    if (expiresAt <= Date.now() / 1000) await login();
    const method = init.method ?? "GET";
    const send = () => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", cookie);
      if (!["GET", "HEAD"].includes(method)) {
        headers.set("Origin", origin.origin);
        headers.set("X-CSRF-Token", csrf);
      }
      return fetchImpl(input, { ...init, headers, redirect: "error" });
    };
    let response = await send();
    // Only reads can be retried after Runtime restart/revocation. Mutations keep
    // their original failure; a lost response is never permission to replay.
    if (response.status === 401 && ["GET", "HEAD"].includes(method)) {
      await response.body?.cancel();
      await login();
      response = await send();
    }
    return response;
  };
}
