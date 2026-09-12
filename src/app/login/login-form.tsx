"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Authentication changes must discard the client router cache via a full navigation. */

import { useState, type FormEvent } from "react";
import { parseOperatorSession } from "@/lib/agent-runtime/operator-contracts";
import styles from "./login.module.css";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/runtime/operator/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }), cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      setPassword("");
      if (response.status === 401) setError("口令不正确，请重试。");
      else if (response.status === 429) setError("登录尝试过于频繁，请稍后重试。");
      else if (response.status === 403) setError("当前访问地址不在允许的登录来源内。");
      else if (response.ok && parseOperatorSession(await response.json()) !== null) {
        window.location.assign("/");
        return;
      } else setError("认证服务暂不可用，请检查 Runtime 配置或稍后重试。");
    } catch {
      setPassword("");
      setError("暂时无法连接认证服务，请稍后重试。");
    }
    setPending(false);
  }

  return <form className={styles.form} onSubmit={submit}>
    <label className="field-label" htmlFor="operator-password">操作者口令</label>
    <input id="operator-password" name="password" className={styles.input} type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={pending} />
    <button className={`primary-button ${styles.submit}`} type="submit" disabled={pending}>{pending ? "正在验证…" : "进入 Incident Console"}</button>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </form>;
}
