import { describe, expect, it } from "vitest";
import {
  applyPromotionGate,
  DEFAULT_PROMOTION_THRESHOLDS,
  type PromotionThresholds,
} from "../src/training/eval/PromotionGate";
import type { EvalReport } from "../src/training/eval/ToolEvalSuite";

describe("PromotionGate", () => {
  it("passes a strong candidate report", () => {
    const result = applyPromotionGate({
      candidate: makeReport(),
      thresholds: { maxP95LatencyMs: 500 },
    });

    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
    expect(result.candidate.latencyP95Ms).toBe(120);
  });

  it("fails hard threshold violations", () => {
    const candidate = makeReport({
      validJsonRate: 0.5,
      hallucinatedToolRate: 0.25,
      missingPredictions: 1,
      latencyP95Ms: 900,
    });
    const result = applyPromotionGate({
      candidate,
      thresholds: { maxP95LatencyMs: 500 },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining(["validJsonRate", "hallucinatedToolRate", "missingPredictions", "latencyMs.p95"]),
    );
  });

  it("fails baseline regressions beyond tolerance", () => {
    const baseline = makeReport({ actionTypeAccuracy: 0.96, noToolAccuracy: 1, hallucinatedToolRate: 0 });
    const candidate = makeReport({ actionTypeAccuracy: 0.9, noToolAccuracy: 0.96, hallucinatedToolRate: 0.01 });
    const result = applyPromotionGate({
      candidate,
      baseline,
      thresholds: {
        ...DEFAULT_PROMOTION_THRESHOLDS,
        minActionTypeAccuracy: 0.8,
        minNoToolAccuracy: 0.8,
        maxHallucinatedToolRate: 0.05,
        maxAccuracyRegression: 0.02,
        maxHallucinationIncrease: 0,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.message)).toEqual(
      expect.arrayContaining([
        "actionTypeAccuracy regressed from baseline",
        "noToolAccuracy regressed from baseline",
        "hallucinatedToolRate increased from baseline",
      ]),
    );
  });
});

function makeReport(
  overrides?: Partial<{
    validJsonRate: number;
    actionTypeAccuracy: number;
    toolNameAccuracy: number;
    toolArgumentValidity: number;
    noToolAccuracy: number;
    hallucinatedToolRate: number;
    missingPredictions: number;
    latencyP95Ms: number | null;
    thresholds: Partial<PromotionThresholds>;
  }>,
): EvalReport {
  return {
    suitePath: "training/evals/tool-routing.eval.jsonl",
    predictionsPath: "training/evals/candidate.predictions.jsonl",
    total: 200,
    parseOk: 200,
    validJsonRate: overrides?.validJsonRate ?? 1,
    actionTypeAccuracy: overrides?.actionTypeAccuracy ?? 0.97,
    toolNameAccuracy: overrides?.toolNameAccuracy ?? 0.95,
    toolArgumentValidity: overrides?.toolArgumentValidity ?? 0.94,
    noToolAccuracy: overrides?.noToolAccuracy ?? 1,
    hallucinatedToolRate: overrides?.hallucinatedToolRate ?? 0,
    missingPredictions: overrides?.missingPredictions ?? 0,
    latencyMs: {
      count: overrides?.latencyP95Ms === null ? 0 : 200,
      average: overrides?.latencyP95Ms === null ? null : 90,
      p95: overrides?.latencyP95Ms ?? 120,
      max: overrides?.latencyP95Ms === null ? null : 150,
    },
    byKind: {},
    failures: [],
  };
}
