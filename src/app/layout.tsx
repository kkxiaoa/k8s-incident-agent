import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { ScrollTop } from "@/components/ui/scroll-top";
import { OperatorAccess } from "@/components/ui/operator-access";
import { UiIcon } from "@/components/ui/ui-icon";
import { getYamlAssistantUrl } from "@/lib/agent-runtime/server-config";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "K8s Incident Agent",
    template: "%s · K8s Incident Agent",
  },
  description:
    "Kubernetes incident response from failure discovery and evidence diagnosis to controlled remediation and recovery verification.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const yamlAssistantUrl = getYamlAssistantUrl();

  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>
        <div className="app-shell">
          <header className="site-header">
            <Link
              className="brand"
              href="/"
              aria-label="K8s Incident Agent 首页"
            >
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
            <div className="site-header__actions">
              {yamlAssistantUrl === null ? null : (
                <a className="product-link" href={yamlAssistantUrl}>
                  YAML 编写助手
                  <UiIcon name="external-link" />
                </a>
              )}
              <OperatorAccess />
            </div>
          </header>
          {children}
          <footer className="site-footer">
            <span>Evidence-first Kubernetes incident response</span>
            <span>
              Runtime 是 Incident、Run、Evidence 与 Diagnosis 的权威来源
            </span>
          </footer>
        </div>
        <ScrollTop />
      </body>
    </html>
  );
}
