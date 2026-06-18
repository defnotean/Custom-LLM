import { describe, expect, it } from "vitest";
import {
  applySkillRetrievalPromotionGate,
  type SkillRetrievalPromotionResult,
} from "../src/training/eval/SkillRetrievalPromotionGate";
import type { SkillRetrievalReport } from "../src/training/eval/SkillRetrievalEvalSuite";

describe("SkillRetrievalPromotionGate", () => {
  it("passes a complete high-quality skill retrieval report", () => {
    const result = applySkillRetrievalPromotionGate({ candidate: report() });
    expect(result.status).toBe("pass");
    expect(result.failures).toEqual([]);
  });

  it("fails weak recall, false positives, and missing expected skills", () => {
    const result: SkillRetrievalPromotionResult = applySkillRetrievalPromotionGate({
      candidate: report({ recallAtK: 0.8, precisionAtK: 0.9, forbiddenHits: 1, missingExpected: 1 }),
    });
    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining(["recallAtK", "precisionAtK", "forbiddenHits", "missingExpected"]),
    );
  });
});

function report(overrides: Partial<SkillRetrievalReport> = {}): SkillRetrievalReport {
  return {
    suitePath: "training/evals/skill-retrieval.eval.json",
    total: 10,
    recallAtK: 1,
    precisionAtK: 1,
    top1Accuracy: 1,
    noHitAccuracy: 1,
    forbiddenHits: 0,
    missingExpected: 0,
    latencyMs: { count: 10, average: 1, p95: 1, max: 1 },
    byKind: {},
    failures: [],
    results: [],
    ...overrides,
  };
}
