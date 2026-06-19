import type { Logger } from "pino";
import type { VoiceReceiveAudioPreprocessInput, VoiceReceiveAudioPreprocessResult } from "./VoiceReceiveBridge";
import type { SttProvider } from "./VoiceSttTranscription";
import type { TtsProvider } from "./VoiceTtsPlayback";

export type VoiceRuntimeSmokeStatus = "pass" | "fail";

export interface VoiceRuntimeSmokeCheck {
  id: string;
  status: VoiceRuntimeSmokeStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface VoiceRuntimeSmokeReport {
  status: VoiceRuntimeSmokeStatus;
  generatedAt: string;
  checks: VoiceRuntimeSmokeCheck[];
  summary: {
    ttsConfigured: boolean;
    sttConfigured: boolean;
    preprocessorConfigured: boolean;
    sampleAudioBytes: number;
    receiveFormat: string;
  };
}

export interface VoiceRuntimeSmokeOptions {
  tts?: TtsProvider | null;
  stt?: SttProvider | null;
  preprocessor?: { call(input: VoiceReceiveAudioPreprocessInput): Promise<VoiceReceiveAudioPreprocessResult> } | null;
  sampleAudio?: Buffer;
  receiveFormat?: string;
  ttsText?: string;
  logger?: Logger;
  now?: () => Date;
}

const DEFAULT_RECEIVE_FORMAT = "discord-opus-packets";
const DEFAULT_SAMPLE_AUDIO = Buffer.from("irene voice runtime smoke audio", "utf8");
const DEFAULT_TTS_TEXT = "Irene voice runtime smoke test.";

export async function runVoiceRuntimeSmoke(options: VoiceRuntimeSmokeOptions = {}): Promise<VoiceRuntimeSmokeReport> {
  const checks: VoiceRuntimeSmokeCheck[] = [];
  const now = options.now ?? (() => new Date());
  const sampleAudio = options.sampleAudio ?? DEFAULT_SAMPLE_AUDIO;
  const receiveFormat = options.receiveFormat ?? DEFAULT_RECEIVE_FORMAT;
  const ttsConfigured = Boolean(options.tts);
  const sttConfigured = Boolean(options.stt);
  const preprocessorConfigured = Boolean(options.preprocessor);
  let preprocessedSpeech: { audio: Buffer; format: string; metadata?: Record<string, unknown> } | null = null;

  if (!ttsConfigured && !sttConfigured && !preprocessorConfigured) {
    checks.push(fail("voice-runtime-config", "No voice runtime endpoints are configured for smoke testing"));
  } else {
    checks.push(
      pass("voice-runtime-config", "Voice runtime smoke has at least one configured endpoint", {
        ttsConfigured,
        sttConfigured,
        preprocessorConfigured,
      }),
    );
  }

  if (options.tts) {
    await recordCheck(checks, "voice-runtime-tts", async () => {
      const audio = await options.tts!.synthesize({
        id: "voice-runtime-smoke",
        guildId: "voice-smoke-guild",
        channelId: "voice-smoke-channel",
        requestedByUserId: "voice-smoke-user",
        text: options.ttsText ?? DEFAULT_TTS_TEXT,
        createdAt: now().toISOString(),
      });
      if (audio.data.length === 0) throw new Error("TTS endpoint returned empty audio");
      return {
        summary: `TTS endpoint returned ${audio.data.length} bytes`,
        details: { bytes: audio.data.length, contentType: audio.contentType },
      };
    });
  }

  if (options.preprocessor) {
    await recordCheck(checks, "voice-runtime-preprocessor", async () => {
      const startedAt = now();
      const finishedAt = new Date(startedAt.getTime() + 1_000);
      const result = await options.preprocessor!.call({
        guildId: "voice-smoke-guild",
        channelId: "voice-smoke-channel",
        speakerUserId: "voice-smoke-speaker",
        audio: sampleAudio,
        format: receiveFormat,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });

      if (!result.shouldTranscribe) {
        return {
          summary: `Preprocessor returned no-speech decision: ${result.reason}`,
          details: { reason: result.reason, metadata: result.metadata ?? null },
        };
      }

      if (result.audio.length === 0) throw new Error("preprocessor returned empty speech audio");
      preprocessedSpeech = {
        audio: result.audio,
        format: result.format,
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
      return {
        summary: `Preprocessor returned ${result.audio.length} bytes for STT`,
        details: {
          bytes: result.audio.length,
          format: result.format,
          durationMs: result.durationMs ?? null,
          metadata: result.metadata ?? null,
        },
      };
    });
  }

  if (options.stt) {
    await recordCheck(checks, "voice-runtime-stt", async () => {
      const audio = preprocessedSpeech?.audio ?? sampleAudio;
      const format = preprocessedSpeech?.format ?? receiveFormat;
      const transcript = await options.stt!.transcribe({
        guildId: "voice-smoke-guild",
        channelId: "voice-smoke-channel",
        speakerUserId: "voice-smoke-speaker",
        requestedByUserId: "voice-smoke-user",
        audio,
        format,
        metadata: {
          smoke: true,
          receiveFormat,
          source: preprocessedSpeech ? "preprocessor" : "sample",
          ...(preprocessedSpeech?.metadata ? { preprocessor: preprocessedSpeech.metadata } : {}),
        },
      });
      const text = transcript.text.trim();
      if (!text) throw new Error("STT endpoint returned empty text");
      return {
        summary: `STT endpoint returned ${text.length} transcript characters`,
        details: {
          textLength: text.length,
          confidence: transcript.confidence ?? null,
          language: transcript.language ?? null,
          audioBytes: audio.length,
          format,
        },
      };
    });
  }

  options.logger?.info({ checks: checks.length }, "voice runtime smoke complete");
  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: now().toISOString(),
    checks,
    summary: {
      ttsConfigured,
      sttConfigured,
      preprocessorConfigured,
      sampleAudioBytes: sampleAudio.length,
      receiveFormat,
    },
  };
}

async function recordCheck(
  checks: VoiceRuntimeSmokeCheck[],
  id: string,
  run: () => Promise<{ summary: string; details?: Record<string, unknown> }>,
): Promise<void> {
  try {
    const result = await run();
    checks.push(pass(id, result.summary, result.details));
  } catch (err) {
    checks.push(fail(id, err instanceof Error ? err.message : String(err)));
  }
}

function pass(id: string, summary: string, details?: Record<string, unknown>): VoiceRuntimeSmokeCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): VoiceRuntimeSmokeCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}
