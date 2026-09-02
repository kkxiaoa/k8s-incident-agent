import { fetchMonitoringPanel } from "@/lib/agent-runtime/server-client";

interface MonitoringPanelRouteContext {
  params: Promise<{ incidentId: string; panelId: string }>;
}

export async function GET(
  request: Request,
  context: MonitoringPanelRouteContext,
): Promise<Response> {
  const { incidentId, panelId } = await context.params;
  return (
    await fetchMonitoringPanel(
      incidentId,
      panelId,
      new URL(request.url).searchParams,
    )
  ).response;
}
