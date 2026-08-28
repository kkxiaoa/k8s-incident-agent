import "server-only";

const INVALID_CONFIGURATION_MESSAGE =
  "Agent Runtime configuration is invalid.";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") {
    return true;
  }

  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
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

  let url: URL;
  try {
    url = new URL(configuredValue);
  } catch {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopbackHostname(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(INVALID_CONFIGURATION_MESSAGE);
  }

  return url;
}
