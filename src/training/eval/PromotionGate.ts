import type { EvalReport } from "./ToolEvalSuite";

export interface PromotionThresholds {
  minTotalCases: number;
  minValidJsonRate: number;
  minActionTypeAccuracy: number;
  minToolNameAccuracy: number;
  minToolArgumentValidity: number;
  minNoToolAccuracy: number;
  maxHallucinatedToolRate: number;
  maxMissingPredictions: number;
  maxP95LatencyMs?: number;
  maxAccuracyRegression: number;
  maxHallucinationIncrease: number;
  maxMissingPredictionIncrease: number;
  maxP95LatencyIncreaseMs?: number;
}

export interface PromotionGateOptions {
  candidate: EvalReport;
  baseline?: EvalReport;
  thresholds?: Partial<PromotionThresholds>;
}

export interface PromotionGateFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface PromotionGateResult {
  status: "pass" | "fail";
  thresholds: PromotionThresholds;
  candidate: PromotionReportSummary;
  baseline?: PromotionReportSummary;
  failures: PromotionGateFailure[];
  warnings: string[];
}

export interface PromotionReportSummary {
  suitePath: string;
  predictionsPath: string;
  total: number;
  validJsonRate: number;
  actionTypeAccuracy: number;
  toolNameAccuracy: number | null;
  toolArgumentValidity: number | null;
  noToolAccuracy: number | null;
  hallucinatedToolRate: number;
  missingPredictions: number;
  failures: number;
  latencyP95Ms: number | null;
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minTotalCases: 200,
  minValidJsonRate: 0.98,
  minActionTypeAccuracy: 0.9,
  minToolNameAccuracy: 0.9,
  minToolArgumentValidity: 0.85,
  minNoToolAccuracy: 0.9,
  maxHallucinatedToolRate: 0.02,
  maxMissingPredictions: 0,
  maxAccuracyRegression: 0.02,
  maxHallucinationIncrease: 0,
  maxMissingPredictionIncrease: 0,
};

const ACCURACY_METRICS = [
  "validJsonRate",
  "actionTypeAccuracy",
  "toolNameAccuracy",
  "toolArgumentValidity",
  "noToolAccuracy",
] as const;

type AccuracyMetric = (typeof ACCURACY_METRICS)[number];

export function applyPromotionGate(options: PromotionGateOptions): PromotionGateResult {
  const thresholds: PromotionThresholds = {
    ...DEFAULT_PROMOTION_THRESHOLDS,
    ...(options.thresholds ?? {}),
  };
  const failures: PromotionGateFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "validJsonRate", candidate.validJsonRate, thresholds.minValidJsonRate);
  failIfBelow(failures, "actionTypeAccuracy", candidate.actionTypeAccuracy, thresholds.minActionTypeAccuracy);
  failIfBelow(failures, "toolNameAccuracy", candidate.toolNameAccuracy, thresholds.minToolNameAccuracy);
  failIfBelow(failures, "toolArgumentValidity", candidate.toolArgumentValidity, thresholds.minToolArgumentValidity);
  failIfBelow(failures, "noToolAccuracy", candidate.noToolAccuracy, thresholds.minNoToolAccuracy);
  failIfAbove(failures, "hallucinatedToolRate", candidate.hallucinatedToolRate, thresholds.maxHallucinatedToolRate);
  failIfAbove(failures, "missingPredictions", candidate.missingPredictions, thresholds.maxMissingPredictions);

  const candidateLatency = getLatency(candidate);
  if (thresholds.maxP95LatencyMs !== undefined) {
    failIfAbove(failures, "latencyMs.p95", candidateLatency.p95, thresholds.maxP95LatencyMs);
  } else if (candidateLatency.count === 0) {
    warnings.push("candidate report has no latency samples; latency promotion checks were skipped");
  }

  if (options.baseline) {
    compareBaseline(candidate, options.baseline, thresholds, failures, warnings);
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    candidate: summarizeReport(candidate),
    ...(options.baseline ? { baseline: summarizeReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeReport(report: EvalReport): PromotionReportSummary {
  return {
    suitePath: report.suitePath,
    predictionsPath: report.predictionsPath,
    total: report.total,
    validJsonRate: report.validJsonRate,
    actionTypeAccuracy: report.actionTypeAccuracy,
    toolNameAccuracy: report.toolNameAccuracy,
    toolArgumentValidity: report.toolArgumentValidity,
    noToolAccuracy: report.noToolAccuracy,
    hallucinatedToolRate: report.hallucinatedToolRate,
    missingPredictions: report.missingPredictions,
    failures: report.failures.length,
    latencyP95Ms: getLatency(report).p95,
  };
}

function compareBaseline(
  candidate: EvalReport,
  baseline: EvalReport,
  thresholds: PromotionThresholds,
  failures: PromotionGateFailure[],
  warnings: string[],
): void {
  for (const metric of ACCURACY_METRICS) {
    const candidateValue = candidate[metric];
    const baselineValue = baseline[metric];
    if (candidateValue === null || baselineValue === null) continue;
    const minimum = Number((baselineValue - thresholds.maxAccuracyRegression).toFixed(6));
    if (candidateValue < minimum) {
      failures.push({
        metric,
        actual: candidateValue,
        expected: `>= baseline ${baselineValue} - ${thresholds.maxAccuracyRegression}`,
        message: `${metric} regressed from baseline`,
      });
    }
  }

  const hallucinationCeiling = Number(
    (baseline.hallucinatedToolRate + thresholds.maxHallucinationIncrease).toFixed(6),
  );
  if (candidate.hallucinatedToolRate > hallucinationCeiling) {
    failures.push({
      metric: "hallucinatedToolRate",
      actual: candidate.hallucinatedToolRate,
      expected: `<= baseline ${baseline.hallucinatedToolRate} + ${thresholds.maxHallucinationIncrease}`,
      message: "hallucinatedToolRate increased from baseline",
    });
  }

  const missingCeiling = baseline.missingPredictions + thresholds.maxMissingPredictionIncrease;
  if (candidate.missingPredictions > missingCeiling) {
    failures.push({
      metric: "missingPredictions",
      actual: candidate.missingPredictions,
      expected: `<= baseline ${baseline.missingPredictions} + ${thresholds.maxMissingPredictionIncrease}`,
      message: "missingPredictions increased from baseline",
    });
  }

  if (thresholds.maxP95LatencyIncreaseMs !== undefined) {
    const candidateLatency = getLatency(candidate);
    const baselineLatency = getLatency(baseline);
    if (candidateLatency.p95 === null || baselineLatency.p95 === null) {
      warnings.push("baseline latency comparison skipped because one report has no p95 latency");
    } else {
      failIfAbove(
        failures,
        "latencyMs.p95",
        candidateLatency.p95,
        baselineLatency.p95 + thresholds.maxP95LatencyIncreaseMs,
      );
    }
  }
}

function getLatency(report: EvalReport): { count: number; p95: number | null } {
  return {
    count: report.latencyMs?.count ?? 0,
    p95: report.latencyMs?.p95 ?? null,
  };
}

function failIfBelow(
  failures: PromotionGateFailure[],
  metric: AccuracyMetric | "total",
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
  failures: PromotionGateFailure[],
  metric: "hallucinatedToolRate" | "missingPredictions" | "latencyMs.p95",
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
