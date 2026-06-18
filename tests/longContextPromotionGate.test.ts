import { describe, expect, it } from "vitest";
import { applyLongContextPromotionGate } from "../src/training/eval/LongContextPromotionGate";
import type { LongContextEvalReport } from "../src/training/eval/LongContextEvalSuite";

describe("LongContextPromotionGate", () => {
  it("passes a strong long-context report", () => {
    const result = applyLongContextPromotionGate({
      candidate: makeReport(),
      thresholds: { maxP95LatencyMs: 500 },
    });

    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
    expect(result.candidate.falsePositiveRate).toBe(0);
  });

  it("fails threshold violations", () => {
    const result = applyLongContextPromotionGate({
      candidate: makeReport({
        answerRate: 0.7,
        exactMatchRate: 0.6,
        expectedContainRate: 0.7,
        missingPredictions: 1,
        falsePositiveRate: 0.2,
        latencyP95Ms: 900,
      }),
      thresholds: { maxP95LatencyMs: 500 },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining([
        "answerRate",
        "exactMatchRate",
        "expectedContainRate",
        "missingPredictions",
        "falsePositiveRate",
        "latencyMs.p95",
      ]),
    );
  });

  it("fails baseline regressions beyond tolerance", () => {
    const result = applyLongContextPromotionGate({
      baseline: makeReport({ exactMatchRate: 0.95, expectedContainRate: 0.98, falsePositiveRate: 0.01 }),
      candidate: makeReport({ exactMatchRate: 0.85, expectedContainRate: 0.86, falsePositiveRate: 0.08 }),
      thresholds: {
        minExactMatchRate: 0.8,
        minExpectedContainRate: 0.8,
        maxAccuracyRegression: 0.03,
        maxFalsePositiveRateIncrease: 0.02,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.message)).toEqual(
      expect.arrayContaining([
        "exactMatchRate regressed from baseline",
        "expectedContainRate regressed from baseline",
        "falsePositiveRate is above promotion threshold",
      ]),
    );
  });
});

function makeReport(
  overrides?: Partial<{
    answerRate: number;
    exactMatchRate: number;
    expectedContainRate: number;
    missingPredictions: number;
    falsePositiveRate: number;
    latencyP95Ms: number | null;
  }>,
): LongContextEvalReport {
  const total = 12;
  const falsePositiveRate = overrides?.falsePositiveRate ?? 0;
  return {
    suitePath: "training/evals/long-context.eval.jsonl",
    predictionsPath: "training/evals/long-context.predictions.jsonl",
    total,
    answered: Math.round((overrides?.answerRate ?? 1) * total),
    answerRate: overrides?.answerRate ?? 1,
    exactMatchRate: overrides?.exactMatchRate ?? 0.95,
    expectedContainRate: overrides?.expectedContainRate ?? 1,
    missingPredictions: overrides?.missingPredictions ?? 0,
    falsePositiveCount: Math.round(falsePositiveRate * total),
    falsePositiveRate,
    latencyMs: {
      count: overrides?.latencyP95Ms === null ? 0 : total,
      average: overrides?.latencyP95Ms === null ? null : 90,
      p95: overrides?.latencyP95Ms ?? 150,
      max: overrides?.latencyP95Ms === null ? null : 180,
    },
    byNeedlePosition: {
      early: { total: 4, exactMatchRate: 1, expectedContainRate: 1 },
      middle: { total: 4, exactMatchRate: 1, expectedContainRate: 1 },
      late: { total: 4, exactMatchRate: 0.875, expectedContainRate: 1 },
    },
    byContextTarget: {},
    failures: [],
  };
}
