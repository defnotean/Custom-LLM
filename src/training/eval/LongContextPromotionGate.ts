import type { LongContextEvalReport } from "./LongContextEvalSuite";

export interface LongContextPromotionThresholds {
  minTotalCases: number;
  minAnswerRate: number;
  minExactMatchRate: number;
  minExpectedContainRate: number;
  maxMissingPredictions: number;
  maxFalsePositiveRate: number;
  maxP95LatencyMs?: number;
  maxAccuracyRegression: number;
  maxFalsePositiveRateIncrease: number;
}

export interface LongContextPromotionGateOptions {
  candidate: LongContextEvalReport;
  baseline?: LongContextEvalReport;
  thresholds?: Partial<LongContextPromotionThresholds>;
}

export interface LongContextPromotionGateFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface LongContextPromotionGateResult {
  status: "pass" | "fail";
  thresholds: LongContextPromotionThresholds;
  candidate: LongContextPromotionSummary;
  baseline?: LongContextPromotionSummary;
  failures: LongContextPromotionGateFailure[];
  warnings: string[];
}

export interface LongContextPromotionSummary {
  suitePath: string;
  predictionsPath: string;
  total: number;
  answerRate: number;
  exactMatchRate: number;
  expectedContainRate: number;
  missingPredictions: number;
  falsePositiveRate: number;
  latencyP95Ms: number | null;
}

export const DEFAULT_LONG_CONTEXT_PROMOTION_THRESHOLDS: LongContextPromotionThresholds = {
  minTotalCases: 12,
  minAnswerRate: 0.95,
  minExactMatchRate: 0.9,
  minExpectedContainRate: 0.95,
  maxMissingPredictions: 0,
  maxFalsePositiveRate: 0,
  maxAccuracyRegression: 0.03,
  maxFalsePositiveRateIncrease: 0.02,
};

export function applyLongContextPromotionGate(
  options: LongContextPromotionGateOptions,
): LongContextPromotionGateResult {
  const thresholds = { ...DEFAULT_LONG_CONTEXT_PROMOTION_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures: LongContextPromotionGateFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "answerRate", candidate.answerRate, thresholds.minAnswerRate);
  failIfBelow(failures, "exactMatchRate", candidate.exactMatchRate, thresholds.minExactMatchRate);
  failIfBelow(failures, "expectedContainRate", candidate.expectedContainRate, thresholds.minExpectedContainRate);
  failIfAbove(failures, "missingPredictions", candidate.missingPredictions, thresholds.maxMissingPredictions);
  failIfAbove(failures, "falsePositiveRate", candidate.falsePositiveRate, thresholds.maxFalsePositiveRate);

  if (thresholds.maxP95LatencyMs !== undefined) {
    failIfAbove(failures, "latencyMs.p95", candidate.latencyMs.p95, thresholds.maxP95LatencyMs);
  } else if (candidate.latencyMs.count === 0) {
    warnings.push("candidate report has no latency samples; latency promotion checks were skipped");
  }

  if (options.baseline) {
    compareBaseline(candidate, options.baseline, thresholds, failures, warnings);
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    candidate: summarizeLongContextReport(candidate),
    ...(options.baseline ? { baseline: summarizeLongContextReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeLongContextReport(report: LongContextEvalReport): LongContextPromotionSummary {
  return {
    suitePath: report.suitePath,
    predictionsPath: report.predictionsPath,
    total: report.total,
    answerRate: report.answerRate,
    exactMatchRate: report.exactMatchRate,
    expectedContainRate: report.expectedContainRate,
    missingPredictions: report.missingPredictions,
    falsePositiveRate: report.falsePositiveRate,
    latencyP95Ms: report.latencyMs.p95,
  };
}

function compareBaseline(
  candidate: LongContextEvalReport,
  baseline: LongContextEvalReport,
  thresholds: LongContextPromotionThresholds,
  failures: LongContextPromotionGateFailure[],
  warnings: string[],
): void {
  for (const metric of ["answerRate", "exactMatchRate", "expectedContainRate"] as const) {
    const minimum = Number((baseline[metric] - thresholds.maxAccuracyRegression).toFixed(6));
    if (candidate[metric] < minimum) {
      failures.push({
        metric,
        actual: candidate[metric],
        expected: `>= baseline ${baseline[metric]} - ${thresholds.maxAccuracyRegression}`,
        message: `${metric} regressed from baseline`,
      });
    }
  }

  const falsePositiveCeiling = Number(
    (baseline.falsePositiveRate + thresholds.maxFalsePositiveRateIncrease).toFixed(6),
  );
  failIfAbove(failures, "falsePositiveRate", candidate.falsePositiveRate, falsePositiveCeiling);

  if (thresholds.maxP95LatencyMs !== undefined) return;
  if (candidate.latencyMs.p95 === null || baseline.latencyMs.p95 === null) {
    warnings.push("baseline latency comparison skipped because one report has no p95 latency");
  }
}

function failIfBelow(
  failures: LongContextPromotionGateFailure[],
  metric: string,
  actual: number | null,
  minimum: number,
): void {
  if (actual === null || actual < minimum) {
    failures.push({
      metric,
      actual,
      expected: `>= ${minimum}`,
      message: `${metric} is below promotion threshold`,
    });
  }
}

function failIfAbove(
  failures: LongContextPromotionGateFailure[],
  metric: string,
  actual: number | null,
  maximum: number,
): void {
  if (actual === null || actual > maximum) {
    failures.push({
      metric,
      actual,
      expected: `<= ${maximum}`,
      message: `${metric} is above promotion threshold`,
    });
  }
}
