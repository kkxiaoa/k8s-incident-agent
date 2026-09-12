import { fetchMonitoringOverview } from "@/lib/agent-runtime/server-client";

export async function GET(request: Request): Promise<Response> {
  return (await fetchMonitoringOverview(request.headers)).response;
}
