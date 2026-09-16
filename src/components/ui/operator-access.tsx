"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Logout must discard authenticated client router state via a full navigation. */

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  authenticatedFetch,
  readOperatorSession,
} from "@/lib/agent-runtime/operator-client";
import {
  parseConsoleSession,
  type ConsoleSessionView,
} from "@/lib/agent-runtime/operator-contracts";

export function OperatorAccess() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [session, setSession] = useState<ConsoleSessionView | null>(null);
  const logoutButton = useRef<HTMLButtonElement>(null);
  const isLogin = pathname === "/login";
  useEffect(() => {
    if (isLogin) return;
    let lastAttempt = -Infinity;
    let inFlight = false;
    let active = true;
    let current: ConsoleSessionView | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const remember = (value: ConsoleSessionView | null) => {
      if (!active) return;
      current = value;
      setSession(value);
      clearTimeout(expiryTimer);
      if (value?.expiresAt)
        expiryTimer = setTimeout(
          () => {
            void inspect();
          },
          Math.max(0, value.expiresAt * 1000 - Date.now()) + 50,
        );
    };
    const inspect = async () => {
      try {
        const value = await readOperatorSession();
        if (active && value === null) window.location.assign("/login");
        remember(value);
      } catch {
        /* Keep network failures distinct from a verified identity change. */
      }
    };
    const inspectOnFocus = () => {
      if (document.visibilityState === "visible") void inspect();
    };
    void inspect();
    window.addEventListener("focus", inspectOnFocus);
    document.addEventListener("visibilitychange", inspectOnFocus);
    const activity = (event: Event) => {
      if (
        event.target instanceof Node &&
        logoutButton.current?.contains(event.target)
      )
        return;
      if (
        !current?.csrfToken ||
        !event.isTrusted ||
        document.visibilityState !== "visible" ||
        inFlight ||
        Date.now() - lastAttempt < 60_000
      )
        return;
      lastAttempt = Date.now();
      inFlight = true;
      void authenticatedFetch("/api/runtime/operator/session", {
        method: "POST",
        cache: "no-store",
      })
        .then(async (response) => {
          if (response.ok) remember(parseConsoleSession(await response.json()));
        })
        .catch(() => {
          /* A network failure is not proof of revocation; retry on later activity. */
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of events)
      document.addEventListener(event, activity, { passive: true });
    return () => {
      active = false;
      clearTimeout(expiryTimer);
      window.removeEventListener("focus", inspectOnFocus);
      document.removeEventListener("visibilitychange", inspectOnFocus);
      for (const event of events) document.removeEventListener(event, activity);
    };
  }, [isLogin]);
  if (isLogin) return null;

  async function logout() {
    setPending(true);
    setFailed(false);
    try {
      const response = await authenticatedFetch(
        "/api/runtime/operator/logout",
        { method: "POST", cache: "no-store" },
      );
      if (!response.ok) throw new Error("Logout unavailable");
      if (session?.accessMode === "public_demo") window.location.reload();
      else window.location.assign("/login");
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="operator-access">
      <div className="operator-access__actions">
        {session && session.role !== "operator" ? (
          <a className="operator-logout" href="/login">
            登录
          </a>
        ) : null}
        {session?.role === "operator" ? (
          <button
            ref={logoutButton}
            className="operator-logout"
            type="button"
            disabled={pending}
            onClick={logout}
          >
            {pending ? "正在退出…" : "登出"}
          </button>
        ) : null}
      </div>
      {failed ? (
        <span className="inline-error" role="alert">
          退出失败，请重试。
        </span>
      ) : null}
    </div>
  );
}
