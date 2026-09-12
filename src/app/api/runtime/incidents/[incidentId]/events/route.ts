import { streamIncidentEvents } from "@/lib/agent-runtime/server-client";

interface IncidentEventRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function GET(
  request: Request,
  context: IncidentEventRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;
  const headerCursor = request.headers.get("last-event-id");
  const queryCursors = new URL(request.url).searchParams.getAll("cursor");
  return streamIncidentEvents(
    incidentId,
    headerCursor ?? (queryCursors.length === 1 ? queryCursors[0] : queryCursors.length === 0 ? null : "invalid"),
    request.signal,
    request.headers,
  );
}
