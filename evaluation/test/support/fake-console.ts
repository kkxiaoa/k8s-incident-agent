import type { HarnessContext } from "./harness.ts";
import { textResponse } from "./responses.ts";

// The Console renders the Incident id, display name and target name unless told to echo only.
export function consoleResponse(url: URL, context: HarnessContext): Response | undefined {
  if (url.pathname === "/api/healthz") return new Response(null, { status: 204 });
  if (url.pathname === "/") {
    return textResponse(context.state.online ? "K8s Incident Agent 重新诊断" : "离线评估入口");
  }
  if (url.pathname.startsWith("/incidents/")) {
    const incidentId = url.pathname.split("/").at(-1);
    const scenario = [...context.scenarioById.values()].find((candidate) => candidate.incidentId === incidentId);
    if (scenario === undefined || context.options.consoleEchoOnly === true) return textResponse(String(incidentId));
    return textResponse(`${incidentId} ${scenario.displayName} ${scenario.target.name}`);
  }
  return undefined;
}
