import { randomBytes } from "node:crypto";
import { startFakeRuntime } from "./fake-runtime";

export default async function globalSetup() {
  const runtimePort = Number(process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080");
  const password = randomBytes(32).toString("base64url");
  process.env.PLAYWRIGHT_OPERATOR_PASSWORD = password;
  const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? "3100"}`;
  const runtime = await startFakeRuntime(runtimePort, { password, origin });
  return () => runtime.close();
}
