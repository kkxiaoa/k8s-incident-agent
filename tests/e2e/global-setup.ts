import { startFakeRuntime } from "./fake-runtime";

export default async function globalSetup() {
  const runtimePort = Number(process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080");
  const runtime = await startFakeRuntime(runtimePort);
  return () => runtime.close();
}
