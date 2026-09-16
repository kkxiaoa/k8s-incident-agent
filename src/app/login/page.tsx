import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchOperatorSession } from "@/lib/agent-runtime/server-client";
import { parseConsoleSession } from "@/lib/agent-runtime/operator-contracts";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "登录" };

export default async function LoginPage() {
  const incoming = new Headers({ cookie: (await headers()).get("cookie") ?? "" });
  const session = await fetchOperatorSession(incoming);
  const access = parseConsoleSession(session.value);
  if (access?.role === "operator") redirect("/");
  return <main className={`page-shell ${styles.page}`}>
    <section className={styles.card} aria-labelledby="login-title">
      <span className="eyebrow">Operator access</span>
      <h1 id="login-title">回到事件现场</h1>
      <p className={styles.description}>{access?.accessMode === "public_demo" ? "公开演示可浏览历史、监控、诊断与修复进展。登录后可发起诊断、准备提案和审批执行。" : "登录后查看诊断与审计记录。人工操作由 Runtime 在固定沙箱范围内验证权限。"}</p>
      <LoginForm />
      {access?.accessMode === "public_demo" ? <Link href="/">返回公开演示</Link> : null}
      <p className={styles.note}>连续 1 小时无操作后需重新登录。退出或会话失效不会撤销已保存的审批，也不会中断正在处理的 Run。</p>
    </section>
  </main>;
}
