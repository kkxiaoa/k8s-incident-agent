"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Logout must discard authenticated client router state via a full navigation. */

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authenticatedFetch } from "@/lib/agent-runtime/operator-client";

export function OperatorAccess() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const logoutButton = useRef<HTMLButtonElement>(null);
  const isLogin = pathname === "/login";
  useEffect(() => {
    if (isLogin) return;
    let lastAttempt = -Infinity;
    let inFlight = false;
    const activity = (event: Event) => {
      if (event.target instanceof Node && logoutButton.current?.contains(event.target)) return;
      if (!event.isTrusted || document.visibilityState !== "visible" || inFlight || Date.now() - lastAttempt < 60_000) return;
      lastAttempt = Date.now();
      inFlight = true;
      void authenticatedFetch("/api/runtime/operator/session", { method: "POST", cache: "no-store" })
        .catch(() => { /* A network failure is not proof of revocation; retry on later activity. */ })
        .finally(() => { inFlight = false; });
    };
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of events) document.addEventListener(event, activity, { passive: true });
    return () => { for (const event of events) document.removeEventListener(event, activity); };
  }, [isLogin]);
  if (isLogin) return null;

  async function logout() {
    setPending(true);
    setFailed(false);
    try {
      const response = await authenticatedFetch("/api/runtime/operator/logout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error("Logout unavailable");
      window.location.assign("/login");
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return <div className="operator-access">
    <button ref={logoutButton} className="operator-logout" type="button" disabled={pending} onClick={logout}>{pending ? "正在退出…" : "退出登录"}</button>
    {failed ? <span className="inline-error" role="alert">退出失败，请重试。</span> : null}
  </div>;
}
