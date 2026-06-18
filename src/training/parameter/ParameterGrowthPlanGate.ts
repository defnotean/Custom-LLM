import type { ParameterGrowthBatch, ParameterGrowthPlan } from "./ParameterGrowthPlanner";

export type ParameterGrowthGateStatus = "pass" | "fail";

export interface ParameterGrowthGateThresholds {
  minReadyBatches: number;
  minRecordsPerReadyBatch: number;
  maxEstimatedNewParameters: number;
  requireRiskReview: boolean;
  requiredGateRequirements: string[];
}

export interface ParameterGrowthGateFailure {
  code: string;
  message: string;
  batchId?: string;
}

export interface ParameterGrowthGateResult {
  status: ParameterGrowthGateStatus;
  thresholds: ParameterGrowthGateThresholds;
  summary: {
    planId: string;
    planStatus: ParameterGrowthPlan["status"];
    queuedCandidates: number;
    trainableCandidates: number;
    blockedCandidates: number;
    batches: number;
    readyBatches: number;
    estimatedNewParameters: number;
  };
  failures: ParameterGrowthGateFailure[];
  warnings: string[];
}

export const DEFAULT_PARAMETER_GROWTH_GATE_THRESHOLDS: ParameterGrowthGateThresholds = {
  minReadyBatches: 1,
  minRecordsPerReadyBatch: 2,
  maxEstimatedNewParameters: 25_000_000,
  requireRiskReview: true,
  requiredGateRequirements: ["contamination", "parameter_growth", "training_report"],
};

export function applyParameterGrowthPlanGate(input: {
  plan: ParameterGrowthPlan;
  thresholds?: Partial<ParameterGrowthGateThresholds>;
}): ParameterGrowthGateResult {
  const thresholds = {
    ...DEFAULT_PARAMETER_GROWTH_GATE_THRESHOLDS,
    ...(input.thresholds ?? {}),
    requiredGateRequirements:
      input.thresholds?.requiredGateRequirements ?? DEFAULT_PARAMETER_GROWTH_GATE_THRESHOLDS.requiredGateRequirements,
  };
  const failures: ParameterGrowthGateFailure[] = [];
  const warnings: string[] = [];
  const readyBatches = input.plan.batches.filter((batch) => batch.status === "ready");

  if (input.plan.status !== "ready") {
    failures.push({ code: "plan_not_ready", message: `Plan status is ${input.plan.status}` });
  }
  if (readyBatches.length < thresholds.minReadyBatches) {
    failures.push({
      code: "not_enough_ready_batches",
      message: `Plan has ${readyBatches.length} ready batches; expected at least ${thresholds.minReadyBatches}`,
    });
  }
  if (input.plan.summary.blockedCandidates > 0) {
    warnings.push(`${input.plan.summary.blockedCandidates} queued candidates are blocked and need review before training`);
  }
  if (input.plan.summary.estimatedNewParameters > thresholds.maxEstimatedNewParameters) {
    failures.push({
      code: "parameter_budget_exceeded",
      message: `Ready batches add ${input.plan.summary.estimatedNewParameters} parameters; max is ${thresholds.maxEstimatedNewParameters}`,
    });
  }

  for (const batch of readyBatches) {
    failures.push(...batchFailures(batch, thresholds));
    if (batch.riskFlags.length > 0) {
      const message = `Batch ${batch.id} has risk flags: ${batch.riskFlags.join(", ")}`;
      if (thresholds.requireRiskReview) failures.push({ code: "risk_review_required", message, batchId: batch.id });
      else warnings.push(message);
    }
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    summary: {
      planId: input.plan.id,
      planStatus: input.plan.status,
      queuedCandidates: input.plan.summary.queuedCandidates,
      trainableCandidates: input.plan.summary.trainableCandidates,
      blockedCandidates: input.plan.summary.blockedCandidates,
      batches: input.plan.summary.batches,
      readyBatches: input.plan.summary.readyBatches,
      estimatedNewParameters: input.plan.summary.estimatedNewParameters,
    },
    failures,
    warnings,
  };
}

function batchFailures(
  batch: ParameterGrowthBatch,
  thresholds: ParameterGrowthGateThresholds,
): ParameterGrowthGateFailure[] {
  const failures: ParameterGrowthGateFailure[] = [];
  if (batch.blockers.length > 0) {
    failures.push({
      code: "ready_batch_has_blockers",
      message: `Ready batch ${batch.id} still has blockers: ${batch.blockers.join("; ")}`,
      batchId: batch.id,
    });
  }
  if (batch.records.length < thresholds.minRecordsPerReadyBatch) {
    failures.push({
      code: "ready_batch_too_small",
      message: `Ready batch ${batch.id} has ${batch.records.length} records; expected at least ${thresholds.minRecordsPerReadyBatch}`,
      batchId: batch.id,
    });
  }
  if (batch.sourceLearningItemIds.length !== batch.records.length || batch.datasetHashes.length !== batch.records.length) {
    failures.push({
      code: "batch_record_mismatch",
      message: `Batch ${batch.id} has inconsistent source id / hash / record counts`,
      batchId: batch.id,
    });
  }
  if (batch.estimatedNewParameters <= 0 || batch.activeParameters <= 0 || batch.trainableParameters < 0) {
    failures.push({
      code: "invalid_parameter_counts",
      message: `Batch ${batch.id} has invalid parameter counts`,
      batchId: batch.id,
    });
  }
  const missingGates = thresholds.requiredGateRequirements.filter((gate) => !batch.gateRequirements.includes(gate));
  if (missingGates.length > 0) {
    failures.push({
      code: "missing_required_gates",
      message: `Batch ${batch.id} is missing required gates: ${missingGates.join(", ")}`,
      batchId: batch.id,
    });
  }
  if (batch.records.some((record) => !record.canTrain)) {
    failures.push({
      code: "non_trainable_record",
      message: `Batch ${batch.id} includes records that cannot be trained`,
      batchId: batch.id,
    });
  }
  return failures;
}
