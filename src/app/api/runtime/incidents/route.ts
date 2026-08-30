import {
  createIncident,
  fetchIncidents,
} from "@/lib/agent-runtime/server-client";

export async function GET(request: Request): Promise<Response> {
  return (await fetchIncidents(new URL(request.url).searchParams)).response;
}

export function POST(request: Request): Promise<Response> {
  return createIncident(request);
}
