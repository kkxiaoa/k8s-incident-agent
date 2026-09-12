import { fetchIncident } from "@/lib/agent-runtime/server-client";

interface IncidentRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function GET(
  request: Request,
  context: IncidentRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;
  const runIds = new URL(request.url).searchParams.getAll("runId");
  return (await fetchIncident(incidentId, runIds.length === 1 ? runIds[0] : runIds.length === 0 ? undefined : "invalid", request.headers)).response;
}
