import { fetchRunEvents } from "@/lib/agent-runtime/server-client";

interface RunEventRouteContext {
  params: Promise<{ incidentId: string; runId: string }>;
}

export async function GET(
  request: Request,
  context: RunEventRouteContext,
): Promise<Response> {
  const { incidentId, runId } = await context.params;
  return (
    await fetchRunEvents(
      incidentId,
      runId,
      new URL(request.url).searchParams,
    )
  ).response;
}
