import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { FetchLike } from "../../src/environment/http.ts";
import { isOperatorSession, operatorFetch } from "../../src/environment/operator-session.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { temporaryDirectory } from "../support/fixtures.ts";

const RUNTIME = "http://127.0.0.1:18080";
const CONSOLE = "http://127.0.0.1:13000";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestInit["redirect"];
  body: string | undefined;
}

interface RuntimeOptions {
  cookieSuffix?: string;
  cookies?: (cookie: string) => string[];
  session?: (session: Record<string, unknown>) => Record<string, unknown>;
  loginStatus?: number;
  expiresInSeconds?: number;
}

function credentials(t: TestContext) {
  const directory = temporaryDirectory(t, "evaluation-operator-");
  const password = randomBytes(32).toString("base64url");
  const file = path.join(directory, "password");
  writeFileSync(file, password, { mode: 0o600 });
  return { directory, password, file };
}

// A Runtime that issues one session per login and rejects any request whose cookie is not the current one.
function fakeRuntime(password: string, options: RuntimeOptions = {}) {
  const state = { logins: 0, cookie: "", csrf: "", calls: [] as Call[] };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    state.calls.push({ url: url.href, method: init?.method ?? "GET", headers, redirect: init?.redirect, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.href === `${RUNTIME}/api/v1/operator/login`) {
      assert.equal(JSON.parse(init?.body as string).password === password, true);
      state.logins += 1;
      state.cookie = `__Host-k8s-incident-session=${randomBytes(32).toString("base64url")}`;
      state.csrf = randomBytes(32).toString("hex");
      const session = options.session?.({ operatorRef: "sandbox-operator", expiresAt: Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3600), csrfToken: state.csrf })
        ?? { operatorRef: "sandbox-operator", expiresAt: Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3600), csrfToken: state.csrf };
      const response = new Response(JSON.stringify(session), { status: options.loginStatus ?? 200, headers: { "content-type": "application/json" } });
      const cookie = `${state.cookie}; ${options.cookieSuffix ?? "HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600"}`;
      for (const value of options.cookies?.(cookie) ?? [cookie]) response.headers.append("set-cookie", value);
      return response;
    }
    const protectedPath = (url.origin === RUNTIME && url.pathname.startsWith("/api/v1/")) || (url.origin === CONSOLE && url.pathname !== "/api/healthz");
    if (protectedPath && (state.cookie === "" || headers.get("cookie") !== state.cookie)) {
      return new Response(JSON.stringify({ error: { code: "operator_authentication_required" } }), { status: 401 });
    }
    return new Response("ok", { status: 200 });
  };
  return { fetchImpl, state };
}

const authenticationFailed = (secrets: string[]) => (error: unknown) => {
  assert.ok(error instanceof EvaluationError);
  assert.equal(error.code, "operator_authentication_failed");
  for (const secret of secrets) assert.equal(error.message.includes(secret), false);
  return true;
};

test("the session logs in once, sends the cookie only to protected paths and CSRF only on mutations", async (t) => {
  const { password, file } = credentials(t);
  const runtime = fakeRuntime(password);
  const fetchImpl = await operatorFetch(runtime.fetchImpl, "kind-evaluation", { OPERATOR_ORIGIN: CONSOLE, OPERATOR_PASSWORD_FILE: file });
  const login = runtime.state.calls[0];
  assert.deepEqual({ method: login.method, origin: login.headers.get("origin"), type: login.headers.get("content-type"), redirect: login.redirect }, { method: "POST", origin: CONSOLE, type: "application/json", redirect: "error" });

  await fetchImpl(`${RUNTIME}/api/v1/incidents`);
  await fetchImpl(`${RUNTIME}/api/v1/incidents`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await fetchImpl(`${RUNTIME}/healthz`);
  await fetchImpl(`${CONSOLE}/incidents/x`);
  await fetchImpl(`${CONSOLE}/api/healthz`);
  await fetchImpl("http://127.0.0.1:19090/api/v1/query", { headers: { Accept: "application/json" } });
  const [read, mutation, health, consolePage, consoleHealth, prometheus] = runtime.state.calls.slice(1);
  assert.equal(read.headers.get("cookie"), runtime.state.cookie);
  assert.equal(read.headers.has("x-csrf-token"), false);
  assert.equal(read.headers.has("origin"), false);
  assert.equal(mutation.headers.get("cookie"), runtime.state.cookie);
  assert.equal(mutation.headers.get("x-csrf-token"), runtime.state.csrf);
  assert.equal(mutation.headers.get("origin"), CONSOLE);
  assert.equal(mutation.headers.get("content-type"), "application/json");
  for (const call of [health, consoleHealth, prometheus]) {
    assert.equal(call.headers.has("cookie"), false, call.url);
    assert.equal(call.headers.has("x-csrf-token"), false, call.url);
  }
  assert.equal(consolePage.headers.get("cookie"), runtime.state.cookie);
  assert.ok(runtime.state.calls.every((call) => call.redirect === "error"));
  assert.equal(runtime.state.logins, 1);
});

test("a revoked session is renewed once for reads and never for mutations, with parallel renewals coalesced", async (t) => {
  const { password, file } = credentials(t);
  const runtime = fakeRuntime(password);
  const fetchImpl = await operatorFetch(runtime.fetchImpl, "kind-evaluation", { OPERATOR_ORIGIN: CONSOLE, OPERATOR_PASSWORD_FILE: file });

  runtime.state.cookie = "";
  const responses = await Promise.all([fetchImpl(`${RUNTIME}/api/v1/incidents`), fetchImpl(`${RUNTIME}/api/v1/incidents/x`)]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(runtime.state.logins, 2);

  runtime.state.cookie = "";
  const mutation = await fetchImpl(`${RUNTIME}/api/v1/incidents/x/runs`, { method: "POST", body: "{}" });
  assert.equal(mutation.status, 401);
  assert.equal(runtime.state.logins, 2);
  const loginAttempts = () => runtime.state.calls.filter((call) => call.url.endsWith("/operator/login")).length;
  assert.equal(loginAttempts(), 2);
});

test("an expired session is renewed before the next protected request", async (t) => {
  const { password, file } = credentials(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-05T00:00:00Z") });
  const runtime = fakeRuntime(password, { expiresInSeconds: 10 });
  const fetchImpl = await operatorFetch(runtime.fetchImpl, "kind-evaluation", { OPERATOR_ORIGIN: CONSOLE, OPERATOR_PASSWORD_FILE: file });
  await fetchImpl(`${RUNTIME}/api/v1/incidents`);
  assert.equal(runtime.state.logins, 1);
  t.mock.timers.tick(11_000);
  await fetchImpl(`${RUNTIME}/api/v1/incidents`);
  assert.equal(runtime.state.logins, 2);
});

test("K3s profiles require an https operator origin while Kind requires the forwarded Console", async (t) => {
  const { password, file } = credentials(t);
  const secrets = [password];
  await operatorFetch(fakeRuntime(password).fetchImpl, "k3s-public", { OPERATOR_ORIGIN: "https://console.example.test", OPERATOR_PASSWORD_FILE: file });
  for (const [profile, origin] of [
    ["k3s-public", CONSOLE],
    ["k3s-evaluation", "http://console.example.test"],
    ["kind-evaluation", "https://console.example.test"],
    ["kind-evaluation", `${CONSOLE}/`],
    ["kind-evaluation", `${CONSOLE}/path`],
    ["kind-evaluation", "http://user:secret@127.0.0.1:13000"],
    ["kind-evaluation", undefined],
  ] as const) {
    await assert.rejects(
      operatorFetch(fakeRuntime(password).fetchImpl, profile, { OPERATOR_ORIGIN: origin, OPERATOR_PASSWORD_FILE: file }),
      authenticationFailed(secrets),
      `${profile} ${origin}`,
    );
  }
});

test("the password file must be an absolute, private, bounded regular file", async (t) => {
  const { directory, password, file } = credentials(t);
  const environment = (passwordFile: string | undefined) => ({ OPERATOR_ORIGIN: CONSOLE, OPERATOR_PASSWORD_FILE: passwordFile });
  const attempt = (passwordFile: string | undefined) =>
    assert.rejects(operatorFetch(fakeRuntime(password).fetchImpl, "kind-evaluation", environment(passwordFile)), authenticationFailed([password]), String(passwordFile));

  await attempt(undefined);
  await attempt("relative/password");
  await attempt(path.join(directory, "absent"));
  const shared = path.join(directory, "shared");
  writeFileSync(shared, password, { mode: 0o640 });
  await attempt(shared);
  const empty = path.join(directory, "empty");
  writeFileSync(empty, "", { mode: 0o600 });
  await attempt(empty);
  const oversized = path.join(directory, "oversized");
  writeFileSync(oversized, "x".repeat(1025), { mode: 0o600 });
  await attempt(oversized);
  const linked = path.join(directory, "linked");
  symlinkSync(file, linked);
  await attempt(linked);
  chmodSync(file, 0o600);
  await attempt(directory);
  await operatorFetch(fakeRuntime(password).fetchImpl, "kind-evaluation", environment(file));
});

test("a login response must carry exactly one hardened session cookie and a valid session", async (t) => {
  const { password, file } = credentials(t);
  const environment = { OPERATOR_ORIGIN: CONSOLE, OPERATOR_PASSWORD_FILE: file };
  const rejects = (options: RuntimeOptions, label: string) =>
    assert.rejects(operatorFetch(fakeRuntime(password, options).fetchImpl, "kind-evaluation", environment), authenticationFailed([password]), label);

  await rejects({ loginStatus: 401 }, "status");
  await rejects({ cookieSuffix: "Secure; SameSite=strict; Path=/" }, "HttpOnly");
  await rejects({ cookieSuffix: "HttpOnly; SameSite=strict; Path=/" }, "Secure");
  await rejects({ cookieSuffix: "HttpOnly; Secure; SameSite=lax; Path=/" }, "SameSite");
  await rejects({ cookieSuffix: "HttpOnly; Secure; SameSite=strict; Path=/api" }, "Path");
  await rejects({ cookieSuffix: "HttpOnly; Secure; SameSite=strict; Path=/; Domain=example.test" }, "Domain");
  await rejects({ cookies: (cookie) => [cookie, "other=1; Secure"] }, "two cookies");
  await rejects({ cookies: () => [] }, "no cookie");
  await rejects({ cookies: (cookie) => [cookie.replace("__Host-k8s-incident-session=", "session=")] }, "name");
  await rejects({ cookies: (cookie) => [`${cookie}; ${"x".repeat(512)}`] }, "length");
  await rejects({ session: (session) => ({ ...session, operatorRef: "root" }) }, "operatorRef");
  await rejects({ session: (session) => ({ ...session, csrfToken: "short" }) }, "csrf");
  await rejects({ expiresInSeconds: -1 }, "expired");
  await rejects({ session: () => ({}) }, "shape");
});

test("the session predicate mirrors the login checks", () => {
  const session = { operatorRef: "sandbox-operator", expiresAt: 1_800_000_000, csrfToken: "a".repeat(64) };
  assert.equal(isOperatorSession(session, 1_700_000_000), true);
  assert.equal(isOperatorSession(session, 1_800_000_000), false);
  assert.equal(isOperatorSession({ ...session, csrfToken: "A".repeat(64) }, 0), false);
  assert.equal(isOperatorSession({ ...session, expiresAt: "soon" }, 0), false);
  assert.equal(isOperatorSession(null, 0), false);
});
