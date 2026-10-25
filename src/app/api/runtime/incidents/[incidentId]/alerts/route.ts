import { fetchIncidentAlerts } from "@/lib/agent-runtime/server-client";

export async function GET(
  request: Request, context: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  const { incidentId } = await context.params;
  return (await fetchIncidentAlerts(incidentId, new URL(request.url).searchParams, request.headers)).response;
}
