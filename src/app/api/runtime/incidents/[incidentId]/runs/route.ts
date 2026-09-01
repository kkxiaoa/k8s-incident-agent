import {
  createRun,
  fetchRuns,
} from "@/lib/agent-runtime/server-client";
import { getIncidentIntakeMode } from "@/lib/agent-runtime/server-config";

interface IncidentRunRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function GET(
  request: Request,
  context: IncidentRunRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;
  return (
    await fetchRuns(incidentId, new URL(request.url).searchParams)
  ).response;
}

export async function POST(
  _request: Request,
  context: IncidentRunRouteContext,
): Promise<Response> {
  if (getIncidentIntakeMode() === "online") {
    return new Response(null, { status: 404 });
  }

  const { incidentId } = await context.params;
  return createRun(incidentId);
}
