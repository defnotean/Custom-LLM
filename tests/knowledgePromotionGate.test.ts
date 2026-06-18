import { describe, expect, it } from "vitest";
import { applyKnowledgePromotionGate } from "../src/training/eval/KnowledgePromotionGate";
import type { KnowledgeEvalReport } from "../src/training/eval/KnowledgeEvalSuite";

describe("KnowledgePromotionGate", () => {
  it("passes a strong knowledge report", () => {
    const result = applyKnowledgePromotionGate({
      candidate: makeReport(),
      thresholds: { maxP95LatencyMs: 500 },
    });

    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
    expect(result.candidate.lowScoreRate).toBe(0.02);
  });

  it("fails threshold violations", () => {
    const result = applyKnowledgePromotionGate({
      candidate: makeReport({
        answerRate: 0.5,
        averageTokenF1: 0.2,
        averageRougeL: 0.2,
        missingPredictions: 1,
        lowScoreCount: 40,
        latencyP95Ms: 900,
      }),
      thresholds: { maxP95LatencyMs: 500 },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining([
        "answerRate",
        "averageTokenF1",
        "averageRougeL",
        "missingPredictions",
        "lowScoreRate",
        "latencyMs.p95",
      ]),
    );
  });

  it("fails baseline regressions beyond tolerance", () => {
    const result = applyKnowledgePromotionGate({
      baseline: makeReport({ averageTokenF1: 0.7, averageRougeL: 0.72, lowScoreCount: 4 }),
      candidate: makeReport({ averageTokenF1: 0.6, averageRougeL: 0.6, lowScoreCount: 15 }),
      thresholds: {
        minAverageTokenF1: 0.3,
        minAverageRougeL: 0.3,
        maxScoreRegression: 0.03,
        maxLowScoreRateIncrease: 0.05,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.message)).toEqual(
      expect.arrayContaining([
        "averageTokenF1 regressed from baseline",
        "averageRougeL regressed from baseline",
        "lowScoreRate is above promotion threshold",
      ]),
    );
  });
});

function makeReport(
  overrides?: Partial<{
    answerRate: number;
    exactMatchRate: number;
    averageTokenF1: number;
    averageRougeL: number;
    missingPredictions: number;
    lowScoreCount: number;
    latencyP95Ms: number | null;
  }>,
): KnowledgeEvalReport {
  return {
    suitePath: "training/evals/knowledge.eval.jsonl",
    predictionsPath: "training/evals/knowledge.predictions.jsonl",
    total: 100,
    answered: Math.round((overrides?.answerRate ?? 0.98) * 100),
    answerRate: overrides?.answerRate ?? 0.98,
    exactMatchRate: overrides?.exactMatchRate ?? 0.5,
    averageTokenF1: overrides?.averageTokenF1 ?? 0.7,
    averageRougeL: overrides?.averageRougeL ?? 0.72,
    missingPredictions: overrides?.missingPredictions ?? 0,
    lowScoreCount: overrides?.lowScoreCount ?? 2,
    latencyMs: {
      count: overrides?.latencyP95Ms === null ? 0 : 100,
      average: overrides?.latencyP95Ms === null ? null : 80,
      p95: overrides?.latencyP95Ms ?? 120,
      max: overrides?.latencyP95Ms === null ? null : 160,
    },
    bySource: {},
    failures: [],
  };
}
