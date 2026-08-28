import {
  createIncident,
  fetchIncidents,
} from "@/lib/agent-runtime/server-client";

export function GET(request: Request): Promise<Response> {
  return fetchIncidents(new URL(request.url).searchParams);
}

export function POST(request: Request): Promise<Response> {
  return createIncident(request);
}
