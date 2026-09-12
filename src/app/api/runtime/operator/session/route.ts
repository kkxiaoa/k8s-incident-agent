import { fetchOperatorSession, renewOperatorSession } from "@/lib/agent-runtime/server-client";

export async function GET(request: Request): Promise<Response> {
  return (await fetchOperatorSession(request.headers)).response;
}

export async function POST(request: Request): Promise<Response> {
  return renewOperatorSession(request);
}
