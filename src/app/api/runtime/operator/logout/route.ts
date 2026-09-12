import { logoutOperator } from "@/lib/agent-runtime/server-client";

export async function POST(request: Request): Promise<Response> {
  return logoutOperator(request);
}
