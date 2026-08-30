import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "K8s Incident Agent",
    template: "%s · K8s Incident Agent",
  },
  description: "Evidence-first Kubernetes incident diagnosis for a local Kind sandbox.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="app-shell">
          <header className="site-header">
            <Link className="brand" href="/" aria-label="K8s Incident Agent 首页">
              <Image
                className="brand__mark"
                src="/icon.svg"
                alt=""
                width={38}
                height={38}
                aria-hidden="true"
                unoptimized
              />
              <span>
                <strong>K8s Incident Agent</strong>
                <small>Evidence-first runtime response</small>
              </span>
            </Link>
            <span className="read-only-pill">
              <span aria-hidden="true" />
              Local Kind · 只读诊断
            </span>
          </header>
          {children}
          <footer className="site-footer">
            <span>K8s Incident Agent · Stage 1</span>
            <span>Runtime 是 Incident、Run、Evidence 与 Diagnosis 的权威来源</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
