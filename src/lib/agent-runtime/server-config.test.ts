import { describe, expect, it, vi } from "vitest";

import {
  getAgentRuntimeBaseUrl,
  getIncidentIntakeMode,
} from "./server-config";

describe("getIncidentIntakeMode", () => {
  it("defaults to the local manual profile", () => {
    delete process.env.INCIDENT_INTAKE_MODE;

    expect(getIncidentIntakeMode()).toBe("manual");
  });

  it.each(["manual", "online"] as const)("accepts %s", (value) => {
    vi.stubEnv("INCIDENT_INTAKE_MODE", value);

    expect(getIncidentIntakeMode()).toBe(value);
  });

  it.each(["", "development", " manual "])(
    "rejects the unknown value %j without exposing it",
    (value) => {
      vi.stubEnv("INCIDENT_INTAKE_MODE", value);

      expect(() => getIncidentIntakeMode()).toThrow(
        "Agent Runtime configuration is invalid.",
      );
    },
  );
});

describe("getAgentRuntimeBaseUrl", () => {
  it("returns a loopback HTTP URL with its path prefix", () => {
    vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000/runtime/");

    expect(getAgentRuntimeBaseUrl().href).toBe(
      "http://127.0.0.1:8000/runtime/",
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "not-a-url"],
    ["unsupported protocol", "file:///tmp/runtime.sock"],
    ["remote host", "https://runtime.example.test"],
    [
      "other cluster service",
      "http://agent-runtime.other.svc.cluster.local:8000",
    ],
    [
      "cluster service over HTTPS",
      "https://agent-runtime.k8s-incident-agent.svc.cluster.local:8000",
    ],
    [
      "cluster service on another port",
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8001",
    ],
    [
      "cluster service with a path prefix",
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000/runtime/",
    ],
    ["userinfo", "http://operator:secret@127.0.0.1:8000"],
    ["query", "http://127.0.0.1:8000?token=secret"],
    ["fragment", "http://127.0.0.1:8000#secret"],
    [
      "empty cluster-service query",
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000?",
    ],
    [
      "empty cluster-service fragment",
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000#",
    ],
  ])("rejects %s without exposing the configured value", (_case, value) => {
    if (value === undefined) {
      delete process.env.AGENT_RUNTIME_URL;
    } else {
      vi.stubEnv("AGENT_RUNTIME_URL", value);
    }

    let thrown: unknown;
    try {
      getAgentRuntimeBaseUrl();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toBe(
      "Error: Agent Runtime configuration is invalid.",
    );
  });

  it("rejects a public Runtime variable even when the server variable is valid", () => {
    vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
    vi.stubEnv("NEXT_PUBLIC_AGENT_RUNTIME_URL", "");

    expect(() => getAgentRuntimeBaseUrl()).toThrow(
      "Agent Runtime configuration is invalid.",
    );
  });

  it.each([
    "http://localhost:8000",
    "https://127.255.255.255:8443",
    "http://[::1]:8000",
  ])("accepts the supported loopback forms: %s", (value) => {
    vi.stubEnv("AGENT_RUNTIME_URL", value);

    expect(getAgentRuntimeBaseUrl()).toBeInstanceOf(URL);
  });

  it("accepts only the fixed cluster Runtime service", () => {
    vi.stubEnv(
      "AGENT_RUNTIME_URL",
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000",
    );

    expect(getAgentRuntimeBaseUrl().href).toBe(
      "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000/",
    );
  });
});
