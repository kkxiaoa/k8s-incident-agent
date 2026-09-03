"use client";

import { useSyncExternalStore } from "react";

const LOCALE = "zh-CN";
const FORMAT_OPTIONS = {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  year: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(LOCALE, FORMAT_OPTIONS);

function subscribeToHydration(): () => void {
  return () => undefined;
}

export function LocalTimestamp({ timestamp }: { timestamp: string }) {
  // The server cannot know the browser timezone, so local formatting starts
  // after hydration instead of rendering a potentially incorrect time first.
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const date = new Date(timestamp);
  const valid = !Number.isNaN(date.valueOf());
  const pending = valid && !hydrated;
  const displayValue = valid ? TIMESTAMP_FORMATTER.format(date) : timestamp;

  return (
    <time
      className={pending ? "local-timestamp local-timestamp--pending" : "local-timestamp"}
      dateTime={timestamp}
      aria-busy={pending || undefined}
      aria-label={pending ? "本地时间加载中" : undefined}
    >
      {pending ? "\u00a0" : displayValue}
    </time>
  );
}
