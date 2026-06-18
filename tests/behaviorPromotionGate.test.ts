import { describe, expect, it } from "vitest";
import { applyBehaviorPromotionGate } from "../src/training/eval/BehaviorPromotionGate";
import type { BehaviorEvalReport } from "../src/training/eval/BehaviorEvalSuite";

describe("BehaviorPromotionGate", () => {
  it("passes a complete high-quality behavior report", () => {
    const result = applyBehaviorPromotionGate({ candidate: reportFixture() });
    expect(result.status).toBe("pass");
    expect(result.failures).toEqual([]);
  });

  it("fails on persona drift, weak social cues, tool leakage, and missing predictions", () => {
    const result = applyBehaviorPromotionGate({
      candidate: {
        ...reportFixture(),
        personaConsistencyRate: 0.5,
        socialCueAccuracy: 0.7,
        toolAbstainAccuracy: 0.9,
        missingPredictions: 1,
      },
    });
    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining(["personaConsistencyRate", "socialCueAccuracy", "toolAbstainAccuracy", "missingPredictions"]),
    );
  });

  it("fails when a candidate regresses from a baseline beyond tolerance", () => {
    const result = applyBehaviorPromotionGate({
      candidate: { ...reportFixture(), requirementPassRate: 0.95 },
      baseline: reportFixture(),
      thresholds: { maxScoreRegression: 0.01 },
    });
    expect(result.status).toBe("fail");
    expect(result.failures).toContainEqual(
      expect.objectContaining({ metric: "requirementPassRate", message: "requirementPassRate regressed from baseline" }),
    );
  });
});

function reportFixture(): BehaviorEvalReport {
  return {
    suitePath: "training/evals/behavior.eval.jsonl",
    predictionsPath: "training/evals/behavior-oracle.predictions.jsonl",
    total: 12,
    parseOk: 12,
    validJsonRate: 1,
    actionTypeAccuracy: 1,
    requirementPassRate: 1,
    personaConsistencyRate: 1,
    socialCueAccuracy: 1,
    casualToneAccuracy: 1,
    toolAbstainAccuracy: 1,
    boundaryAccuracy: 1,
    missingPredictions: 0,
    latencyMs: { count: 12, average: 20, p95: 30, max: 31 },
    byKind: {},
    failures: [],
  };
}
