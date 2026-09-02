import { fetchMonitoringHealth } from "@/lib/agent-runtime/server-client";

export async function GET(): Promise<Response> {
  return (await fetchMonitoringHealth()).response;
}
