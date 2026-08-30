import { fetchIncident } from "@/lib/agent-runtime/server-client";

interface IncidentRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function GET(
  _request: Request,
  context: IncidentRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;
  return (await fetchIncident(incidentId)).response;
}
