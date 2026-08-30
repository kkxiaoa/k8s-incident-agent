import { startFakeRuntime } from "./fake-runtime";

export default async function globalSetup() {
  const runtime = await startFakeRuntime(18080);
  return () => runtime.close();
}
