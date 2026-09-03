import type { MetricWindowView } from "@/lib/agent-runtime/response-contracts";

export const METRIC_WINDOW_LABELS: Record<MetricWindowView, string> = {
  "15m": "最近 15 分钟",
  "1h": "最近 1 小时",
  "6h": "最近 6 小时",
};
