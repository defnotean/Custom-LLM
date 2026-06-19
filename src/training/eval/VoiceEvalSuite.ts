import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalLatencyStats } from "./ToolEvalSuite";

export type VoiceEvalCaseKind =
  | "transcription_quality"
  | "speaker_attribution"
  | "turn_taking"
  | "latency"
  | "social_timing"
  | "retention_policy";

export type VoiceResponseMode = "voice" | "text" | "none";

export interface VoiceEvalUtterance {
  speakerUserId: string;
  startsAtMs: number;
  endsAtMs: number;
  transcript: string;
}

export interface VoiceEvalCase {
  id: string;
  kind: VoiceEvalCaseKind;
  prompt: string;
  input: {
    guildId: string;
    channelId: string;
    speakers: Array<{ userId: string; displayName: string }>;
    utterances: VoiceEvalUtterance[];
    priorContext?: string[];
  };
  expected: {
    transcript: string;
    speakerUserId: string;
    shouldRespond: boolean;
    responseMode: VoiceResponseMode;
    maxTranscriptionLatencyMs?: number;
    maxResponseLatencyMs?: number;
    minDelayBeforeSpeakingMs?: number;
    maxOverlapMs?: number;
    retainRawAudio: false;
    queueForTraining: false;
  };
  metadata: Record<string, unknown>;
}

export interface VoiceEvalPrediction {
  id: string;
  transcript?: string;
  speakerUserId?: string;
  responseQueued?: boolean;
  responseMode?: VoiceResponseMode;
  transcriptionLatencyMs?: number;
  responseLatencyMs?: number;
  delayBeforeSpeakingMs?: number;
  overlapMs?: number;
  retainedRawAudio?: boolean;
  queuedForTraining?: boolean;
  model?: string;
}

export interface VoiceEvalSuiteSummary {
  path: string;
  cases: number;
  byKind: Record<string, number>;
  sha256: string;
}

export interface VoiceEvalMetrics {
  total: number;
  transcriptExactRate: number;
  averageTranscriptTokenF1: number;
  speakerAttributionAccuracy: number;
  responseDecisionAccuracy: number;
  latencyPassRate: number;
  socialTimingPassRate: number;
  retentionPolicyPassRate: number;
  missingPredictions: number;
  transcriptionLatencyMs: EvalLatencyStats;
  responseLatencyMs: EvalLatencyStats;
  byKind: Record<
    string,
    {
      total: number;
      transcriptExact: number;
      speakerCorrect: number;
      responseDecisionCorrect: number;
      latencyPassed: number;
      socialTimingPassed: number;
      retentionPassed: number;
    }
  >;
}

export interface VoiceEvalReport extends VoiceEvalMetrics {
  suitePath: string;
  predictionsPath: string;
  failures: Array<{ id: string; kind: VoiceEvalCaseKind; reason: string; prediction?: VoiceEvalPrediction }>;
}

const GUILD_ID = "guild-voice-eval";
const CHANNEL_ID = "voice-eval-channel";
const SPEAKERS = [
  { userId: "speaker-ava", displayName: "Ava" },
  { userId: "speaker-maya", displayName: "Maya" },
  { userId: "speaker-noah", displayName: "Noah" },
];

const CASES: VoiceEvalCase[] = [
  voiceCase({
    id: "voice:transcript:deployment_log",
    kind: "transcription_quality",
    speakerUserId: "speaker-ava",
    transcript: "Irene can you summarize the last deployment log",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 1800,
    maxResponseLatencyMs: 2600,
    metadata: { target: "command_transcript_without_text_message" },
  }),
  voiceCase({
    id: "voice:transcript:subq_gate",
    kind: "transcription_quality",
    speakerUserId: "speaker-maya",
    transcript: "remember the SubQ sparse attention gate before promoting this route",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 2000,
    maxResponseLatencyMs: 2800,
    metadata: { target: "subq_term_preservation" },
  }),
  voiceCase({
    id: "voice:speaker:single_user",
    kind: "speaker_attribution",
    speakerUserId: "speaker-noah",
    transcript: "that was me asking for the status check",
    shouldRespond: true,
    responseMode: "voice",
    metadata: { target: "speaker_id_from_receive_event" },
  }),
  {
    id: "voice:speaker:crosstalk_active_speaker",
    kind: "speaker_attribution",
    prompt: "Attribute the completed utterance to Maya, not the overlapping background speaker.",
    input: {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      speakers: SPEAKERS,
      utterances: [
        { speakerUserId: "speaker-ava", startsAtMs: 0, endsAtMs: 500, transcript: "wait no" },
        {
          speakerUserId: "speaker-maya",
          startsAtMs: 300,
          endsAtMs: 1800,
          transcript: "Irene answer after Ava finishes please",
        },
      ],
    },
    expected: {
      transcript: "Irene answer after Ava finishes please",
      speakerUserId: "speaker-maya",
      shouldRespond: true,
      responseMode: "voice",
      maxTranscriptionLatencyMs: 2200,
      maxResponseLatencyMs: 3200,
      minDelayBeforeSpeakingMs: 350,
      maxOverlapMs: 0,
      retainRawAudio: false,
      queueForTraining: false,
    },
    metadata: { target: "speaker_attribution_with_crosstalk" },
  },
  voiceCase({
    id: "voice:turn:no_response_filler",
    kind: "turn_taking",
    speakerUserId: "speaker-ava",
    transcript: "uh never mind I found it",
    shouldRespond: false,
    responseMode: "none",
    maxTranscriptionLatencyMs: 1800,
    metadata: { target: "do_not_reply_to_cancelled_voice_turn" },
  }),
  voiceCase({
    id: "voice:turn:stop_speaking",
    kind: "turn_taking",
    speakerUserId: "speaker-noah",
    transcript: "Irene stop talking for a second",
    shouldRespond: false,
    responseMode: "none",
    maxTranscriptionLatencyMs: 1200,
    metadata: { target: "interrupt_without_new_tts" },
  }),
  voiceCase({
    id: "voice:latency:quick_status",
    kind: "latency",
    speakerUserId: "speaker-maya",
    transcript: "quick status check",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 900,
    maxResponseLatencyMs: 1500,
    metadata: { target: "low_latency_short_command" },
  }),
  voiceCase({
    id: "voice:latency:long_question",
    kind: "latency",
    speakerUserId: "speaker-ava",
    transcript: "Irene explain why the voice receive bridge keeps raw audio transient",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 2400,
    maxResponseLatencyMs: 3800,
    metadata: { target: "latency_budget_for_policy_question" },
  }),
  voiceCase({
    id: "voice:social:discouraged_pause",
    kind: "social_timing",
    speakerUserId: "speaker-noah",
    transcript: "I am exhausted and I still broke the build",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 1800,
    maxResponseLatencyMs: 3400,
    minDelayBeforeSpeakingMs: 450,
    maxOverlapMs: 0,
    metadata: { target: "empathetic_pause_before_reply" },
  }),
  voiceCase({
    id: "voice:social:celebration_fast",
    kind: "social_timing",
    speakerUserId: "speaker-maya",
    transcript: "I finally got the tests passing",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 1200,
    maxResponseLatencyMs: 2200,
    minDelayBeforeSpeakingMs: 150,
    maxOverlapMs: 0,
    metadata: { target: "quick_positive_acknowledgement" },
  }),
  voiceCase({
    id: "voice:retention:raw_audio_transient",
    kind: "retention_policy",
    speakerUserId: "speaker-ava",
    transcript: "do not keep the raw audio from this call",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 1800,
    maxResponseLatencyMs: 2600,
    metadata: { target: "raw_audio_never_retained_by_default" },
  }),
  voiceCase({
    id: "voice:retention:training_review_required",
    kind: "retention_policy",
    speakerUserId: "speaker-noah",
    transcript: "can this call teach you something later",
    shouldRespond: true,
    responseMode: "voice",
    maxTranscriptionLatencyMs: 1800,
    maxResponseLatencyMs: 2600,
    metadata: { target: "training_requires_review_not_auto_queue" },
  }),
];

export function buildVoiceEvalCases(): VoiceEvalCase[] {
  return [...CASES].sort((a, b) => a.id.localeCompare(b.id));
}

export async function writeVoiceEvalSuite(path: string): Promise<VoiceEvalSuiteSummary> {
  const cases = buildVoiceEvalCases();
  await mkdir(dirname(path), { recursive: true });
  const body = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
  await writeFile(path, body, "utf8");
  return {
    path,
    cases: cases.length,
    byKind: countBy(cases.map((item) => item.kind)),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export function buildVoiceOraclePredictions(cases: VoiceEvalCase[]): VoiceEvalPrediction[] {
  return cases.map((item, index) => {
    const transcriptionLatencyMs = boundedLatency(item.expected.maxTranscriptionLatencyMs, 700 + index * 37);
    const responseLatencyMs = item.expected.shouldRespond
      ? boundedLatency(item.expected.maxResponseLatencyMs, 1_100 + index * 41)
      : undefined;
    return {
      id: item.id,
      transcript: item.expected.transcript,
      speakerUserId: item.expected.speakerUserId,
      responseQueued: item.expected.shouldRespond,
      responseMode: item.expected.responseMode,
      transcriptionLatencyMs,
      ...(responseLatencyMs !== undefined ? { responseLatencyMs } : {}),
      delayBeforeSpeakingMs: Math.max(item.expected.minDelayBeforeSpeakingMs ?? 0, item.expected.shouldRespond ? 300 : 0),
      overlapMs: 0,
      retainedRawAudio: false,
      queuedForTraining: false,
      model: "voice-oracle",
    };
  });
}

export async function evaluateVoicePredictions(suitePath: string, predictionsPath: string): Promise<VoiceEvalReport> {
  const cases = (await readJsonl(suitePath)) as VoiceEvalCase[];
  const predictions = (await readJsonl(predictionsPath)) as VoiceEvalPrediction[];
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const failures: VoiceEvalReport["failures"] = [];
  const byKind: VoiceEvalMetrics["byKind"] = {};
  const transcriptionLatencies: number[] = [];
  const responseLatencies: number[] = [];

  let exactTranscript = 0;
  let tokenF1Sum = 0;
  let speakerCorrect = 0;
  let responseDecisionCorrect = 0;
  let latencyPassed = 0;
  let socialTimingPassed = 0;
  let retentionPassed = 0;
  let missingPredictions = 0;

  for (const item of cases) {
    const kindMetrics =
      byKind[item.kind] ??
      (byKind[item.kind] = {
        total: 0,
        transcriptExact: 0,
        speakerCorrect: 0,
        responseDecisionCorrect: 0,
        latencyPassed: 0,
        socialTimingPassed: 0,
        retentionPassed: 0,
      });
    kindMetrics.total++;

    const prediction = byId.get(item.id);
    if (!prediction) {
      missingPredictions++;
      failures.push({ id: item.id, kind: item.kind, reason: "missing prediction" });
      continue;
    }

    const transcript = prediction.transcript ?? "";
    const transcriptExact = normalizeText(transcript) === normalizeText(item.expected.transcript);
    if (transcriptExact) {
      exactTranscript++;
      kindMetrics.transcriptExact++;
    } else {
      failures.push({ id: item.id, kind: item.kind, reason: "transcript mismatch", prediction });
    }
    tokenF1Sum += tokenF1(transcript, item.expected.transcript);

    if (prediction.speakerUserId === item.expected.speakerUserId) {
      speakerCorrect++;
      kindMetrics.speakerCorrect++;
    } else {
      failures.push({ id: item.id, kind: item.kind, reason: "speaker attribution mismatch", prediction });
    }

    const responseOk =
      prediction.responseQueued === item.expected.shouldRespond &&
      (item.expected.shouldRespond ? prediction.responseMode === item.expected.responseMode : prediction.responseMode === "none");
    if (responseOk) {
      responseDecisionCorrect++;
      kindMetrics.responseDecisionCorrect++;
    } else {
      failures.push({ id: item.id, kind: item.kind, reason: "response decision mismatch", prediction });
    }

    if (typeof prediction.transcriptionLatencyMs === "number") transcriptionLatencies.push(prediction.transcriptionLatencyMs);
    if (typeof prediction.responseLatencyMs === "number") responseLatencies.push(prediction.responseLatencyMs);
    const latencyOk = checkLatency(item, prediction);
    if (latencyOk.ok) {
      latencyPassed++;
      kindMetrics.latencyPassed++;
    } else {
      failures.push({ id: item.id, kind: item.kind, reason: latencyOk.reason, prediction });
    }

    const timingOk = checkSocialTiming(item, prediction);
    if (timingOk.ok) {
      socialTimingPassed++;
      kindMetrics.socialTimingPassed++;
    } else {
      failures.push({ id: item.id, kind: item.kind, reason: timingOk.reason, prediction });
    }

    const retentionOk = prediction.retainedRawAudio === false && prediction.queuedForTraining === false;
    if (retentionOk) {
      retentionPassed++;
      kindMetrics.retentionPassed++;
    } else {
      failures.push({ id: item.id, kind: item.kind, reason: "voice retention policy mismatch", prediction });
    }
  }

  return {
    suitePath,
    predictionsPath,
    total: cases.length,
    transcriptExactRate: ratio(exactTranscript, cases.length),
    averageTranscriptTokenF1: cases.length === 0 ? 0 : Number((tokenF1Sum / cases.length).toFixed(6)),
    speakerAttributionAccuracy: ratio(speakerCorrect, cases.length),
    responseDecisionAccuracy: ratio(responseDecisionCorrect, cases.length),
    latencyPassRate: ratio(latencyPassed, cases.length),
    socialTimingPassRate: ratio(socialTimingPassed, cases.length),
    retentionPolicyPassRate: ratio(retentionPassed, cases.length),
    missingPredictions,
    transcriptionLatencyMs: latencyStats(transcriptionLatencies),
    responseLatencyMs: latencyStats(responseLatencies),
    byKind,
    failures: failures.slice(0, 100),
  };
}

function voiceCase(input: {
  id: string;
  kind: VoiceEvalCaseKind;
  speakerUserId: string;
  transcript: string;
  shouldRespond: boolean;
  responseMode: VoiceResponseMode;
  maxTranscriptionLatencyMs?: number;
  maxResponseLatencyMs?: number;
  minDelayBeforeSpeakingMs?: number;
  maxOverlapMs?: number;
  metadata: Record<string, unknown>;
}): VoiceEvalCase {
  return {
    id: input.id,
    kind: input.kind,
    prompt: input.transcript,
    input: {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      speakers: SPEAKERS,
      utterances: [
        {
          speakerUserId: input.speakerUserId,
          startsAtMs: 0,
          endsAtMs: 1_200,
          transcript: input.transcript,
        },
      ],
    },
    expected: {
      transcript: input.transcript,
      speakerUserId: input.speakerUserId,
      shouldRespond: input.shouldRespond,
      responseMode: input.responseMode,
      ...(input.maxTranscriptionLatencyMs !== undefined
        ? { maxTranscriptionLatencyMs: input.maxTranscriptionLatencyMs }
        : {}),
      ...(input.maxResponseLatencyMs !== undefined ? { maxResponseLatencyMs: input.maxResponseLatencyMs } : {}),
      ...(input.minDelayBeforeSpeakingMs !== undefined
        ? { minDelayBeforeSpeakingMs: input.minDelayBeforeSpeakingMs }
        : {}),
      ...(input.maxOverlapMs !== undefined ? { maxOverlapMs: input.maxOverlapMs } : {}),
      retainRawAudio: false,
      queueForTraining: false,
    },
    metadata: input.metadata,
  };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function checkLatency(
  item: VoiceEvalCase,
  prediction: VoiceEvalPrediction,
): { ok: true } | { ok: false; reason: string } {
  if (
    item.expected.maxTranscriptionLatencyMs !== undefined &&
    !latencyAtOrBelow(prediction.transcriptionLatencyMs, item.expected.maxTranscriptionLatencyMs)
  ) {
    return { ok: false, reason: `transcription latency exceeded ${item.expected.maxTranscriptionLatencyMs}ms` };
  }
  if (
    item.expected.shouldRespond &&
    item.expected.maxResponseLatencyMs !== undefined &&
    !latencyAtOrBelow(prediction.responseLatencyMs, item.expected.maxResponseLatencyMs)
  ) {
    return { ok: false, reason: `response latency exceeded ${item.expected.maxResponseLatencyMs}ms` };
  }
  return { ok: true };
}

function checkSocialTiming(
  item: VoiceEvalCase,
  prediction: VoiceEvalPrediction,
): { ok: true } | { ok: false; reason: string } {
  if (
    item.expected.minDelayBeforeSpeakingMs !== undefined &&
    !latencyAtOrAbove(prediction.delayBeforeSpeakingMs, item.expected.minDelayBeforeSpeakingMs)
  ) {
    return { ok: false, reason: `started speaking before ${item.expected.minDelayBeforeSpeakingMs}ms pause` };
  }
  if (item.expected.maxOverlapMs !== undefined && !latencyAtOrBelow(prediction.overlapMs, item.expected.maxOverlapMs)) {
    return { ok: false, reason: `overlapped speaker by more than ${item.expected.maxOverlapMs}ms` };
  }
  return { ok: true };
}

function latencyAtOrBelow(value: number | undefined, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function latencyAtOrAbove(value: number | undefined, minimum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function boundedLatency(maximum: number | undefined, preferred: number): number {
  if (maximum === undefined) return preferred;
  return Math.max(0, Math.min(preferred, maximum - 1));
}

function tokenF1(actual: string, expected: string): number {
  const actualTokens = tokenize(actual);
  const expectedTokens = tokenize(expected);
  if (expectedTokens.length === 0) return actualTokens.length === 0 ? 1 : 0;
  if (actualTokens.length === 0) return 0;
  const actualCounts = counts(actualTokens);
  let overlap = 0;
  for (const token of expectedTokens) {
    const remaining = actualCounts.get(token) ?? 0;
    if (remaining > 0) {
      overlap++;
      actualCounts.set(token, remaining - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / actualTokens.length;
  const recall = overlap / expectedTokens.length;
  return Number(((2 * precision * recall) / (precision + recall)).toFixed(6));
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter((token) => token.length > 0);
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function counts(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function latencyStats(values: number[]): EvalLatencyStats {
  if (values.length === 0) return { count: 0, average: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    average: Number((sum / sorted.length).toFixed(3)),
    p95: Number((sorted[p95Index] ?? 0).toFixed(3)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
