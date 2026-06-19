import { describe, expect, it, vi } from "vitest";
import {
  HttpVoiceReceivePreprocessor,
  normalizePreprocessResult,
} from "../src/discord/voice/VoiceReceivePreprocessor";
import type { VoiceReceiveAudioPreprocessInput } from "../src/discord/voice/VoiceReceiveBridge";

const input: VoiceReceiveAudioPreprocessInput = {
  guildId: "guild-1",
  channelId: "voice-1",
  speakerUserId: "speaker-1",
  audio: Buffer.from("opus-packets"),
  format: "discord-opus-packets",
  startedAt: new Date("2026-06-19T12:00:00.000Z"),
  finishedAt: new Date("2026-06-19T12:00:01.250Z"),
  durationMs: 1_250,
};

describe("HttpVoiceReceivePreprocessor", () => {
  it("posts transient receive audio and returns decoded speech for STT", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        audioBase64: Buffer.from("opus-packets").toString("base64"),
        format: "discord-opus-packets",
        guildId: "guild-1",
        channelId: "voice-1",
        speakerUserId: "speaker-1",
        durationMs: 1_250,
      });
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
      return jsonResponse({
        shouldTranscribe: true,
        audioBase64: Buffer.from("pcm-speech").toString("base64"),
        format: "pcm-s16le-48000-mono",
        durationMs: 1_100,
        metadata: { vad: { speechDetected: true, speechProbability: 0.97 }, decoder: "opus-vad-service" },
      });
    });
    const preprocessor = new HttpVoiceReceivePreprocessor({
      endpointUrl: "http://127.0.0.1:8080/voice/preprocess",
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await preprocessor.call(input);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/voice/preprocess",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toMatchObject({
      shouldTranscribe: true,
      audio: Buffer.from("pcm-speech"),
      format: "pcm-s16le-48000-mono",
      durationMs: 1_100,
      metadata: { vad: { speechDetected: true, speechProbability: 0.97 }, decoder: "opus-vad-service" },
    });
  });

  it("returns no-speech decisions without audio for the bridge to skip", () => {
    const result = normalizePreprocessResult(
      { shouldTranscribe: false, reason: "vad-no-speech", metadata: { vad: { speechDetected: false } } },
      input,
    );

    expect(result).toEqual({
      shouldTranscribe: false,
      reason: "vad-no-speech",
      metadata: { vad: { speechDetected: false } },
    });
  });

  it("falls back to original audio when the endpoint only adds metadata", () => {
    const result = normalizePreprocessResult(
      { shouldTranscribe: true, metadata: { vad: { speechDetected: true } } },
      input,
    );

    expect(result).toMatchObject({
      shouldTranscribe: true,
      audio: Buffer.from("opus-packets"),
      format: "discord-opus-packets",
      durationMs: 1_250,
      metadata: { vad: { speechDetected: true } },
    });
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (key: string) => (key.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}
