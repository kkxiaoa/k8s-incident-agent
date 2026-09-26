import "server-only";

const INVALID_CONFIGURATION_MESSAGE =
  "Agent Runtime configuration is invalid.";
const CLUSTER_RUNTIME_ORIGIN =
  "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000";

export type IncidentIntakeMode = "manual" | "online";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") {
    return true;
  }

  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isFixedClusterRuntime(url: URL): boolean {
  return url.origin === CLUSTER_RUNTIME_ORIGIN && url.pathname === "/";
}

export function getIncidentIntakeMode(): IncidentIntakeMode {
  const configuredValue = process.env.INCIDENT_INTAKE_MODE;
  if (configuredValue === undefined) {
    return "manual";
  }
  if (configuredValue === "manual" || configuredValue === "online") {
    return configuredValue;
  }

  throw new Error(INVALID_CONFIGURATION_MESSAGE);
}

export function getAgentRuntimeBaseUrl(): URL {
  const environment = process.env;
  if (environment.NEXT_PUBLIC_AGENT_RUNTIME_URL !== undefined) {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }

  const configuredValue = environment.AGENT_RUNTIME_URL;
  if (configuredValue === undefined || configuredValue.trim() === "") {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }
  if (configuredValue.includes("?") || configuredValue.includes("#")) {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }

  let url: URL;
  try {
    url = new URL(configuredValue);
  } catch {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }

  if (
    !(
      ((url.protocol === "http:" || url.protocol === "https:") &&
        isLoopbackHostname(url.hostname)) ||
      isFixedClusterRuntime(url)
    ) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }

  return url;
}

export function getYamlAssistantUrl(): string | null {
  const configuredValue = process.env.YAML_ASSISTANT_URL;
  if (configuredValue === undefined || configuredValue.trim() === "") {
    return null;
  }
  if (
    configuredValue !== configuredValue.trim() ||
    configuredValue.includes("?") ||
    configuredValue.includes("#")
  ) {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }
  if (configuredValue.startsWith("/")) {
    const base = new URL("https://configuration.invalid");
    const relative = new URL(configuredValue, base);
    if (
      relative.origin !== base.origin ||
      relative.pathname !== configuredValue
    ) {
      throw new Error(INVALID_CONFIGURATION_MESSAGE);
    }
    return configuredValue;
  }
  let url: URL;
  try {
    url = new URL(configuredValue);
  } catch {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }
  return url.href;
}

// MIIT non-commercial filing numbers, e.g. "京ICP备12345678号-1"; plain text only.
const ICP_RECORD = /^\p{Script=Han}ICP备\d{6,12}号(?:-\d{1,3})?$/u;

export function getIcpRecord(): string | null {
  const configuredValue = process.env.PUBLIC_ICP_RECORD;
  if (configuredValue === undefined || configuredValue.trim() === "") {
    return null;
  }
  if (!ICP_RECORD.test(configuredValue)) {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }
  return configuredValue;
}
