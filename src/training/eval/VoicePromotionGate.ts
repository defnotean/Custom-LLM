import type { VoiceEvalReport } from "./VoiceEvalSuite";

export interface VoicePromotionThresholds {
  minTotalCases: number;
  minTranscriptExactRate: number;
  minAverageTranscriptTokenF1: number;
  minSpeakerAttributionAccuracy: number;
  minResponseDecisionAccuracy: number;
  minLatencyPassRate: number;
  minSocialTimingPassRate: number;
  minRetentionPolicyPassRate: number;
  maxMissingPredictions: number;
  maxFailures: number;
  maxTranscriptionP95Ms?: number;
  maxResponseP95Ms?: number;
  maxScoreRegression: number;
  maxMissingPredictionIncrease: number;
}

export interface VoicePromotionGateOptions {
  candidate: VoiceEvalReport;
  baseline?: VoiceEvalReport;
  thresholds?: Partial<VoicePromotionThresholds>;
}

export interface VoicePromotionGateFailure {
  metric: string;
  actual: number | null;
  expected: string;
  message: string;
}

export interface VoicePromotionSummary {
  suitePath: string;
  predictionsPath: string;
  total: number;
  transcriptExactRate: number;
  averageTranscriptTokenF1: number;
  speakerAttributionAccuracy: number;
  responseDecisionAccuracy: number;
  latencyPassRate: number;
  socialTimingPassRate: number;
  retentionPolicyPassRate: number;
  missingPredictions: number;
  failures: number;
  transcriptionP95Ms: number | null;
  responseP95Ms: number | null;
}

export interface VoicePromotionGateResult {
  status: "pass" | "fail";
  thresholds: VoicePromotionThresholds;
  candidate: VoicePromotionSummary;
  baseline?: VoicePromotionSummary;
  failures: VoicePromotionGateFailure[];
  warnings: string[];
}

export const DEFAULT_VOICE_PROMOTION_THRESHOLDS: VoicePromotionThresholds = {
  minTotalCases: 12,
  minTranscriptExactRate: 0.9,
  minAverageTranscriptTokenF1: 0.95,
  minSpeakerAttributionAccuracy: 1,
  minResponseDecisionAccuracy: 1,
  minLatencyPassRate: 1,
  minSocialTimingPassRate: 1,
  minRetentionPolicyPassRate: 1,
  maxMissingPredictions: 0,
  maxFailures: 0,
  maxScoreRegression: 0.02,
  maxMissingPredictionIncrease: 0,
};

const SCORE_METRICS = [
  "transcriptExactRate",
  "averageTranscriptTokenF1",
  "speakerAttributionAccuracy",
  "responseDecisionAccuracy",
  "latencyPassRate",
  "socialTimingPassRate",
  "retentionPolicyPassRate",
] as const;

type ScoreMetric = (typeof SCORE_METRICS)[number];

export function applyVoicePromotionGate(options: VoicePromotionGateOptions): VoicePromotionGateResult {
  const thresholds = { ...DEFAULT_VOICE_PROMOTION_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures: VoicePromotionGateFailure[] = [];
  const warnings: string[] = [];
  const candidate = options.candidate;

  failIfBelow(failures, "total", candidate.total, thresholds.minTotalCases);
  failIfBelow(failures, "transcriptExactRate", candidate.transcriptExactRate, thresholds.minTranscriptExactRate);
  failIfBelow(
    failures,
    "averageTranscriptTokenF1",
    candidate.averageTranscriptTokenF1,
    thresholds.minAverageTranscriptTokenF1,
  );
  failIfBelow(
    failures,
    "speakerAttributionAccuracy",
    candidate.speakerAttributionAccuracy,
    thresholds.minSpeakerAttributionAccuracy,
  );
  failIfBelow(
    failures,
    "responseDecisionAccuracy",
    candidate.responseDecisionAccuracy,
    thresholds.minResponseDecisionAccuracy,
  );
  failIfBelow(failures, "latencyPassRate", candidate.latencyPassRate, thresholds.minLatencyPassRate);
  failIfBelow(failures, "socialTimingPassRate", candidate.socialTimingPassRate, thresholds.minSocialTimingPassRate);
  failIfBelow(
    failures,
    "retentionPolicyPassRate",
    candidate.retentionPolicyPassRate,
    thresholds.minRetentionPolicyPassRate,
  );
  failIfAbove(failures, "missingPredictions", candidate.missingPredictions, thresholds.maxMissingPredictions);
  failIfAbove(failures, "failures", candidate.failures.length, thresholds.maxFailures);

  if (thresholds.maxTranscriptionP95Ms !== undefined) {
    failIfAbove(
      failures,
      "transcriptionLatencyMs.p95",
      candidate.transcriptionLatencyMs.p95,
      thresholds.maxTranscriptionP95Ms,
    );
  } else if (candidate.transcriptionLatencyMs.count === 0) {
    warnings.push("candidate report has no transcription latency samples; transcription p95 checks were skipped");
  }
  if (thresholds.maxResponseP95Ms !== undefined) {
    failIfAbove(failures, "responseLatencyMs.p95", candidate.responseLatencyMs.p95, thresholds.maxResponseP95Ms);
  } else if (candidate.responseLatencyMs.count === 0) {
    warnings.push("candidate report has no response latency samples; response p95 checks were skipped");
  }

  if (options.baseline) compareBaseline(candidate, options.baseline, thresholds, failures, warnings);

  return {
    status: failures.length === 0 ? "pass" : "fail",
    thresholds,
    candidate: summarizeVoiceReport(candidate),
    ...(options.baseline ? { baseline: summarizeVoiceReport(options.baseline) } : {}),
    failures,
    warnings,
  };
}

export function summarizeVoiceReport(report: VoiceEvalReport): VoicePromotionSummary {
  return {
    suitePath: report.suitePath,
    predictionsPath: report.predictionsPath,
    total: report.total,
    transcriptExactRate: report.transcriptExactRate,
    averageTranscriptTokenF1: report.averageTranscriptTokenF1,
    speakerAttributionAccuracy: report.speakerAttributionAccuracy,
    responseDecisionAccuracy: report.responseDecisionAccuracy,
    latencyPassRate: report.latencyPassRate,
    socialTimingPassRate: report.socialTimingPassRate,
    retentionPolicyPassRate: report.retentionPolicyPassRate,
    missingPredictions: report.missingPredictions,
    failures: report.failures.length,
    transcriptionP95Ms: report.transcriptionLatencyMs.p95,
    responseP95Ms: report.responseLatencyMs.p95,
  };
}

function compareBaseline(
  candidate: VoiceEvalReport,
  baseline: VoiceEvalReport,
  thresholds: VoicePromotionThresholds,
  failures: VoicePromotionGateFailure[],
  warnings: string[],
): void {
  for (const metric of SCORE_METRICS) {
    const candidateValue = candidate[metric];
    const baselineValue = baseline[metric];
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

  if (candidate.transcriptionLatencyMs.p95 === null || baseline.transcriptionLatencyMs.p95 === null) {
    warnings.push("baseline transcription latency comparison skipped because one report has no p95 latency");
  }
  if (candidate.responseLatencyMs.p95 === null || baseline.responseLatencyMs.p95 === null) {
    warnings.push("baseline response latency comparison skipped because one report has no p95 latency");
  }
}

function failIfBelow(
  failures: VoicePromotionGateFailure[],
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
  failures: VoicePromotionGateFailure[],
  metric:
    | "missingPredictions"
    | "failures"
    | "transcriptionLatencyMs.p95"
    | "responseLatencyMs.p95",
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
