import { streamIncidentEvents } from "@/lib/agent-runtime/server-client";

interface IncidentEventRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function GET(
  request: Request,
  context: IncidentEventRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;
  return streamIncidentEvents(
    incidentId,
    request.headers.get("last-event-id"),
    request.signal,
  );
}
