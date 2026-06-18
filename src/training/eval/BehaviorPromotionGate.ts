import type { BehaviorEvalReport } from "./BehaviorEvalSuite";

export interface BehaviorPromotionThresholds {
  minTotalCases: number;
  minValidJsonRate: number;
  minActionTypeAccuracy: number;
  minRequirementPassRate: number;
  minPersonaConsistencyRate: number;
  minSocialCueAccuracy: number;
  minCasualToneAccuracy: number;
  minToolAbstainAccuracy: number;
  minBoundaryAccuracy: number;
  maxMissingPredictions: number;
  maxP95LatencyMs?: number;
  maxScoreRegression: number;
  maxMissingPredictionIncrease: number;
}

export interface BehaviorPromotionGateOptions {
  candidate: BehaviorEvalReport;
  baseline?: BehaviorEvalReport;
  thresholds?: Partial<BehaviorPromotionThresholds>;
}

export interface BehaviorPromotionGateFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface BehaviorPromotionGateResult {
  status: "pass" | "fail";
  thresholds: BehaviorPromotionThresholds;
  candidate: BehaviorPromotionSummary;
  baseline?: BehaviorPromotionSummary;
  failures: BehaviorPromotionGateFailure[];
  warnings: string[];
}

export interface BehaviorPromotionSummary {
  suitePath: string;
  predictionsPath: string;
  total: number;
  validJsonRate: number;
  actionTypeAccuracy: number;
  requirementPassRate: number;
  personaConsistencyRate: number | null;
  socialCueAccuracy: number | null;
  casualToneAccuracy: number | null;
  toolAbstainAccuracy: number | null;
  boundaryAccuracy: number | null;
  missingPredictions: number;
  failures: number;
  latencyP95Ms: number | null;
}

export const DEFAULT_BEHAVIOR_PROMOTION_THRESHOLDS: BehaviorPromotionThresholds = {
  minTotalCases: 10,
  minValidJsonRate: 0.98,
  minActionTypeAccuracy: 0.95,
  minRequirementPassRate: 0.9,
  minPersonaConsistencyRate: 1,
  minSocialCueAccuracy: 0.9,
  minCasualToneAccuracy: 0.9,
  minToolAbstainAccuracy: 1,
  minBoundaryAccuracy: 1,
  maxMissingPredictions: 0,
  maxScoreRegression: 0.02,
  maxMissingPredictionIncrease: 0,
};

const SCORE_METRICS = [
  "validJsonRate",
  "actionTypeAccuracy",
  "requirementPassRate",
  "personaConsistencyRate",
  "socialCueAccuracy",
  "casualToneAccuracy",
  "toolAbstainAccuracy",
  "boundaryAccuracy",
] as const;

type ScoreMetric = (typeof SCORE_METRICS)[number];

export function applyBehaviorPromotionGate(
  options: BehaviorPromotionGateOptions,
): BehaviorPromotionGateResult {
  const thresholds = { ...DEFAULT_BEHAVIOR_PROMOTION_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures: BehaviorPromotionGateFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "validJsonRate", candidate.validJsonRate, thresholds.minValidJsonRate);
  failIfBelow(failures, "actionTypeAccuracy", candidate.actionTypeAccuracy, thresholds.minActionTypeAccuracy);
  failIfBelow(failures, "requirementPassRate", candidate.requirementPassRate, thresholds.minRequirementPassRate);
  failIfBelow(failures, "personaConsistencyRate", candidate.personaConsistencyRate, thresholds.minPersonaConsistencyRate);
  failIfBelow(failures, "socialCueAccuracy", candidate.socialCueAccuracy, thresholds.minSocialCueAccuracy);
  failIfBelow(failures, "casualToneAccuracy", candidate.casualToneAccuracy, thresholds.minCasualToneAccuracy);
  failIfBelow(failures, "toolAbstainAccuracy", candidate.toolAbstainAccuracy, thresholds.minToolAbstainAccuracy);
  failIfBelow(failures, "boundaryAccuracy", candidate.boundaryAccuracy, thresholds.minBoundaryAccuracy);
  failIfAbove(failures, "missingPredictions", candidate.missingPredictions, thresholds.maxMissingPredictions);

  if (thresholds.maxP95LatencyMs !== undefined) {
    failIfAbove(failures, "latencyMs.p95", candidate.latencyMs.p95, thresholds.maxP95LatencyMs);
  } else if (candidate.latencyMs.count === 0) {
    warnings.push("candidate report has no latency samples; latency promotion checks were skipped");
  }

  if (options.baseline) compareBaseline(candidate, options.baseline, thresholds, failures, warnings);

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    candidate: summarizeBehaviorReport(candidate),
    ...(options.baseline ? { baseline: summarizeBehaviorReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeBehaviorReport(report: BehaviorEvalReport): BehaviorPromotionSummary {
  return {
    suitePath: report.suitePath,
    predictionsPath: report.predictionsPath,
    total: report.total,
    validJsonRate: report.validJsonRate,
    actionTypeAccuracy: report.actionTypeAccuracy,
    requirementPassRate: report.requirementPassRate,
    personaConsistencyRate: report.personaConsistencyRate,
    socialCueAccuracy: report.socialCueAccuracy,
    casualToneAccuracy: report.casualToneAccuracy,
    toolAbstainAccuracy: report.toolAbstainAccuracy,
    boundaryAccuracy: report.boundaryAccuracy,
    missingPredictions: report.missingPredictions,
    failures: report.failures.length,
    latencyP95Ms: report.latencyMs.p95,
  };
}

function compareBaseline(
  candidate: BehaviorEvalReport,
  baseline: BehaviorEvalReport,
  thresholds: BehaviorPromotionThresholds,
  failures: BehaviorPromotionGateFailure[],
  warnings: string[],
): void {
  for (const metric of SCORE_METRICS) {
    const candidateValue = candidate[metric];
    const baselineValue = baseline[metric];
    if (candidateValue === null || baselineValue === null) continue;
    const minimum = Number((baselineValue - thresholds.maxScoreRegression).toFixed(6));
    if (candidateValue < minimum) {
      failures.push({
        metric,
        actual: candidateValue,
        expected: `>= baseline ${baselineValue} - ${thresholds.maxScoreRegression}`,
        message: `${metric} regressed from baseline`,
      });
    }
  }

  const missingCeiling = baseline.missingPredictions + thresholds.maxMissingPredictionIncrease;
  failIfAbove(failures, "missingPredictions", candidate.missingPredictions, missingCeiling);

  if (thresholds.maxP95LatencyMs !== undefined) return;
  if (candidate.latencyMs.p95 === null || baseline.latencyMs.p95 === null) {
    warnings.push("baseline latency comparison skipped because one report has no p95 latency");
  }
}

function failIfBelow(
  failures: BehaviorPromotionGateFailure[],
  metric: ScoreMetric | "total",
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
  failures: BehaviorPromotionGateFailure[],
  metric: "missingPredictions" | "latencyMs.p95",
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
