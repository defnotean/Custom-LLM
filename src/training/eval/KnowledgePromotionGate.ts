import type { KnowledgeEvalReport } from "./KnowledgeEvalSuite";

export interface KnowledgePromotionThresholds {
  minTotalCases: number;
  minAnswerRate: number;
  minAverageTokenF1: number;
  minAverageRougeL: number;
  maxMissingPredictions: number;
  maxLowScoreRate: number;
  maxP95LatencyMs?: number;
  maxScoreRegression: number;
  maxLowScoreRateIncrease: number;
}

export interface KnowledgePromotionGateOptions {
  candidate: KnowledgeEvalReport;
  baseline?: KnowledgeEvalReport;
  thresholds?: Partial<KnowledgePromotionThresholds>;
}

export interface KnowledgePromotionGateFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface KnowledgePromotionGateResult {
  status: "pass" | "fail";
  thresholds: KnowledgePromotionThresholds;
  candidate: KnowledgePromotionSummary;
  baseline?: KnowledgePromotionSummary;
  failures: KnowledgePromotionGateFailure[];
  warnings: string[];
}

export interface KnowledgePromotionSummary {
  suitePath: string;
  predictionsPath: string;
  total: number;
  answerRate: number;
  exactMatchRate: number;
  averageTokenF1: number;
  averageRougeL: number;
  missingPredictions: number;
  lowScoreRate: number;
  latencyP95Ms: number | null;
}

export const DEFAULT_KNOWLEDGE_PROMOTION_THRESHOLDS: KnowledgePromotionThresholds = {
  minTotalCases: 50,
  minAnswerRate: 0.95,
  minAverageTokenF1: 0.35,
  minAverageRougeL: 0.35,
  maxMissingPredictions: 0,
  maxLowScoreRate: 0.25,
  maxScoreRegression: 0.03,
  maxLowScoreRateIncrease: 0.05,
};

export function applyKnowledgePromotionGate(
  options: KnowledgePromotionGateOptions,
): KnowledgePromotionGateResult {
  const thresholds = { ...DEFAULT_KNOWLEDGE_PROMOTION_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures: KnowledgePromotionGateFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "answerRate", candidate.answerRate, thresholds.minAnswerRate);
  failIfBelow(failures, "averageTokenF1", candidate.averageTokenF1, thresholds.minAverageTokenF1);
  failIfBelow(failures, "averageRougeL", candidate.averageRougeL, thresholds.minAverageRougeL);
  failIfAbove(failures, "missingPredictions", candidate.missingPredictions, thresholds.maxMissingPredictions);
  failIfAbove(failures, "lowScoreRate", lowScoreRate(candidate), thresholds.maxLowScoreRate);

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
    candidate: summarizeKnowledgeReport(candidate),
    ...(options.baseline ? { baseline: summarizeKnowledgeReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeKnowledgeReport(report: KnowledgeEvalReport): KnowledgePromotionSummary {
  return {
    suitePath: report.suitePath,
    predictionsPath: report.predictionsPath,
    total: report.total,
    answerRate: report.answerRate,
    exactMatchRate: report.exactMatchRate,
    averageTokenF1: report.averageTokenF1,
    averageRougeL: report.averageRougeL,
    missingPredictions: report.missingPredictions,
    lowScoreRate: lowScoreRate(report),
    latencyP95Ms: report.latencyMs.p95,
  };
}

function compareBaseline(
  candidate: KnowledgeEvalReport,
  baseline: KnowledgeEvalReport,
  thresholds: KnowledgePromotionThresholds,
  failures: KnowledgePromotionGateFailure[],
  warnings: string[],
): void {
  for (const metric of ["answerRate", "averageTokenF1", "averageRougeL"] as const) {
    const minimum = Number((baseline[metric] - thresholds.maxScoreRegression).toFixed(6));
    if (candidate[metric] < minimum) {
      failures.push({
        metric,
        actual: candidate[metric],
        expected: `>= baseline ${baseline[metric]} - ${thresholds.maxScoreRegression}`,
        message: `${metric} regressed from baseline`,
      });
    }
  }

  const lowScoreCeiling = Number((lowScoreRate(baseline) + thresholds.maxLowScoreRateIncrease).toFixed(6));
  failIfAbove(failures, "lowScoreRate", lowScoreRate(candidate), lowScoreCeiling);

  if (thresholds.maxP95LatencyMs !== undefined) return;
  if (candidate.latencyMs.p95 === null || baseline.latencyMs.p95 === null) {
    warnings.push("baseline latency comparison skipped because one report has no p95 latency");
  }
}

function lowScoreRate(report: KnowledgeEvalReport): number {
  return report.total === 0 ? 0 : Number((report.lowScoreCount / report.total).toFixed(6));
}

function failIfBelow(
  failures: KnowledgePromotionGateFailure[],
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
  failures: KnowledgePromotionGateFailure[],
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
