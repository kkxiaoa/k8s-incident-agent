import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { fetchOperatorSession } from "@/lib/agent-runtime/server-client";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "操作者登录" };

export default async function LoginPage() {
  const incoming = new Headers({ cookie: (await headers()).get("cookie") ?? "" });
  const session = await fetchOperatorSession(incoming);
  if (session.response.ok) redirect("/");
  return <main className={`page-shell ${styles.page}`}>
    <section className={styles.card} aria-labelledby="login-title">
      <span className="eyebrow">Operator access</span>
      <h1 id="login-title">回到事件现场</h1>
      <p className={styles.description}>登录后查看诊断与审计记录。人工操作由 Runtime 在固定沙箱范围内验证权限。</p>
      <LoginForm />
      <p className={styles.note}>连续 30 分钟无操作后需重新登录。退出或会话失效不会撤销已保存的审批，也不会中断正在处理的 Run。</p>
    </section>
  </main>;
}
