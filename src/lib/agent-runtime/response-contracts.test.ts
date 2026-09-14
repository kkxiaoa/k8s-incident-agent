import { describe, expect, it } from "vitest";

import {
  makeIncidentDetail,
  makeWaitingApprovalIncidentDetail,
  makeRepairRunWaitingDetail,
  makeRecoveryDetail,
} from "@/test/agent-runtime-fixtures";

import {
  isMetricWindow,
  parseIncidentDetailResponse,
  parseIncidentMetricPanelResponse,
  parseMonitoringHealthResponse,
  parseMonitoringOverviewResponse,
  parseMonitoringPanelListResponse,
  parseRuntimeHealthResponse,
} from "./response-contracts";

it.each(["observing", "recovered", "monitoring_unavailable"] as const)("keeps %s bound to its trusted execution and original window", (outcome) => {
  const value = makeRecoveryDetail(outcome);
  expect(parseIncidentDetailResponse(value)?.verification).toEqual(value.verification);
  for (const changes of [{ executionId: value.incident.id }, { startedAt: "2026-09-14T01:00:03Z", deadlineAt: "2026-09-14T01:10:03Z" }, { sampleCount: 121 }, { lastObservedAt: "2026-09-14T01:20:00Z" }]) {
    expect(parseIncidentDetailResponse({ ...value, verification: { ...value.verification, ...changes } })).toBeNull();
  }
  expect(parseIncidentDetailResponse({ ...value, approval: null })).toBeNull();
});

it("does not accept recovery without sixty seconds of saved healthy samples", () => {
  const value = makeRecoveryDetail("recovered");
  for (const changes of [{ sampleCount: 12 }, { healthySince: "2026-09-14T01:00:03Z" }, { healthySince: null }, { reason: "alerts_active" }]) {
    expect(parseIncidentDetailResponse({ ...value, verification: { ...value.verification, ...changes } })).toBeNull();
  }
});

it("preserves UNKNOWN and late receipt evidence with exact Run/proposal binding", () => {
  const value = makeRepairRunWaitingDetail();
  const receipt = { uid: value.repair!.targetUid, resourceVersion: "patched-rv", generation: 4, beforeGeneration: 3 };
  const approval = {
    id: value.repair!.id, runId: value.selectedRun.id, proposalId: value.repair!.id,
    proposalDigest: value.repair!.digest, validationDigest: `sha256:${"a".repeat(64)}`,
    decision: "approve", actor: "sandbox-operator", decidedAt: "2026-09-13T01:00:00Z", expiresAt: "2026-09-13T01:15:00Z",
    execution: { id: value.repair!.id, status: "UNKNOWN", startBefore: "2026-09-13T01:00:30Z", claimedAt: "2026-09-13T01:00:01Z", reportedAt: "2026-09-13T01:01:00Z", result: null, lateResult: { outcome: "APPLIED", receipt, error: null } },
  };
  const response = { ...value, approval, runCreationBlocked: true, selectedRun: { ...value.selectedRun, status: "FAILED", error: { code: "execution_outcome_unknown", retryable: false } }, incident: { ...value.incident, status: "FAILED" } };
  const parsed = parseIncidentDetailResponse(response);
  expect(parsed?.approval).toEqual(approval);
  expect(parsed?.runCreationBlocked).toBe(true);
  expect(parseIncidentDetailResponse({ ...response, runCreationBlocked: undefined })).toBeNull();
  expect(parseIncidentDetailResponse({ ...response, approval: { ...approval, runId: value.incident.id } })).toBeNull();
  expect(parseIncidentDetailResponse({ ...response, approval: { ...approval, execution: { ...approval.execution, status: "APPLIED" } } })).toBeNull();
});

it("projects diagnostic availability and rejects contradictory or unknown health claims", () => {
  const health = { status: "ok", diagnosis: { status: "unavailable", reason: "configuration_invalid" } };
  expect(parseRuntimeHealthResponse({ ...health, privateMetadata: "discard" })).toEqual(health);
  expect(parseRuntimeHealthResponse({ status: "ok", diagnosis: { status: "ready", reason: null } })).not.toBeNull();
  for (const diagnosis of [
    { status: "ready", reason: "authentication_failed" },
    { status: "unavailable", reason: null },
    { status: "unavailable", reason: "raw upstream response" },
  ]) expect(parseRuntimeHealthResponse({ status: "ok", diagnosis })).toBeNull();
});

it("accepts every bounded metric window", () => {
  expect(["15m", "1h", "6h", "7d", "15d"].every(isMetricWindow)).toBe(true);
  expect(isMetricWindow("24h")).toBe(false);
});

function metricPanel() {
  return {
    schemaVersion: 1,
    result: {
      panelId: "image-pull-affected-pods",
      title: "Affected pods",
      unit: "pods",
      threshold: 1,
      riskDirection: "higher_is_worse",
      window: "15m",
      state: "ok",
      queriedAt: "2026-09-03T02:15:00.000Z",
      latestSampleAt: "2026-09-03T02:15:00.000Z",
      currentValue: 0,
      samples: [
        { timestamp: "2026-09-03T02:14:45.000Z", value: 1 },
        { timestamp: "2026-09-03T02:15:00.000Z", value: 0 },
      ],
    },
    markers: [
      {
        kind: "alert_firing",
        occurredAt: "2026-09-03T02:05:00.000Z",
        runAttempt: null,
      },
      {
        kind: "run_started",
        occurredAt: "2026-09-03T02:06:00.000Z",
        runAttempt: 1,
      },
    ],
    markersTruncated: false,
  };
}

describe("parseIncidentDetailResponse", () => {
  it("preserves source, controlled int64 selection and waiting lifecycle metadata", () => {
    const detail = makeRepairRunWaitingDetail();
    const metadata = {
      requestSource: "operator", sourceRunId: makeWaitingApprovalIncidentDetail().selectedRun.id,
      selection: { revision: "9223372036854775807", replicaSetUid: "rs-old" },
      waitingExpiresAt: "2026-08-29T01:15:05Z", endReason: null,
    };
    const wire = { ...detail, selectedRun: { ...detail.selectedRun, ...metadata } };
    expect(parseIncidentDetailResponse(wire)?.selectedRun).toMatchObject(metadata);
    for (const revision of [9223372036854775807, "9223372036854775808", "02", "2.0"]) {
      expect(parseIncidentDetailResponse({ ...wire, selectedRun: {
        ...wire.selectedRun, selection: { ...metadata.selection, revision },
      } })).toBeNull();
    }
    for (const replicaSetUid of [" rs-old", "rs-old\n"]) {
      expect(parseIncidentDetailResponse({ ...wire, selectedRun: {
        ...wire.selectedRun, selection: { ...metadata.selection, replicaSetUid },
      } })).toBeNull();
    }
  });
  it("separates a completed diagnostic suggestion from a waiting repair without a diagnosis", () => {
    const legacy = parseIncidentDetailResponse(makeWaitingApprovalIncidentDetail());
    const repair = parseIncidentDetailResponse(makeRepairRunWaitingDetail());
    expect(legacy?.selectedRun).toMatchObject({ kind: "diagnosis", operation: null, status: "COMPLETED" });
    expect(repair?.selectedRun).toMatchObject({ kind: "repair", operation: "apply", status: "WAITING_APPROVAL", completedAt: null });
    expect(repair?.diagnosis).toBeNull();
    expect(repair?.repair).not.toBeNull();
  });

  it.each([
    { kind: undefined, operation: null },
    { kind: "diagnosis", operation: "apply" },
    { kind: "diagnosis", operation: null, status: "WAITING_APPROVAL" },
    { kind: "repair", operation: null },
    { kind: "repair", operation: "restart" },
  ])("rejects inconsistent Run kind fields %j", (fields) => {
    const detail = makeIncidentDetail();
    expect(parseIncidentDetailResponse({ ...detail, selectedRun: { ...detail.selectedRun, ...fields } })).toBeNull();
  });

  it("does not attach a diagnosis to a repair Run", () => {
    const detail = makeRepairRunWaitingDetail();
    detail.diagnosis = makeWaitingApprovalIncidentDetail().diagnosis;
    expect(parseIncidentDetailResponse(detail)).toBeNull();
  });
  it("accepts a Scenario detail without an alert signal", () => {
    expect(parseIncidentDetailResponse(makeIncidentDetail())).not.toBeNull();
  });

  it("accepts a distinct Alertmanager signal projection", () => {
    const detail = makeIncidentDetail();
    detail.incident.source = {
      type: "alertmanager",
      ref: "K8sIncidentImagePullBackOff",
      revision: "2026-09-02.1",
    };
    detail.alertSignal = {
      status: "RESOLVED",
      startsAt: "2026-09-02T08:00:00.000000001Z",
      endsAt: "2026-09-02T08:05:00.000000001Z",
    };

    expect(parseIncidentDetailResponse(detail)?.alertSignal).toEqual(
      detail.alertSignal,
    );
  });

  it("rejects missing, contradictory, or regressive signal projections", () => {
    const missing = makeIncidentDetail();
    missing.incident.source.type = "alertmanager";

    const scenarioWithSignal = makeIncidentDetail();
    scenarioWithSignal.alertSignal = {
      status: "FIRING",
      startsAt: "2026-09-02T08:00:00.000000000Z",
      endsAt: null,
    };

    const regressive = makeIncidentDetail();
    regressive.incident.source.type = "alertmanager";
    regressive.alertSignal = {
      status: "RESOLVED",
      startsAt: "2026-09-02T08:00:00.000000002Z",
      endsAt: "2026-09-02T08:00:00.000000001Z",
    };

    expect(parseIncidentDetailResponse(missing)).toBeNull();
    expect(parseIncidentDetailResponse(scenarioWithSignal)).toBeNull();
    expect(parseIncidentDetailResponse(regressive)).toBeNull();
  });

  it("rejects an Alertmanager signal without the canonical nanosecond form", () => {
    const detail = makeIncidentDetail();
    detail.incident.source.type = "alertmanager";
    detail.alertSignal = {
      status: "FIRING",
      startsAt: "2026-09-02T08:00:00Z",
      endsAt: null,
    };

    expect(parseIncidentDetailResponse(detail)).toBeNull();
  });

  it("rejects the superseded v2 envelope", () => {
    const detail = { ...makeIncidentDetail(), schemaVersion: 2 };

    expect(parseIncidentDetailResponse(detail)).toBeNull();
  });

  it("accepts the exact evidence-bound repair projection", () => {
    const detail = makeWaitingApprovalIncidentDetail();

    expect(parseIncidentDetailResponse(detail)?.repair).toEqual(detail.repair);
  });

  it("rejects an oversized repair even when Patch and Diff repeat the same value", () => {
    const detail = makeWaitingApprovalIncidentDetail();
    const repair = detail.repair!;
    repair.replacementImage = "x".repeat(2049);
    repair.diff.after = repair.replacementImage;
    repair.patch[4].value = repair.replacementImage;
    expect(parseIncidentDetailResponse(detail)).toBeNull();
  });

  it.each([
    "target",
    "evidence",
    "patch",
    "diff",
    "digest",
    "gate-order",
    "run-status",
    "validation",
  ])("rejects an incoherent repair %s", (mutation) => {
    const detail = makeWaitingApprovalIncidentDetail();
    const repair = detail.repair;
    if (repair === null) throw new Error("repair fixture is missing");

    if (mutation === "target") {
      repair.target.name = "another-deployment";
    } else if (mutation === "evidence") {
      repair.evidenceIds[1] = "99999999-9999-4999-8999-999999999999";
    } else if (mutation === "patch") {
      repair.patch[4].path = "/spec/replicas";
    } else if (mutation === "diff") {
      repair.diff.before = repair.replacementImage;
    } else if (mutation === "digest") {
      repair.digest = "sha256:ABC";
    } else if (mutation === "gate-order") {
      repair.policyCheckedAt = "2026-08-29T01:00:03Z";
    } else if (mutation === "run-status") {
      detail.selectedRun.status = "RUNNING";
    } else {
      repair.validation = {
        outcome: "failed",
        checkedAt: "2026-08-29T01:00:07Z",
        error: { code: "stale_resource", retryable: false },
      };
    }

    expect(parseIncidentDetailResponse(detail)).toBeNull();
  });

  it("accepts a typed failed dry-run projection", () => {
    const detail = makeWaitingApprovalIncidentDetail();
    if (detail.repair === null) throw new Error("repair fixture is missing");
    detail.repair.validation = {
      outcome: "failed",
      checkedAt: "2026-08-29T01:00:07Z",
      error: { code: "stale_resource", retryable: false },
    };
    detail.incident.status = "STALE_RESOURCE";
    detail.selectedRun.status = "FAILED";
    detail.selectedRun.error = { code: "stale_resource", retryable: false };

    expect(parseIncidentDetailResponse(detail)?.repair?.validation.outcome).toBe(
      "failed",
    );
  });

  it("accepts a historical repair Run while the Incident has advanced", () => {
    const detail = makeWaitingApprovalIncidentDetail();
    detail.incident.status = "TRIAGING";

    expect(parseIncidentDetailResponse(detail)?.repair).not.toBeNull();
  });
});

describe("monitoring response contracts", () => {
  it("accepts the bounded health projection", () => {
    const health = {
      state: "degraded",
      checkedAt: "2026-09-03T02:15:00.000Z",
      prometheus: "healthy",
      kubeStateMetrics: "healthy",
      ruleEvaluation: "degraded",
      alertmanager: "healthy",
      notification: "stale",
      watchdogLastReceivedAt: "2026-09-03T02:08:00.000Z",
    };

    expect(parseMonitoringHealthResponse(health)).toEqual(health);
    expect(
      parseMonitoringHealthResponse({ ...health, notification: "normal" }),
    ).toBeNull();
  });

  it("accepts a complete 24-hour overview and rejects inconsistent totals", () => {
    const start = Date.parse("2026-09-02T03:00:00.000Z");
    const overview = {
      schemaVersion: 2,
      window: "24h",
      generatedAt: "2026-09-03T02:15:00.000Z",
      counts: {
        totalIncidents: 8,
        firingAlerts: 2,
        triagingIncidents: 1,
        waitingApprovalIncidents: 5,
      },
      families: [
        {
          sourceRef: "K8sIncidentImagePullBackOff",
          displayName: "Image pull failure",
          count: 2,
        },
      ],
      samples: Array.from({ length: 24 }, (_, index) => ({
        timestamp: new Date(start + index * 3_600_000).toISOString(),
        incidentsCreated: index === 23 ? 1 : 0,
        alertConditionsResolved: index === 22 ? 1 : 0,
      })),
    };

    expect(parseMonitoringOverviewResponse(overview)).toEqual({
      window: "24h",
      generatedAt: overview.generatedAt,
      counts: overview.counts,
      families: overview.families,
      samples: overview.samples,
    });
    expect(parseMonitoringOverviewResponse({ ...overview, schemaVersion: 1 })).toBeNull();
    for (const waitingApprovalIncidents of [undefined, -1, 0.5]) {
      expect(parseMonitoringOverviewResponse({
        ...overview,
        counts: { ...overview.counts, waitingApprovalIncidents },
      })).toBeNull();
    }
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        counts: { ...overview.counts, firingAlerts: 3 },
      }),
    ).toBeNull();
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        samples: overview.samples.slice(1),
      }),
    ).toBeNull();
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        counts: { ...overview.counts, firingAlerts: 4 },
        families: [overview.families[0], overview.families[0]],
      }),
    ).toBeNull();
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        samples: overview.samples.map((sample) => ({
          ...sample,
          timestamp: new Date(
            Date.parse(sample.timestamp) - 3_600_000,
          ).toISOString(),
        })),
      }),
    ).toBeNull();
  });

  it("accepts unique catalog panel references and rejects duplicates", () => {
    const panels = {
      schemaVersion: 3,
      panels: [
        {
          panelId: "image-pull-affected-pods",
          recommendedWindow: "15m",
          riskDirection: "higher_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
        {
          panelId: "image-pull-available-replicas",
          recommendedWindow: "1h",
          riskDirection: "lower_is_worse",
          signalRole: "context",
          thresholdDuration: "5m",
        },
      ],
    };

    expect(parseMonitoringPanelListResponse(panels)?.panels).toHaveLength(2);
    expect(
      parseMonitoringPanelListResponse({
        ...panels,
        panels: [panels.panels[0], panels.panels[0]],
      }),
    ).toBeNull();
  });

  it("preserves a valid zero and keeps markers separate from samples", () => {
    const panel = metricPanel();

    const parsed = parseIncidentMetricPanelResponse(
      panel,
      "image-pull-affected-pods",
      "15m",
    );

    expect(parsed?.result.currentValue).toBe(0);
    expect(parsed?.result.samples).toHaveLength(2);
    expect(parsed?.markers).toEqual(panel.markers);
  });

  it("accepts an explicit no-data state without treating it as zero", () => {
    const panel = metricPanel();
    panel.result.state = "no_data";
    panel.result.latestSampleAt = null as unknown as string;
    panel.result.currentValue = null as unknown as number;
    panel.result.samples = [];

    const parsed = parseIncidentMetricPanelResponse(
      panel,
      "image-pull-affected-pods",
      "15m",
    );

    expect(parsed?.result.currentValue).toBeNull();
    expect(parsed?.result.samples).toEqual([]);
  });

  it("accepts a static lower bound for a lower-is-worse metric", () => {
    const panel = metricPanel();
    panel.result.panelId = "service-ready-endpoints";
    panel.result.title = "Service 就绪 Endpoint";
    panel.result.unit = "endpoints";
    panel.result.riskDirection = "lower_is_worse";

    const parsed = parseIncidentMetricPanelResponse(
      panel,
      "service-ready-endpoints",
      "15m",
    );

    expect(parsed?.result.threshold).toBe(1);
    expect(parsed?.result.riskDirection).toBe("lower_is_worse");
  });

  it.each([
    "panel",
    "window",
    "state-shape",
    "sample-order",
    "sample-window",
    "current",
    "risk-threshold",
    "marker-shape",
    "marker-window",
  ])("rejects invalid %s responses", (mutation) => {
    const panel = metricPanel();
    if (mutation === "panel") {
      panel.result.panelId = "image-pull-available-replicas";
    } else if (mutation === "window") {
      panel.result.window = "1h";
    } else if (mutation === "state-shape") {
      panel.result.state = "no_data";
    } else if (mutation === "sample-order") {
      panel.result.samples.reverse();
    } else if (mutation === "sample-window") {
      panel.result.samples[0].timestamp = "2026-09-03T01:59:59.999Z";
    } else if (mutation === "current") {
      panel.result.currentValue = 2;
    } else if (mutation === "risk-threshold") {
      panel.result.threshold = null as unknown as number;
    } else if (mutation === "marker-shape") {
      panel.markers[0].runAttempt = 1;
    } else {
      panel.markers[0].occurredAt = "2026-09-03T01:00:00.000Z";
    }

    expect(
      parseIncidentMetricPanelResponse(
        panel,
        "image-pull-affected-pods",
        "15m",
      ),
    ).toBeNull();
  });
});
