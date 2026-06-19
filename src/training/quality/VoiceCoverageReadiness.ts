import { readFile } from "node:fs/promises";
import type { VoiceEvalCase } from "../eval/VoiceEvalSuite";

export type VoiceCoverageReadinessStatus = "pass" | "fail";

export interface VoiceCoverageReadinessOptions {
  suitePath?: string;
  minTotalCases?: number;
}

export interface VoiceCoverageScenario {
  id: string;
  description: string;
  minCases: number;
  count: number;
  sampleIds: string[];
}

export interface VoiceCoverageReadinessReport {
  status: VoiceCoverageReadinessStatus;
  generatedAt: string;
  suitePath: string;
  summary: {
    total: number;
    byKind: Record<string, number>;
    targets: Record<string, number>;
    voiceResponses: number;
    noResponses: number;
    rawAudioRetainedCases: number;
    trainingQueuedCases: number;
    multiSpeakerCases: number;
    timingGuardCases: number;
  };
  checks: Array<{
    id: string;
    status: VoiceCoverageReadinessStatus;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  scenarios: VoiceCoverageScenario[];
}

type ScenarioMatcher = (item: VoiceEvalCase) => boolean;

interface ScenarioDefinition {
  id: string;
  description: string;
  minCases: number;
  match: ScenarioMatcher;
}

const DEFAULTS = {
  suitePath: "training/evals/voice.eval.jsonl",
  minTotalCases: 12,
};

const REQUIRED_SCENARIOS: ScenarioDefinition[] = [
  {
    id: "transcription-quality",
    description: "Voice suite covers STT transcript quality for spoken commands and architecture terms",
    minCases: 2,
    match: (item) =>
      item.kind === "transcription_quality" &&
      item.expected.shouldRespond &&
      item.expected.responseMode === "voice" &&
      hasTarget(item, ["command_transcript_without_text_message", "subq_term_preservation"]),
  },
  {
    id: "subq-term-preservation",
    description: "Voice transcription preserves SubQ/sparse-attention terminology",
    minCases: 1,
    match: (item) => item.kind === "transcription_quality" && hasTarget(item, ["subq_term_preservation"]),
  },
  {
    id: "speaker-attribution",
    description: "Voice suite covers speaker identity from receive events and attribution under crosstalk",
    minCases: 2,
    match: (item) =>
      item.kind === "speaker_attribution" &&
      item.expected.shouldRespond &&
      hasTarget(item, ["speaker_id_from_receive_event", "speaker_attribution_with_crosstalk"]),
  },
  {
    id: "crosstalk-active-speaker",
    description: "Crosstalk cases attribute the completed utterance to the active speaker",
    minCases: 1,
    match: (item) =>
      item.kind === "speaker_attribution" &&
      item.input.utterances.length > 1 &&
      hasTarget(item, ["speaker_attribution_with_crosstalk"]),
  },
  {
    id: "turn-taking-no-response",
    description: "Voice turn-taking covers cancelled turns and stop-speaking interrupts without new TTS",
    minCases: 2,
    match: (item) =>
      item.kind === "turn_taking" &&
      item.expected.shouldRespond === false &&
      item.expected.responseMode === "none" &&
      hasTarget(item, ["do_not_reply_to_cancelled_voice_turn", "interrupt_without_new_tts"]),
  },
  {
    id: "latency-budgets",
    description: "Voice suite covers short-command and longer policy-question latency budgets",
    minCases: 2,
    match: (item) =>
      item.kind === "latency" &&
      item.expected.shouldRespond &&
      item.expected.responseMode === "voice" &&
      typeof item.expected.maxTranscriptionLatencyMs === "number" &&
      typeof item.expected.maxResponseLatencyMs === "number" &&
      hasTarget(item, ["low_latency_short_command", "latency_budget_for_policy_question"]),
  },
  {
    id: "social-timing",
    description: "Voice social timing covers empathetic pauses and quick celebration acknowledgements",
    minCases: 2,
    match: (item) =>
      item.kind === "social_timing" &&
      item.expected.responseMode === "voice" &&
      typeof item.expected.minDelayBeforeSpeakingMs === "number" &&
      item.expected.maxOverlapMs === 0 &&
      hasTarget(item, ["empathetic_pause_before_reply", "quick_positive_acknowledgement"]),
  },
  {
    id: "retention-policy",
    description: "Voice retention policy covers raw-audio deletion and training-review requirements",
    minCases: 2,
    match: (item) =>
      item.kind === "retention_policy" &&
      item.expected.retainRawAudio === false &&
      item.expected.queueForTraining === false &&
      hasTarget(item, ["raw_audio_never_retained_by_default", "training_requires_review_not_auto_queue"]),
  },
  {
    id: "raw-audio-never-retained",
    description: "Every voice eval case asserts raw audio is not retained by default",
    minCases: 12,
    match: (item) => item.expected.retainRawAudio === false,
  },
  {
    id: "training-review-not-auto-queue",
    description: "Every voice eval case asserts voice data is not automatically queued for training",
    minCases: 12,
    match: (item) => item.expected.queueForTraining === false,
  },
];

export async function checkVoiceCoverageReadiness(
  options: VoiceCoverageReadinessOptions = {},
): Promise<VoiceCoverageReadinessReport> {
  const config = { ...DEFAULTS, ...options };
  const cases = await readSuite(config.suitePath);
  const scenarios = REQUIRED_SCENARIOS.map((definition) => {
    const matches = cases.filter(definition.match);
    return {
      id: definition.id,
      description: definition.description,
      minCases: definition.minCases,
      count: matches.length,
      sampleIds: matches.slice(0, 5).map((item) => item.id),
    };
  });
  const rawAudioRetainedCases = cases.filter((item) => item.expected.retainRawAudio !== false);
  const trainingQueuedCases = cases.filter((item) => item.expected.queueForTraining !== false);
  const checks = [
    cases.length >= config.minTotalCases
      ? pass("voice-coverage-suite-volume", `Voice suite has ${cases.length} held-out cases`)
      : fail("voice-coverage-suite-volume", `Voice suite has only ${cases.length} held-out cases`, {
          minTotalCases: config.minTotalCases,
        }),
    rawAudioRetainedCases.length === 0
      ? pass("voice-coverage-raw-audio-policy", "Voice suite keeps raw audio transient by default")
      : fail("voice-coverage-raw-audio-policy", "Voice suite contains cases that retain raw audio", {
          ids: rawAudioRetainedCases.map((item) => item.id),
        }),
    trainingQueuedCases.length === 0
      ? pass("voice-coverage-training-review-policy", "Voice suite requires review before training use")
      : fail("voice-coverage-training-review-policy", "Voice suite contains cases queued for training automatically", {
          ids: trainingQueuedCases.map((item) => item.id),
        }),
    ...scenarios.map((scenario) =>
      scenario.count >= scenario.minCases
        ? pass(`voice-coverage-scenario:${scenario.id}`, scenario.description, scenario)
        : fail(`voice-coverage-scenario:${scenario.id}`, `Missing coverage: ${scenario.description}`, scenario),
    ),
  ];

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    suitePath: config.suitePath,
    summary: {
      total: cases.length,
      byKind: countBy(cases.map((item) => item.kind)),
      targets: countBy(cases.map((item) => target(item)).filter((value) => value.length > 0)),
      voiceResponses: cases.filter((item) => item.expected.shouldRespond && item.expected.responseMode === "voice").length,
      noResponses: cases.filter((item) => item.expected.shouldRespond === false && item.expected.responseMode === "none").length,
      rawAudioRetainedCases: rawAudioRetainedCases.length,
      trainingQueuedCases: trainingQueuedCases.length,
      multiSpeakerCases: cases.filter((item) => item.input.utterances.length > 1).length,
      timingGuardCases: cases.filter(
        (item) => typeof item.expected.minDelayBeforeSpeakingMs === "number" || typeof item.expected.maxOverlapMs === "number",
      ).length,
    },
    checks,
    scenarios,
  };
}

async function readSuite(path: string): Promise<VoiceEvalCase[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as VoiceEvalCase);
}

function hasTarget(item: VoiceEvalCase, expected: string[]): boolean {
  return expected.includes(target(item));
}

function target(item: VoiceEvalCase): string {
  const value = item.metadata.target;
  return typeof value === "string" ? value : "";
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function pass(id: string, summary: string, details?: Record<string, unknown>) {
  return { id, status: "pass" as const, summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>) {
  return { id, status: "fail" as const, summary, ...(details ? { details } : {}) };
}
