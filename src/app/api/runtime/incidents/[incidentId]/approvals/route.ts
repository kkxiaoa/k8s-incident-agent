import { decideApproval } from "@/lib/agent-runtime/server-client";

export async function POST(
  request: Request,
  context: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  const { incidentId } = await context.params;
  return decideApproval(incidentId, request);
}
