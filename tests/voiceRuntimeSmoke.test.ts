import { describe, expect, it } from "vitest";
import type { VoiceReceiveAudioPreprocessInput } from "../src/discord/voice/VoiceReceiveBridge";
import { runVoiceRuntimeSmoke } from "../src/discord/voice/VoiceRuntimeSmoke";
import type { SttProvider, VoiceTranscriptionRequest } from "../src/discord/voice/VoiceSttTranscription";
import type { TtsAudio, TtsProvider } from "../src/discord/voice/VoiceTtsPlayback";

describe("runVoiceRuntimeSmoke", () => {
  it("checks TTS, preprocessing, and STT with preprocessed audio", async () => {
    const sttRequests: VoiceTranscriptionRequest[] = [];
    const tts: TtsProvider = {
      synthesize: async (job): Promise<TtsAudio> => {
        expect(job.text).toContain("smoke");
        return { data: Buffer.from("tts-audio"), contentType: "audio/ogg" };
      },
    };
    const preprocessor = {
      call: async (input: VoiceReceiveAudioPreprocessInput) => {
        expect(input.audio.toString("utf8")).toBe("raw-audio");
        return {
          shouldTranscribe: true as const,
          audio: Buffer.from("decoded-audio"),
          format: "pcm-s16le-48000-mono",
          durationMs: 900,
          metadata: { vad: { speechDetected: true } },
        };
      },
    };
    const stt: SttProvider = {
      transcribe: async (request) => {
        sttRequests.push(request);
        return { text: "voice smoke ok", confidence: 0.99 };
      },
    };

    const report = await runVoiceRuntimeSmoke({
      tts,
      preprocessor,
      stt,
      sampleAudio: Buffer.from("raw-audio"),
      receiveFormat: "discord-opus-packets",
    });

    expect(report.status).toBe("pass");
    expect(report.checks.map((check) => check.id)).toEqual([
      "voice-runtime-config",
      "voice-runtime-tts",
      "voice-runtime-preprocessor",
      "voice-runtime-stt",
    ]);
    expect(sttRequests[0]?.audio).toEqual(Buffer.from("decoded-audio"));
    expect(sttRequests[0]).toMatchObject({
      format: "pcm-s16le-48000-mono",
      metadata: {
        smoke: true,
        source: "preprocessor",
        preprocessor: { vad: { speechDetected: true } },
      },
    });
  });

  it("accepts a no-speech preprocessor decision as a valid preprocessor smoke", async () => {
    const report = await runVoiceRuntimeSmoke({
      preprocessor: {
        call: async () => ({ shouldTranscribe: false, reason: "vad-no-speech", metadata: { vad: false } }),
      },
    });

    expect(report.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "voice-runtime-preprocessor")).toMatchObject({
      status: "pass",
      summary: "Preprocessor returned no-speech decision: vad-no-speech",
    });
  });

  it("fails clearly when no voice runtime endpoint is configured", async () => {
    const report = await runVoiceRuntimeSmoke();

    expect(report.status).toBe("fail");
    expect(report.checks).toEqual([
      {
        id: "voice-runtime-config",
        status: "fail",
        summary: "No voice runtime endpoints are configured for smoke testing",
      },
    ]);
  });
});
