import { createHash } from "node:crypto";

import type { EvaluationScenario, ScenarioTarget } from "../../contracts/dataset.ts";
import type { RepairCheck } from "../../contracts/records.ts";
import type { IncidentDetail } from "../../contracts/runtime-api.ts";
import { contractError } from "../../shared/errors.ts";
import { canonicalJson, hasExactKeys, isNormalizedString, isPlainObject, isUuid, parseInstant } from "../../shared/guards.ts";

const REPAIR_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPAIR_KEYS = [
  "schemaVersion",
  "id",
  "action",
  "target",
  "targetUid",
  "targetResourceVersion",
  "containerIndex",
  "containerName",
  "currentImage",
  "replacementImage",
  "evidenceIds",
  "sourceExecutionId",
  "patch",
  "digest",
  "diff",
  "schemaCheckedAt",
  "policyCheckedAt",
  "diffCheckedAt",
  "validation",
] as const;

type Repair = NonNullable<IncidentDetail["repair"]>;

interface EvidenceKinds {
  get(id: string): { evidenceKind: string } | undefined;
  has(id: string): boolean;
}

export function sameTarget(actual: unknown, expected: ScenarioTarget): boolean {
  return (
    isPlainObject(actual) &&
    actual.cluster === expected.cluster &&
    actual.namespace === expected.namespace &&
    actual.apiVersion === expected.apiVersion &&
    actual.kind === expected.kind &&
    actual.name === expected.name
  );
}

export function validateTerminalRepair(
  scenario: EvaluationScenario,
  detail: IncidentDetail,
  evidenceById: EvidenceKinds,
): RepairCheck | undefined {
  const expected = scenario.expectedPatchConstraints;
  const incident: unknown = detail.incident;
  const incidentStatus = isPlainObject(incident) ? incident.status : undefined;
  if (expected === undefined) {
    if (incidentStatus !== "DIAGNOSED" || detail.repair !== null) {
      throw contractError(
        "repair_validation_invalid",
        "A diagnosis without an approved repair slice exposed repair state",
      );
    }
    return undefined;
  }

  const repair: unknown = detail.repair;
  const candidate = isPlainObject(repair) ? repair : undefined;
  const imagePath = `/spec/template/spec/containers/${expected.containerIndex}/image`;
  const expectedPatch = [
    { op: "test", path: "/metadata/uid", value: candidate?.targetUid },
    { op: "test", path: "/metadata/resourceVersion", value: candidate?.targetResourceVersion },
    { op: "test", path: `/spec/template/spec/containers/${expected.containerIndex}/name`, value: expected.containerName },
    { op: "test", path: imagePath, value: expected.currentImage },
    { op: "replace", path: imagePath, value: expected.replacementImage },
  ];
  const evidenceIds: unknown = candidate?.evidenceIds;
  const validation = isPlainObject(candidate?.validation) ? candidate.validation : undefined;
  const gateTimes = [
    parseInstant(candidate?.schemaCheckedAt),
    parseInstant(candidate?.policyCheckedAt),
    parseInstant(candidate?.diffCheckedAt),
    parseInstant(validation?.checkedAt),
  ];
  const diff = isPlainObject(candidate?.diff) ? candidate.diff : undefined;
  if (
    incidentStatus !== "WAITING_APPROVAL" ||
    candidate === undefined ||
    !hasExactKeys(candidate, REPAIR_KEYS) ||
    candidate.schemaVersion !== 1 ||
    !isUuid(candidate.id) ||
    candidate.action !== expected.action ||
    !hasExactKeys(candidate.target, ["cluster", "namespace", "apiVersion", "kind", "name"]) ||
    !sameTarget(candidate.target, scenario.target) ||
    !isNormalizedString(candidate.targetUid) ||
    !isNormalizedString(candidate.targetResourceVersion) ||
    candidate.containerIndex !== expected.containerIndex ||
    candidate.containerName !== expected.containerName ||
    candidate.currentImage !== expected.currentImage ||
    candidate.replacementImage !== expected.replacementImage ||
    // A proposal carries a source execution only when it rolls one back, and the
    // repair contract pairs that with a single Evidence instead of two.
    candidate.sourceExecutionId !== null ||
    !Array.isArray(evidenceIds) ||
    evidenceIds.length !== 2 ||
    new Set(evidenceIds).size !== 2 ||
    JSON.stringify(evidenceIds) !==
      JSON.stringify([...evidenceIds].sort((left, right) => String(left).localeCompare(String(right)))) ||
    evidenceIds.some((id) => !isUuid(id) || !evidenceById.has(id)) ||
    diff === undefined ||
    !hasExactKeys(diff, ["path", "before", "after"]) ||
    diff.path !== imagePath ||
    diff.before !== expected.currentImage ||
    diff.after !== expected.replacementImage ||
    !Array.isArray(candidate.patch) ||
    candidate.patch.length !== 5 ||
    candidate.patch.some((operation) => !hasExactKeys(operation, ["op", "path", "value"])) ||
    JSON.stringify(candidate.patch) !== JSON.stringify(expectedPatch) ||
    typeof candidate.digest !== "string" ||
    !REPAIR_DIGEST_PATTERN.test(candidate.digest) ||
    gateTimes.some((value) => value === undefined) ||
    gateTimes.some((value, index) => index > 0 && (value as number) < (gateTimes[index - 1] as number)) ||
    validation === undefined ||
    !hasExactKeys(validation, ["outcome", "checkedAt", "error"]) ||
    validation.outcome !== "passed" ||
    validation.error !== null
  ) {
    throw contractError(
      "repair_validation_invalid",
      "The ImagePull repair did not satisfy the evidence-bound contract",
    );
  }
  const proposal = candidate as unknown as Repair;
  const repairKinds = new Set(proposal.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)?.evidenceKind));
  // The proposal is bound to the Evidence a root cause cites, not to how the
  // model named that root cause; the Runtime decides the action from the facts.
  const rootCauses: unknown = detail.diagnosis?.rootCauses;
  const repairRootCause = Array.isArray(rootCauses)
    ? rootCauses.find((rootCause) => {
        const cited: unknown = isPlainObject(rootCause) ? rootCause.evidenceIds : undefined;
        return Array.isArray(cited) && proposal.evidenceIds.every((evidenceId) => cited.includes(evidenceId));
      })
    : undefined;
  if (
    repairKinds.size !== 2 ||
    !repairKinds.has("workload") ||
    !repairKinds.has("rollout_history") ||
    repairRootCause === undefined ||
    proposal.digest !== expectedRepairDigest(detail.selectedRun.id, proposal)
  ) {
    throw contractError(
      "repair_validation_invalid",
      "The ImagePull repair identity is not bound to its exact Run Evidence",
    );
  }
  return {
    action: proposal.action,
    proposalDigest: proposal.digest,
    validation: "passed",
    terminalStatus: "WAITING_APPROVAL",
  };
}

function expectedRepairDigest(runId: string, repair: Repair): string {
  const change = {
    schema_version: 1,
    run_id: runId,
    action: repair.action,
    target: {
      cluster: repair.target.cluster,
      namespace: repair.target.namespace,
      api_version: repair.target.apiVersion,
      kind: repair.target.kind,
      name: repair.target.name,
    },
    target_uid: repair.targetUid,
    target_resource_version: repair.targetResourceVersion,
    container_index: repair.containerIndex,
    container_name: repair.containerName,
    current_image: repair.currentImage,
    replacement_image: repair.replacementImage,
    evidence_ids: repair.evidenceIds,
  };
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ domain: "k8s-incident-agent.repair-proposal.v1", change, patch: repair.patch }))
    .digest("hex")}`;
}
