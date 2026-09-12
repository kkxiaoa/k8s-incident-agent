import {
  createIncident,
  fetchIncidents,
} from "@/lib/agent-runtime/server-client";
import { getIncidentIntakeMode } from "@/lib/agent-runtime/server-config";

export async function GET(request: Request): Promise<Response> {
  return (await fetchIncidents(new URL(request.url).searchParams, request.headers)).response;
}

export async function POST(request: Request): Promise<Response> {
  if (getIncidentIntakeMode() === "online") {
    return new Response(null, { status: 404 });
  }

  return createIncident(request);
}
