import { fetchScenarios } from "@/lib/agent-runtime/server-client";
import { getIncidentIntakeMode } from "@/lib/agent-runtime/server-config";

export async function GET(request: Request): Promise<Response> {
  if (getIncidentIntakeMode() === "online") {
    return new Response(null, { status: 404 });
  }

  return (await fetchScenarios(request.headers)).response;
}
