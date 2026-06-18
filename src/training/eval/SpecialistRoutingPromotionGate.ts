import type { SpecialistRoutingReport } from "./SpecialistRoutingEvalSuite";

export interface SpecialistRoutingPromotionThresholds {
  minTotalCases: number;
  minRouteAccuracy: number;
  minExpertAccuracy: number;
  minToolVsNonToolAccuracy: number;
  maxMissingPredictions: number;
  maxInvalidPredictions: number;
  maxP95LatencyMs?: number;
  maxRouteAccuracyRegression: number;
  maxExpertAccuracyRegression: number;
}

export interface SpecialistRoutingPromotionOptions {
  candidate: SpecialistRoutingReport;
  baseline?: SpecialistRoutingReport;
  thresholds?: Partial<SpecialistRoutingPromotionThresholds>;
}

export interface SpecialistRoutingPromotionFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface SpecialistRoutingPromotionResult {
  status: "pass" | "fail";
  thresholds: SpecialistRoutingPromotionThresholds;
  candidate: SpecialistRoutingReportSummary;
  baseline?: SpecialistRoutingReportSummary;
  failures: SpecialistRoutingPromotionFailure[];
  warnings: string[];
}

export interface SpecialistRoutingReportSummary {
  suitePath: string;
  predictionsPath: string;
  total: number;
  routeAccuracy: number;
  expertAccuracy: number;
  toolVsNonToolAccuracy: number;
  missingPredictions: number;
  invalidPredictions: number;
  failures: number;
  latencyP95Ms: number | null;
}

export const DEFAULT_SPECIALIST_ROUTING_THRESHOLDS: SpecialistRoutingPromotionThresholds = {
  minTotalCases: 18,
  minRouteAccuracy: 0.95,
  minExpertAccuracy: 0.95,
  minToolVsNonToolAccuracy: 1,
  maxMissingPredictions: 0,
  maxInvalidPredictions: 0,
  maxRouteAccuracyRegression: 0.02,
  maxExpertAccuracyRegression: 0.02,
};

export function applySpecialistRoutingPromotionGate(
  options: SpecialistRoutingPromotionOptions,
): SpecialistRoutingPromotionResult {
  const thresholds = { ...DEFAULT_SPECIALIST_ROUTING_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures: SpecialistRoutingPromotionFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "routeAccuracy", candidate.routeAccuracy, thresholds.minRouteAccuracy);
  failIfBelow(failures, "expertAccuracy", candidate.expertAccuracy, thresholds.minExpertAccuracy);
  failIfBelow(
    failures,
    "toolVsNonToolAccuracy",
    candidate.toolVsNonToolAccuracy,
    thresholds.minToolVsNonToolAccuracy,
  );
  failIfAbove(failures, "missingPredictions", candidate.missingPredictions, thresholds.maxMissingPredictions);
  failIfAbove(failures, "invalidPredictions", candidate.invalidPredictions, thresholds.maxInvalidPredictions);

  if (thresholds.maxP95LatencyMs !== undefined) {
    failIfAbove(failures, "latencyMs.p95", candidate.latencyMs.p95, thresholds.maxP95LatencyMs);
  } else if (candidate.latencyMs.count === 0) {
    warnings.push("candidate report has no latency samples; latency promotion checks were skipped");
  }

  if (options.baseline) compareBaseline(candidate, options.baseline, thresholds, failures);

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    candidate: summarizeSpecialistRoutingReport(candidate),
    ...(options.baseline ? { baseline: summarizeSpecialistRoutingReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeSpecialistRoutingReport(report: SpecialistRoutingReport): SpecialistRoutingReportSummary {
  return {
    suitePath: report.suitePath,
    predictionsPath: report.predictionsPath,
    total: report.total,
    routeAccuracy: report.routeAccuracy,
    expertAccuracy: report.expertAccuracy,
    toolVsNonToolAccuracy: report.toolVsNonToolAccuracy,
    missingPredictions: report.missingPredictions,
    invalidPredictions: report.invalidPredictions,
    failures: report.failures.length,
    latencyP95Ms: report.latencyMs.p95,
  };
}

function compareBaseline(
  candidate: SpecialistRoutingReport,
  baseline: SpecialistRoutingReport,
  thresholds: SpecialistRoutingPromotionThresholds,
  failures: SpecialistRoutingPromotionFailure[],
): void {
  const minRouteAccuracy = Number((baseline.routeAccuracy - thresholds.maxRouteAccuracyRegression).toFixed(6));
  if (candidate.routeAccuracy < minRouteAccuracy) {
    failures.push({
      metric: "routeAccuracy",
      actual: candidate.routeAccuracy,
      expected: `>= baseline ${baseline.routeAccuracy} - ${thresholds.maxRouteAccuracyRegression}`,
      message: "routeAccuracy regressed from baseline",
    });
  }

  const minExpertAccuracy = Number((baseline.expertAccuracy - thresholds.maxExpertAccuracyRegression).toFixed(6));
  if (candidate.expertAccuracy < minExpertAccuracy) {
    failures.push({
      metric: "expertAccuracy",
      actual: candidate.expertAccuracy,
      expected: `>= baseline ${baseline.expertAccuracy} - ${thresholds.maxExpertAccuracyRegression}`,
      message: "expertAccuracy regressed from baseline",
    });
  }
}

function failIfBelow(
  failures: SpecialistRoutingPromotionFailure[],
  metric: string,
  actual: number | null,
  expected: number,
): void {
  if (actual === null || actual < expected) {
    failures.push({ metric, actual, expected: `>= ${expected}`, message: `${metric} below threshold` });
  }
}

function failIfAbove(
  failures: SpecialistRoutingPromotionFailure[],
  metric: string,
  actual: number | null,
  expected: number,
): void {
  if (actual === null || actual > expected) {
    failures.push({ metric, actual, expected: `<= ${expected}`, message: `${metric} above threshold` });
  }
}
