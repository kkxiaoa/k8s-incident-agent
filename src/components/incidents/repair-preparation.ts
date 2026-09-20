/** What a Run reports when its repair preparation actually ran and failed. */
export const PREPARATION_FAILURE_LABELS: Readonly<Record<string, string>> = {
  repair_schema_invalid: "Schema 校验未通过",
  repair_policy_denied: "Policy 校验未通过",
  repair_diff_invalid: "Diff 校验未通过",
  repair_no_candidate: "没有匹配的历史镜像候选",
  repair_timeout: "修复准备超时",
  stale_resource: "目标状态已变化",
  patch_validator_authentication_failed: "验证通信认证失败",
  patch_validator_replay_rejected: "验证请求重放被拒绝",
  patch_validator_permission_denied: "验证权限不足",
  patch_validator_admission_denied: "准入检查拒绝",
  patch_validator_timeout: "验证超时",
  patch_validator_upstream_failed: "验证服务暂不可用",
  patch_validator_contract_invalid: "验证响应不符合契约",
};

/**
 * Report whether a repair preparation gate ran and failed on this Run.
 *
 * A Run that failed for an unrelated reason — a tool error, a timeout, an
 * invalid structured output — never reached a gate, so it did not enter the
 * repair path and must not be read as a failed preparation. A Run that passed
 * every gate is not a failure either; it carries its proposal instead.
 */
export function isPreparationFailure(code: string | undefined | null): boolean {
  return (
    code !== undefined && code !== null && Object.hasOwn(PREPARATION_FAILURE_LABELS, code)
  );
}
