import { fetchScenarios } from "@/lib/agent-runtime/server-client";

export function GET(): Promise<Response> {
  return fetchScenarios();
}
