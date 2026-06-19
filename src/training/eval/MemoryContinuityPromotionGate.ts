import type { MemoryContinuityReport } from "./MemoryContinuityEvalSuite";

export interface MemoryContinuityPromotionThresholds {
  minTotalCases: number;
  minPassRate: number;
  minStoredExpectedRate: number;
  minRecallHitRate: number;
  minIsolationPassRate: number;
  minForgetPassRate: number;
  minPolicyRejectionPassRate: number;
  minLearnedItemPassRate: number;
  maxFailures: number;
  maxP95LatencyMs?: number;
  maxPassRateRegression: number;
  maxRecallRegression: number;
}

export interface MemoryContinuityPromotionOptions {
  candidate: MemoryContinuityReport;
  baseline?: MemoryContinuityReport;
  thresholds?: Partial<MemoryContinuityPromotionThresholds>;
}

export interface MemoryContinuityPromotionFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface MemoryContinuityPromotionResult {
  status: "pass" | "fail";
  thresholds: MemoryContinuityPromotionThresholds;
  candidate: MemoryContinuityReportSummary;
  baseline?: MemoryContinuityReportSummary;
  failures: MemoryContinuityPromotionFailure[];
  warnings: string[];
}

export interface MemoryContinuityReportSummary {
  suitePath: string;
  total: number;
  passRate: number;
  storedExpectedRate: number;
  recallHitRate: number;
  isolationPassRate: number;
  forgetPassRate: number;
  policyRejectionPassRate: number;
  learnedItemPassRate: number;
  failures: number;
  latencyP95Ms: number | null;
}

export const DEFAULT_MEMORY_CONTINUITY_THRESHOLDS: MemoryContinuityPromotionThresholds = {
  minTotalCases: 17,
  minPassRate: 1,
  minStoredExpectedRate: 1,
  minRecallHitRate: 1,
  minIsolationPassRate: 1,
  minForgetPassRate: 1,
  minPolicyRejectionPassRate: 1,
  minLearnedItemPassRate: 1,
  maxFailures: 0,
  maxPassRateRegression: 0,
  maxRecallRegression: 0,
};

export function applyMemoryContinuityPromotionGate(
  options: MemoryContinuityPromotionOptions,
): MemoryContinuityPromotionResult {
  const thresholds = { ...DEFAULT_MEMORY_CONTINUITY_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures: MemoryContinuityPromotionFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "passRate", candidate.passRate, thresholds.minPassRate);
  failIfBelow(failures, "storedExpectedRate", candidate.storedExpectedRate, thresholds.minStoredExpectedRate);
  failIfBelow(failures, "recallHitRate", candidate.recallHitRate, thresholds.minRecallHitRate);
  failIfBelow(failures, "isolationPassRate", candidate.isolationPassRate, thresholds.minIsolationPassRate);
  failIfBelow(failures, "forgetPassRate", candidate.forgetPassRate, thresholds.minForgetPassRate);
  failIfBelow(
    failures,
    "policyRejectionPassRate",
    candidate.policyRejectionPassRate,
    thresholds.minPolicyRejectionPassRate,
  );
  failIfBelow(failures, "learnedItemPassRate", candidate.learnedItemPassRate, thresholds.minLearnedItemPassRate);
  failIfAbove(failures, "failures", candidate.failures.length, thresholds.maxFailures);

  if (thresholds.maxP95LatencyMs !== undefined) {
    failIfAbove(failures, "latencyMs.p95", candidate.latencyMs.p95, thresholds.maxP95LatencyMs);
  } else if (candidate.latencyMs.count === 0) {
    warnings.push("candidate report has no latency samples; latency promotion checks were skipped");
  }

  if (options.baseline) compareBaseline(candidate, options.baseline, thresholds, failures);

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    candidate: summarizeMemoryContinuityReport(candidate),
    ...(options.baseline ? { baseline: summarizeMemoryContinuityReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeMemoryContinuityReport(report: MemoryContinuityReport): MemoryContinuityReportSummary {
  return {
    suitePath: report.suitePath,
    total: report.total,
    passRate: report.passRate,
    storedExpectedRate: report.storedExpectedRate,
    recallHitRate: report.recallHitRate,
    isolationPassRate: report.isolationPassRate,
    forgetPassRate: report.forgetPassRate,
    policyRejectionPassRate: report.policyRejectionPassRate,
    learnedItemPassRate: report.learnedItemPassRate,
    failures: report.failures.length,
    latencyP95Ms: report.latencyMs.p95,
  };
}

function compareBaseline(
  candidate: MemoryContinuityReport,
  baseline: MemoryContinuityReport,
  thresholds: MemoryContinuityPromotionThresholds,
  failures: MemoryContinuityPromotionFailure[],
): void {
  const minPassRate = Number((baseline.passRate - thresholds.maxPassRateRegression).toFixed(6));
  if (candidate.passRate < minPassRate) {
    failures.push({
      metric: "passRate",
      actual: candidate.passRate,
      expected: `>= baseline ${baseline.passRate} - ${thresholds.maxPassRateRegression}`,
      message: "passRate regressed from baseline",
    });
  }

  const minRecallHitRate = Number((baseline.recallHitRate - thresholds.maxRecallRegression).toFixed(6));
  if (candidate.recallHitRate < minRecallHitRate) {
    failures.push({
      metric: "recallHitRate",
      actual: candidate.recallHitRate,
      expected: `>= baseline ${baseline.recallHitRate} - ${thresholds.maxRecallRegression}`,
      message: "recallHitRate regressed from baseline",
    });
  }
}

function failIfBelow(
  failures: MemoryContinuityPromotionFailure[],
  metric: string,
  actual: number | null,
  expected: number,
): void {
  if (actual === null || actual < expected) {
    failures.push({ metric, actual, expected: `>= ${expected}`, message: `${metric} below threshold` });
  }
}

function failIfAbove(
  failures: MemoryContinuityPromotionFailure[],
  metric: string,
  actual: number | null,
  expected: number,
): void {
  if (actual === null || actual > expected) {
    failures.push({ metric, actual, expected: `<= ${expected}`, message: `${metric} above threshold` });
  }
}
