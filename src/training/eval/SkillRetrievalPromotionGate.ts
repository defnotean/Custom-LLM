import type { SkillRetrievalReport } from "./SkillRetrievalEvalSuite";

export interface SkillRetrievalPromotionThresholds {
  minTotalCases: number;
  minRecallAtK: number;
  minPrecisionAtK: number;
  minTop1Accuracy: number;
  minNoHitAccuracy: number;
  maxForbiddenHits: number;
  maxMissingExpected: number;
  maxP95LatencyMs?: number;
  maxRecallRegression: number;
  maxPrecisionRegression: number;
}

export interface SkillRetrievalPromotionOptions {
  candidate: SkillRetrievalReport;
  baseline?: SkillRetrievalReport;
  thresholds?: Partial<SkillRetrievalPromotionThresholds>;
}

export interface SkillRetrievalPromotionFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface SkillRetrievalPromotionResult {
  status: "pass" | "fail";
  thresholds: SkillRetrievalPromotionThresholds;
  candidate: SkillRetrievalReportSummary;
  baseline?: SkillRetrievalReportSummary;
  failures: SkillRetrievalPromotionFailure[];
  warnings: string[];
}

export interface SkillRetrievalReportSummary {
  suitePath: string;
  total: number;
  recallAtK: number;
  precisionAtK: number;
  top1Accuracy: number;
  noHitAccuracy: number;
  forbiddenHits: number;
  missingExpected: number;
  failures: number;
  latencyP95Ms: number | null;
}

export const DEFAULT_SKILL_RETRIEVAL_THRESHOLDS: SkillRetrievalPromotionThresholds = {
  minTotalCases: 10,
  minRecallAtK: 1,
  minPrecisionAtK: 1,
  minTop1Accuracy: 1,
  minNoHitAccuracy: 1,
  maxForbiddenHits: 0,
  maxMissingExpected: 0,
  maxRecallRegression: 0.01,
  maxPrecisionRegression: 0.01,
};

export function applySkillRetrievalPromotionGate(
  options: SkillRetrievalPromotionOptions,
): SkillRetrievalPromotionResult {
  const thresholds = { ...DEFAULT_SKILL_RETRIEVAL_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures: SkillRetrievalPromotionFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "recallAtK", candidate.recallAtK, thresholds.minRecallAtK);
  failIfBelow(failures, "precisionAtK", candidate.precisionAtK, thresholds.minPrecisionAtK);
  failIfBelow(failures, "top1Accuracy", candidate.top1Accuracy, thresholds.minTop1Accuracy);
  failIfBelow(failures, "noHitAccuracy", candidate.noHitAccuracy, thresholds.minNoHitAccuracy);
  failIfAbove(failures, "forbiddenHits", candidate.forbiddenHits, thresholds.maxForbiddenHits);
  failIfAbove(failures, "missingExpected", candidate.missingExpected, thresholds.maxMissingExpected);

  if (thresholds.maxP95LatencyMs !== undefined) {
    failIfAbove(failures, "latencyMs.p95", candidate.latencyMs.p95, thresholds.maxP95LatencyMs);
  } else if (candidate.latencyMs.count === 0) {
    warnings.push("candidate report has no latency samples; latency promotion checks were skipped");
  }

  if (options.baseline) compareBaseline(candidate, options.baseline, thresholds, failures);

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    candidate: summarizeSkillRetrievalReport(candidate),
    ...(options.baseline ? { baseline: summarizeSkillRetrievalReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeSkillRetrievalReport(report: SkillRetrievalReport): SkillRetrievalReportSummary {
  return {
    suitePath: report.suitePath,
    total: report.total,
    recallAtK: report.recallAtK,
    precisionAtK: report.precisionAtK,
    top1Accuracy: report.top1Accuracy,
    noHitAccuracy: report.noHitAccuracy,
    forbiddenHits: report.forbiddenHits,
    missingExpected: report.missingExpected,
    failures: report.failures.length,
    latencyP95Ms: report.latencyMs.p95,
  };
}

function compareBaseline(
  candidate: SkillRetrievalReport,
  baseline: SkillRetrievalReport,
  thresholds: SkillRetrievalPromotionThresholds,
  failures: SkillRetrievalPromotionFailure[],
): void {
  const minRecall = Number((baseline.recallAtK - thresholds.maxRecallRegression).toFixed(6));
  if (candidate.recallAtK < minRecall) {
    failures.push({
      metric: "recallAtK",
      actual: candidate.recallAtK,
      expected: `>= baseline ${baseline.recallAtK} - ${thresholds.maxRecallRegression}`,
      message: "recallAtK regressed from baseline",
    });
  }

  const minPrecision = Number((baseline.precisionAtK - thresholds.maxPrecisionRegression).toFixed(6));
  if (candidate.precisionAtK < minPrecision) {
    failures.push({
      metric: "precisionAtK",
      actual: candidate.precisionAtK,
      expected: `>= baseline ${baseline.precisionAtK} - ${thresholds.maxPrecisionRegression}`,
      message: "precisionAtK regressed from baseline",
    });
  }
}

function failIfBelow(
  failures: SkillRetrievalPromotionFailure[],
  metric: string,
  actual: number | null,
  expected: number,
): void {
  if (actual === null || actual < expected) {
    failures.push({ metric, actual, expected: `>= ${expected}`, message: `${metric} below threshold` });
  }
}

function failIfAbove(
  failures: SkillRetrievalPromotionFailure[],
  metric: string,
  actual: number | null,
  expected: number,
): void {
  if (actual === null || actual > expected) {
    failures.push({ metric, actual, expected: `<= ${expected}`, message: `${metric} above threshold` });
  }
}
