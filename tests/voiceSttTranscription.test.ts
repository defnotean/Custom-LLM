import { describe, expect, it } from "vitest";
import { HttpSttProvider } from "../src/discord/voice/VoiceSttTranscription";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => {
    status: number;
    body: string;
    contentType: string;
  },
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const result = handler(String(input), init);
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  }) as typeof fetch;
}

describe("HttpSttProvider", () => {
  it("posts base64 audio and returns a normalized transcript", async () => {
    let captured: { url?: string; body?: Record<string, unknown>; auth?: string | null } = {};
    const provider = new HttpSttProvider({
      endpointUrl: "http://stt.local/transcribe",
      apiKey: "secret",
      model: "whisper-large",
      language: "en",
      fetchImpl: fakeFetch((url, init) => {
        captured = {
          url,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          auth: new Headers(init?.headers).get("authorization"),
        };
        return {
          status: 200,
          body: JSON.stringify({ text: "hello from voice", confidence: 0.91, language: "en", durationMs: 1200 }),
          contentType: "application/json",
        };
      }),
    });

    const transcript = await provider.transcribe({
      guildId: "guild-1",
      channelId: "voice-1",
      speakerUserId: "user-2",
      audio: Buffer.from("audio"),
      format: "ogg-opus",
      metadata: { retention: { rawAudio: "transient" } },
    });

    expect(captured.url).toBe("http://stt.local/transcribe");
    expect(captured.auth).toBe("Bearer secret");
    expect(captured.body).toMatchObject({
      audioBase64: Buffer.from("audio").toString("base64"),
      format: "ogg-opus",
      model: "whisper-large",
      language: "en",
      metadata: { guildId: "guild-1", channelId: "voice-1", speakerUserId: "user-2" },
    });
    expect(transcript).toMatchObject({ text: "hello from voice", confidence: 0.91, language: "en", durationMs: 1200 });
  });

  it("throws when the STT endpoint fails or returns no text", async () => {
    const failing = new HttpSttProvider({
      endpointUrl: "http://stt.local/transcribe",
      fetchImpl: fakeFetch(() => ({ status: 503, body: "down", contentType: "text/plain" })),
    });
    await expect(
      failing.transcribe({ guildId: "g", channelId: "c", audio: Buffer.from("audio"), format: "ogg-opus" }),
    ).rejects.toThrow(/HTTP 503/);

    const empty = new HttpSttProvider({
      endpointUrl: "http://stt.local/transcribe",
      fetchImpl: fakeFetch(() => ({ status: 200, body: JSON.stringify({ text: "" }), contentType: "application/json" })),
    });
    await expect(
      empty.transcribe({ guildId: "g", channelId: "c", audio: Buffer.from("audio"), format: "ogg-opus" }),
    ).rejects.toThrow(/empty transcript/);
  });
});
