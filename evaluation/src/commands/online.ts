import { requireOnlineHomePage } from "../contracts/console.ts";
import { ONLINE_ARTIFACT_SCHEMA_VERSION, type OnlineArtifact, type OnlineChecks } from "../contracts/records.ts";
import {
  errorCode,
  isDiagnosisUnavailable,
  isRerunAccepted,
  readIncident,
  readIncidentForRun,
  readIncidentSummaries,
} from "../contracts/runtime-api.ts";
import { loadReleaseManifest } from "../environment/commands.ts";
import { bindJsonReader, request as httpRequest, requestJson, requestStatus, requestText, type FetchLike } from "../environment/http.ts";
import { operatorFetch } from "../environment/operator-session.ts";
import { endpointOrigin } from "../environment/tunnels.ts";
import { contractError, invalidArguments, safeFailure, upstreamContractError } from "../shared/errors.ts";
import { isNormalizedString, requireDate } from "../shared/guards.ts";
import { parseJson } from "../shared/json.ts";
import { openGatedTunnels, requireProfile, resolveContext, resolveSession, type RunRequest, type SessionDependencies } from "./run.ts";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["QUEUED", "RUNNING", "WAITING_APPROVAL"]);
const RERUN_STATUSES: ReadonlySet<string> = new Set(["QUEUED", "RUNNING", "COMPLETED", "FAILED"]);

interface OnlineOptions {
  profile: "k3s-public";
  release: OnlineArtifact["release"];
  startedAt: string;
  completedAt: () => string;
  fetchImpl: FetchLike;
  anonymousFetch: FetchLike;
}

// The public deployment must expose only reads: no manual intake route, no Console launcher,
// no anonymous rerun, and an authenticated rerun answered only from the Runtime's own state.
async function evaluateOnlineBoundary(options: OnlineOptions): Promise<OnlineArtifact> {
  const runtime = endpointOrigin("runtime");
  const read = bindJsonReader(options.fetchImpl, runtime);
  const incidents = await readIncidentSummaries(read);
  const [scenariosStatus, createIncidentStatus] = await Promise.all([
    requestStatus(options.fetchImpl, runtime, "/api/v1/scenarios"),
    requestStatus(options.fetchImpl, runtime, "/api/v1/incidents", { method: "POST" }),
  ]);
  if (scenariosStatus !== 404 || createIncidentStatus !== 405) {
    throw contractError("online_route_set_invalid", "Online profile exposes a manual intake route");
  }
  const incidentId = incidents.keys().next().value;
  if (incidentId === undefined) {
    throw contractError("online_existing_incident_required", "Rerun boundary requires an existing Incident");
  }
  const before = await readIncident(read, incidentId);
  if (!Number.isSafeInteger(before.selectedRun.attempt) || before.selectedRun.attempt < 1) throw upstreamContractError();
  const path = `/api/v1/incidents/${incidentId}/runs`;
  const mutation = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  const anonymous = await httpRequest(options.anonymousFetch, runtime, path, mutation);
  if (anonymous.status !== 401 || errorCode(parseJson(anonymous.body)) !== "operator_authentication_required") {
    throw contractError("online_rerun_boundary_invalid", "Anonymous rerun was not rejected by authentication");
  }
  const response = await httpRequest(options.fetchImpl, runtime, path, mutation);
  const document = parseJson(response.body);
  let authenticatedRerun: OnlineChecks["authenticatedRerun"];
  if (response.status === 202 && isRerunAccepted(document)) {
    const created = await readIncidentForRun(read, incidentId, document.runId);
    if (
      created.selectedRun.kind !== "diagnosis" ||
      created.selectedRun.requestSource !== "operator" ||
      !Number.isSafeInteger(created.selectedRun.attempt) ||
      created.selectedRun.attempt <= before.selectedRun.attempt ||
      !RERUN_STATUSES.has(created.selectedRun.status)
    ) {
      throw upstreamContractError();
    }
    authenticatedRerun = "accepted";
  } else if (
    response.status === 409 &&
    errorCode(document) === "active_run_exists" &&
    ACTIVE_RUN_STATUSES.has(before.selectedRun.status)
  ) {
    authenticatedRerun = "active_run_exists";
  } else if (response.status === 503 && errorCode(document) === "diagnosis_unavailable") {
    const health = await requestJson(options.fetchImpl, runtime, "/healthz");
    if (!isDiagnosisUnavailable(health)) throw upstreamContractError();
    authenticatedRerun = "diagnosis_unavailable";
  } else {
    throw contractError("online_rerun_boundary_invalid", "Authenticated rerun did not match the Runtime state");
  }
  requireOnlineHomePage(await requestText(options.fetchImpl, endpointOrigin("console"), "/"));
  return {
    schemaVersion: ONLINE_ARTIFACT_SCHEMA_VERSION,
    kind: "online-boundary-evaluation",
    profile: options.profile,
    release: options.release,
    startedAt: options.startedAt,
    completedAt: options.completedAt(),
    status: "passed",
    checks: {
      readRoutesAvailable: true,
      manualCreationAbsent: true,
      manualConsoleCreationAbsent: true,
      anonymousRerunDenied: true,
      authenticatedRerun,
    },
  };
}

export async function runOnlineEvaluation(
  request: RunRequest,
  dependencies: SessionDependencies = {},
): Promise<{ artifact: OnlineArtifact; artifactPath: string }> {
  const session = resolveSession(dependencies);
  const profile = requireProfile(request.profile);
  const context = resolveContext(profile, request.context);
  if (profile !== "k3s-public") throw invalidArguments();
  if (request.scenarioIds !== undefined || request.datasetPath !== undefined || request.split !== undefined || request.retryOf !== undefined) {
    throw invalidArguments();
  }
  if (!isNormalizedString(request.releasePath)) throw invalidArguments();
  const release = await loadReleaseManifest(request.releasePath, session.repositoryRoot);
  const startedAt = requireDate(session.now()).toISOString();
  const tunnels = await openGatedTunnels(profile, context, release, session);
  const completedAt = () => requireDate(session.now()).toISOString();
  let artifact: OnlineArtifact;
  try {
    try {
      const authenticatedFetch = await operatorFetch(session.fetchImpl, profile, session.environment);
      artifact = await evaluateOnlineBoundary({
        profile,
        release,
        startedAt,
        completedAt,
        fetchImpl: authenticatedFetch,
        anonymousFetch: session.fetchImpl,
      });
    } catch (error) {
      artifact = {
        schemaVersion: ONLINE_ARTIFACT_SCHEMA_VERSION,
        kind: "online-boundary-evaluation",
        profile,
        release,
        startedAt,
        completedAt: completedAt(),
        status: "failed",
        failure: safeFailure(error),
      };
    }
  } finally {
    await tunnels.close();
  }
  const artifactPath = await session.writeArtifact(session.repositoryRoot, profile, artifact);
  return { artifact, artifactPath };
}
