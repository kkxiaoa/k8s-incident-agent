import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const verifierFile = process.env.OPERATOR_VERIFIER_FILE;
if (!verifierFile || !isAbsolute(verifierFile)) {
  console.error("Set OPERATOR_VERIFIER_FILE to the absolute operator init output path.");
  process.exit(1);
}
const vite = await createServer({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  configFile: false,
  envFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, watch: null, hmr: false },
  appType: "custom",
});
try {
  const { startFakeRuntime, seedManualRepairShowcase } = await vite.ssrLoadModule("/tests/e2e/fake-runtime.ts");
  const runtime = await startFakeRuntime(18080, {
    verifierFile,
    pythonExecutable: fileURLToPath(new URL("../../services/agent-runtime/.venv/bin/python", import.meta.url)),
    origin: "http://127.0.0.1:3000",
  });
  const count = seedManualRepairShowcase();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
    await vite.close();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  console.log("Fake Runtime ready: http://127.0.0.1:18080 (test data only; no cluster access)");
  console.log(`Manual repair showcase: ${count} Task 7–10 cases available in the Incident list.`);
} catch {
  await vite.close();
  console.error("Fake Runtime startup failed. Check the verifier file, Runtime virtualenv and port 18080.");
  process.exitCode = 1;
}
