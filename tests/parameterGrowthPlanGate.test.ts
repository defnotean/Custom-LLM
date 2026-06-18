import { describe, expect, it } from "vitest";
import { applyParameterGrowthPlanGate } from "../src/training/parameter/ParameterGrowthPlanGate";
import type { ParameterGrowthPlan } from "../src/training/parameter/ParameterGrowthPlanner";

describe("ParameterGrowthPlanGate", () => {
  it("passes a ready plan with complete gates and reviewed risk override", () => {
    const result = applyParameterGrowthPlanGate({
      plan: planFixture(),
      thresholds: { requireRiskReview: false },
    });

    expect(result.status).toBe("pass");
    expect(result.summary).toMatchObject({
      planId: "parameter-growth-test",
      readyBatches: 1,
      estimatedNewParameters: 775_358,
    });
    expect(result.warnings).toEqual([
      "Batch growth-batch-expert-ping has risk flags: first_party_user_data_review_required",
    ]);
  });

  it("fails when a ready plan still needs risk review", () => {
    const result = applyParameterGrowthPlanGate({ plan: planFixture() });

    expect(result.status).toBe("fail");
    expect(result.failures).toContainEqual({
      code: "risk_review_required",
      message: "Batch growth-batch-expert-ping has risk flags: first_party_user_data_review_required",
      batchId: "growth-batch-expert-ping",
    });
  });

  it("fails plans that are not ready or exceed parameter budget", () => {
    const result = applyParameterGrowthPlanGate({
      plan: {
        ...planFixture(),
        status: "needs_more_data",
        summary: { ...planFixture().summary, readyBatches: 0, estimatedNewParameters: 100_000_000 },
        batches: [{ ...planFixture().batches[0]!, status: "needs_more_data", blockers: ["needs more records"] }],
      },
      thresholds: { maxEstimatedNewParameters: 1_000_000, requireRiskReview: false },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["plan_not_ready", "not_enough_ready_batches", "parameter_budget_exceeded"]),
    );
  });

  it("fails ready batches missing required gate requirements", () => {
    const batch = planFixture().batches[0]!;
    const result = applyParameterGrowthPlanGate({
      plan: {
        ...planFixture(),
        batches: [{ ...batch, gateRequirements: ["skill"], riskFlags: [] }],
      },
    });

    expect(result.status).toBe("fail");
    expect(result.failures).toContainEqual({
      code: "missing_required_gates",
      message: "Batch growth-batch-expert-ping is missing required gates: contamination, parameter_growth, training_report",
      batchId: "growth-batch-expert-ping",
    });
  });
});

function planFixture(): ParameterGrowthPlan {
  return {
    id: "parameter-growth-test",
    generatedAt: "2026-06-18T20:00:00.000Z",
    status: "ready",
    summary: {
      queuedCandidates: 2,
      trainableCandidates: 2,
      blockedCandidates: 0,
      batches: 1,
      readyBatches: 1,
      estimatedNewParameters: 775_358,
    },
    batches: [
      {
        id: "growth-batch-expert-ping",
        status: "ready",
        purpose: "tool skill expert for ping",
        targetKind: "expert",
        route: "ping",
        moduleName: "irene-expert-ping",
        datasetId: "learned-expert-ping",
        estimatedNewParameters: 775_358,
        activeParameters: 775_358,
        trainableParameters: 775_358,
        sourceLearningItemIds: ["skill-1", "skill-2"],
        sourceKinds: ["skill"],
        datasetHashes: ["a".repeat(64), "b".repeat(64)],
        records: [
          {
            itemId: "skill-1",
            kind: "skill",
            source: "tool_success",
            confidence: 0.9,
            contentHash: "a".repeat(64),
            metadataHash: "c".repeat(64),
            canRetrieve: true,
            canTrain: true,
            contentPreview: "Use ping for health checks.",
          },
          {
            itemId: "skill-2",
            kind: "skill",
            source: "tool_success",
            confidence: 0.9,
            contentHash: "b".repeat(64),
            metadataHash: "d".repeat(64),
            canRetrieve: true,
            canTrain: true,
            contentPreview: "Use ping before diagnostics.",
          },
        ],
        gateRequirements: ["contamination", "parameter_growth", "skill", "training_report"],
        riskFlags: ["first_party_user_data_review_required"],
        blockers: [],
        nextActions: ["train the target expert"],
      },
    ],
    blockedCandidates: [],
    assumptions: [],
  };
}
