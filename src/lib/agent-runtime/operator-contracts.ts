import type { components } from "./generated";

export const OPERATOR_COOKIE = "__Host-k8s-incident-session";
export const OPERATOR_CSRF_HEADER = "X-CSRF-Token";
export type OperatorSessionView =
  components["schemas"]["OperatorSessionResponse"];
export type ConsoleSessionView =
  components["schemas"]["ConsoleSessionResponse"];

export function parseConsoleSession(value: unknown): ConsoleSessionView | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      "accessMode,csrfToken,expiresAt,role"
  )
    return null;
  const session = value as Record<string, unknown>;
  if (session.accessMode !== "private" && session.accessMode !== "public_demo")
    return null;
  if (session.role === "anonymous")
    return session.accessMode === "public_demo" &&
      session.expiresAt === null &&
      session.csrfToken === null
      ? {
          accessMode: "public_demo",
          role: "anonymous",
          expiresAt: null,
          csrfToken: null,
        }
      : null;
  if (
    session.role !== "operator" ||
    typeof session.expiresAt !== "number" ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= 0 ||
    typeof session.csrfToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(session.csrfToken)
  )
    return null;
  return {
    accessMode: session.accessMode,
    role: session.role,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
  };
}

export function parseOperatorSession(
  value: unknown,
): OperatorSessionView | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "csrfToken,expiresAt,operatorRef"
  )
    return null;
  const session = value as Record<string, unknown>;
  if (
    session.operatorRef !== "sandbox-operator" ||
    typeof session.expiresAt !== "number" ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= 0 ||
    typeof session.csrfToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(session.csrfToken)
  )
    return null;
  return {
    operatorRef: session.operatorRef,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
  };
}
