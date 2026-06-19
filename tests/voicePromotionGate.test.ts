import { describe, expect, it } from "vitest";
import { applyVoicePromotionGate } from "../src/training/eval/VoicePromotionGate";
import type { VoiceEvalReport } from "../src/training/eval/VoiceEvalSuite";

function perfectReport(overrides: Partial<VoiceEvalReport> = {}): VoiceEvalReport {
  return {
    suitePath: "training/evals/voice.eval.jsonl",
    predictionsPath: "training/evals/voice-oracle.predictions.jsonl",
    total: 12,
    transcriptExactRate: 1,
    averageTranscriptTokenF1: 1,
    speakerAttributionAccuracy: 1,
    responseDecisionAccuracy: 1,
    latencyPassRate: 1,
    socialTimingPassRate: 1,
    retentionPolicyPassRate: 1,
    missingPredictions: 0,
    transcriptionLatencyMs: { count: 12, average: 900, p95: 1100, max: 1200 },
    responseLatencyMs: { count: 10, average: 1200, p95: 1500, max: 1600 },
    byKind: {},
    failures: [],
    ...overrides,
  };
}

describe("VoicePromotionGate", () => {
  it("passes a healthy voice report", () => {
    const result = applyVoicePromotionGate({ candidate: perfectReport() });

    expect(result.status).toBe("pass");
    expect(result.failures).toEqual([]);
    expect(result.candidate.total).toBe(12);
  });

  it("fails low speaker attribution, missing predictions, retained audio, and latency regression", () => {
    const result = applyVoicePromotionGate({
      candidate: perfectReport({
        speakerAttributionAccuracy: 0.9,
        retentionPolicyPassRate: 0.9,
        missingPredictions: 1,
        transcriptionLatencyMs: { count: 12, average: 3000, p95: 5000, max: 6000 },
        failures: [{ id: "voice:speaker", kind: "speaker_attribution", reason: "speaker mismatch" }],
      }),
      thresholds: { maxTranscriptionP95Ms: 2000 },
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining([
        "speakerAttributionAccuracy",
        "retentionPolicyPassRate",
        "missingPredictions",
        "failures",
        "transcriptionLatencyMs.p95",
      ]),
    );
  });

  it("blocks score regression against a baseline", () => {
    const result = applyVoicePromotionGate({
      candidate: perfectReport({ averageTranscriptTokenF1: 0.96 }),
      baseline: perfectReport({ averageTranscriptTokenF1: 1 }),
      thresholds: { maxScoreRegression: 0.01 },
    });

    expect(result.status).toBe("fail");
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        metric: "averageTranscriptTokenF1",
        message: "averageTranscriptTokenF1 regressed from baseline",
      }),
    );
  });
});
