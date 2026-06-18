import { describe, expect, it } from "vitest";
import {
  applySpecialistRoutingPromotionGate,
  type SpecialistRoutingPromotionResult,
} from "../src/training/eval/SpecialistRoutingPromotionGate";
import type { SpecialistRoutingReport } from "../src/training/eval/SpecialistRoutingEvalSuite";

describe("SpecialistRoutingPromotionGate", () => {
  it("passes a complete high-quality router report", () => {
    const result = applySpecialistRoutingPromotionGate({ candidate: report() });
    expect(result.status).toBe("pass");
    expect(result.failures).toEqual([]);
  });

  it("fails weak route accuracy and invalid predictions", () => {
    const result: SpecialistRoutingPromotionResult = applySpecialistRoutingPromotionGate({
      candidate: report({ routeAccuracy: 0.8, invalidPredictions: 1 }),
    });
    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining(["routeAccuracy", "invalidPredictions"]),
    );
  });
});

function report(overrides: Partial<SpecialistRoutingReport> = {}): SpecialistRoutingReport {
  return {
    suitePath: "training/evals/specialist-routing.eval.jsonl",
    predictionsPath: "training/evals/specialist-routing-oracle.predictions.jsonl",
    total: 18,
    routeAccuracy: 1,
    expertAccuracy: 1,
    toolVsNonToolAccuracy: 1,
    missingPredictions: 0,
    invalidPredictions: 0,
    latencyMs: { count: 18, average: 8, p95: 8, max: 8 },
    byRoute: {},
    failures: [],
    ...overrides,
  };
}
