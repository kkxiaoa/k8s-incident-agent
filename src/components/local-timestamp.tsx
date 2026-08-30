"use client";

import { useId } from "react";

const LOCALE = "zh-CN";
const FORMAT_OPTIONS = {
  day: "2-digit",
  fractionalSecondDigits: 3,
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZoneName: "shortOffset",
  year: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? timestamp
    : new Intl.DateTimeFormat(LOCALE, FORMAT_OPTIONS).format(date);
}

function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function LocalTimestamp({ timestamp }: { timestamp: string }) {
  const id = useId();
  const script = `{var n=document.getElementById(${scriptLiteral(id)}),d=new Date(${scriptLiteral(timestamp)});if(n&&!Number.isNaN(d.valueOf()))n.textContent=new Intl.DateTimeFormat(${scriptLiteral(LOCALE)},${JSON.stringify(FORMAT_OPTIONS)}).format(d)}`;

  return (
    <>
      <time id={id} dateTime={timestamp} suppressHydrationWarning>
        {formatTimestamp(timestamp)}
      </time>
      <InlineScript html={script} />
    </>
  );
}
