import { describe, expect, it } from "vitest";
import {
  applyMemoryContinuityPromotionGate,
  type MemoryContinuityPromotionResult,
} from "../src/training/eval/MemoryContinuityPromotionGate";
import type { MemoryContinuityReport } from "../src/training/eval/MemoryContinuityEvalSuite";

describe("MemoryContinuityPromotionGate", () => {
  it("passes a complete high-quality memory continuity report", () => {
    const result = applyMemoryContinuityPromotionGate({ candidate: report() });
    expect(result.status).toBe("pass");
    expect(result.failures).toEqual([]);
  });

  it("fails weak recall, isolation, rejection, and learned-item capture", () => {
    const result: MemoryContinuityPromotionResult = applyMemoryContinuityPromotionGate({
      candidate: report({
        recallHitRate: 0.9,
        isolationPassRate: 0.8,
        policyRejectionPassRate: 0.5,
        learnedItemPassRate: 0.5,
        failures: [{ id: "bad", kind: "explicit_recall", reasons: ["bad recall"] }],
      }),
    });
    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining([
        "recallHitRate",
        "isolationPassRate",
        "policyRejectionPassRate",
        "learnedItemPassRate",
        "failures",
      ]),
    );
  });
});

function report(overrides: Partial<MemoryContinuityReport> = {}): MemoryContinuityReport {
  return {
    suitePath: "training/evals/memory-continuity.eval.json",
    total: 12,
    passRate: 1,
    storedExpectedRate: 1,
    recallHitRate: 1,
    isolationPassRate: 1,
    forgetPassRate: 1,
    policyRejectionPassRate: 1,
    learnedItemPassRate: 1,
    latencyMs: { count: 12, average: 1, p95: 1, max: 1 },
    byKind: {},
    failures: [],
    results: [],
    ...overrides,
  };
}
