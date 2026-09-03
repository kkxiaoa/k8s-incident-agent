import { fetchMonitoringOverview } from "@/lib/agent-runtime/server-client";

export async function GET(): Promise<Response> {
  return (await fetchMonitoringOverview()).response;
}
