import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVoiceEvalCases,
  buildVoiceOraclePredictions,
  evaluateVoicePredictions,
  writeVoiceEvalSuite,
  type VoiceEvalPrediction,
} from "../src/training/eval/VoiceEvalSuite";

describe("VoiceEvalSuite", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds a voice suite covering transcription, speakers, turn-taking, latency, timing, and retention", () => {
    const cases = buildVoiceEvalCases();

    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((item) => item.kind))).toEqual(
      new Set([
        "transcription_quality",
        "speaker_attribution",
        "turn_taking",
        "latency",
        "social_timing",
        "retention_policy",
      ]),
    );
    expect(cases.every((item) => item.expected.retainRawAudio === false)).toBe(true);
    expect(cases.every((item) => item.expected.queueForTraining === false)).toBe(true);
  });

  it("scores oracle predictions as a perfect voice report", async () => {
    const fixture = await writeSuiteAndPredictions(buildVoiceOraclePredictions(buildVoiceEvalCases()));

    const report = await evaluateVoicePredictions(fixture.suitePath, fixture.predictionsPath);

    expect(report).toMatchObject({
      total: 12,
      transcriptExactRate: 1,
      averageTranscriptTokenF1: 1,
      speakerAttributionAccuracy: 1,
      responseDecisionAccuracy: 1,
      latencyPassRate: 1,
      socialTimingPassRate: 1,
      retentionPolicyPassRate: 1,
      missingPredictions: 0,
      failures: [],
    });
    expect(report.transcriptionLatencyMs.count).toBe(12);
    expect(report.responseLatencyMs.count).toBeGreaterThan(0);
  });

  it("flags speaker, latency, timing, retention, and response decision failures", async () => {
    const cases = buildVoiceEvalCases();
    const predictions = buildVoiceOraclePredictions(cases);
    const broken: VoiceEvalPrediction[] = predictions.map((item) =>
      item.id === "voice:social:discouraged_pause"
        ? {
            ...item,
            speakerUserId: "wrong-speaker",
            responseQueued: false,
            responseMode: "none",
            transcriptionLatencyMs: 10_000,
            delayBeforeSpeakingMs: 0,
            overlapMs: 500,
            retainedRawAudio: true,
            queuedForTraining: true,
          }
        : item,
    );
    const fixture = await writeSuiteAndPredictions(broken);

    const report = await evaluateVoicePredictions(fixture.suitePath, fixture.predictionsPath);

    expect(report.speakerAttributionAccuracy).toBeLessThan(1);
    expect(report.responseDecisionAccuracy).toBeLessThan(1);
    expect(report.latencyPassRate).toBeLessThan(1);
    expect(report.socialTimingPassRate).toBeLessThan(1);
    expect(report.retentionPolicyPassRate).toBeLessThan(1);
    expect(report.failures.map((failure) => failure.reason)).toEqual(
      expect.arrayContaining([
        "speaker attribution mismatch",
        "response decision mismatch",
        "transcription latency exceeded 1800ms",
        "started speaking before 450ms pause",
        "voice retention policy mismatch",
      ]),
    );
  });

  async function writeSuiteAndPredictions(predictions: VoiceEvalPrediction[]): Promise<{
    suitePath: string;
    predictionsPath: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "voice-eval-"));
    await mkdir(dir, { recursive: true });
    const suitePath = join(dir, "voice.eval.jsonl");
    const predictionsPath = join(dir, "voice.predictions.jsonl");
    await writeVoiceEvalSuite(suitePath);
    await writeFile(predictionsPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    expect((await readFile(suitePath, "utf8")).trim().split(/\r?\n/)).toHaveLength(12);
    return { suitePath, predictionsPath };
  }
});
