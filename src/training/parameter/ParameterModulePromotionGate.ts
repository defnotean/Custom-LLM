import type { JsonObject } from "../../types/common";
import type { ParameterEvalReport, ParameterModule, ParameterModuleKind } from "../../learning/LiveLearningRegistry";

export type ParameterModulePromotionGateStatus = "pass" | "fail";

export interface ParameterModulePromotionGateFailure {
  code: string;
  message: string;
}

export interface ParameterModulePromotionGateResult {
  status: ParameterModulePromotionGateStatus;
  summary: {
    moduleId: string;
    moduleName: string;
    kind: ParameterModuleKind;
    externalGateStatus: "pass" | "fail" | "warn";
    requiredEvalKinds: ParameterEvalReport["kind"][];
    evalReports: number;
    sourceLearningItems: number;
    datasetHashes: number;
    hasRollbackTarget: boolean;
    hasStagingEvidence: boolean;
  };
  failures: ParameterModulePromotionGateFailure[];
}

export interface ParameterModulePromotionGateInput {
  module: ParameterModule;
  gateStatus: "pass" | "fail" | "warn";
  evalReport?: ParameterEvalReport;
}

export function applyParameterModulePromotionGate(
  input: ParameterModulePromotionGateInput,
): ParameterModulePromotionGateResult {
  const evalReports = input.evalReport ? [...input.module.evalReports, input.evalReport] : input.module.evalReports;
  const requiredEvalKinds = requiredRuntimeEvalKinds(input.module.kind);
  const failures: ParameterModulePromotionGateFailure[] = [];
  const hasStagingEvidence = stagingEvidencePassed(input.module.metadata);

  if (input.gateStatus !== "pass") {
    failures.push({ code: "external_gate_not_passed", message: `External gate status is ${input.gateStatus}` });
  }
  if (input.module.status !== "staged") {
    failures.push({ code: "module_not_staged", message: `Module status is ${input.module.status}` });
  }
  if (!input.module.rollbackTargetId) {
    failures.push({ code: "missing_rollback_target", message: "Rollback target is required before promotion" });
  }
  if (input.module.sourceLearningItemIds.length === 0) {
    failures.push({ code: "missing_source_learning_items", message: "Source learned-item ids are required before promotion" });
  }
  if (input.module.datasetHashes.length === 0) {
    failures.push({ code: "missing_dataset_hashes", message: "Dataset hashes are required before promotion" });
  }
  if (!hasStagingEvidence) {
    failures.push({
      code: "missing_staging_evidence",
      message: "Passing stage-from-manifest evidence is required before promotion",
    });
  }

  const failedReports = evalReports.filter((report) => report.status === "fail");
  if (failedReports.length > 0) {
    failures.push({
      code: "failed_eval_report",
      message: `Eval reports include failures: ${failedReports.map((report) => report.kind).join(", ")}`,
    });
  }

  const missingEvalKinds = requiredEvalKinds.filter(
    (kind) => !evalReports.some((report) => report.kind === kind && report.status === "pass"),
  );
  if (missingEvalKinds.length > 0) {
    failures.push({
      code: "missing_required_eval",
      message: `Required eval reports must pass before promotion: ${missingEvalKinds.join(", ")}`,
    });
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    summary: {
      moduleId: input.module.id,
      moduleName: input.module.name,
      kind: input.module.kind,
      externalGateStatus: input.gateStatus,
      requiredEvalKinds,
      evalReports: evalReports.length,
      sourceLearningItems: input.module.sourceLearningItemIds.length,
      datasetHashes: input.module.datasetHashes.length,
      hasRollbackTarget: Boolean(input.module.rollbackTargetId),
      hasStagingEvidence,
    },
    failures,
  };
}

export function requiredRuntimeEvalKinds(kind: ParameterModuleKind): ParameterEvalReport["kind"][] {
  switch (kind) {
    case "router":
      return ["router", "composite"];
    case "specialist":
    case "expert":
      return ["skill", "protocol", "composite"];
    case "adapter":
    case "merged_checkpoint":
      return ["protocol", "knowledge", "behavior", "composite"];
    case "ensemble_member":
      return ["protocol", "knowledge", "composite"];
    case "base_model":
      return ["protocol", "knowledge", "behavior", "composite"];
  }
}

function stagingEvidencePassed(metadata: JsonObject): boolean {
  const staging = metadata.staging;
  if (!isRecord(staging)) return false;
  const gateReport = staging.gateReport;
  return isRecord(gateReport) && gateReport.status === "pass";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
