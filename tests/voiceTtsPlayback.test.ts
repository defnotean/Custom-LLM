import { EventEmitter } from "events";
import { AudioPlayerStatus, StreamType, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import { describe, expect, it } from "vitest";
import {
  DiscordVoiceSpeechPlayer,
  HttpTtsProvider,
  type TtsProvider,
} from "../src/discord/voice/VoiceTtsPlayback";
import type { VoiceSpeechJob } from "../src/discord/voice/VoiceSpeechQueue";

const job: VoiceSpeechJob = {
  id: "speech-1",
  guildId: "guild-1",
  channelId: "voice-1",
  requestedByUserId: "user-1",
  text: "hello voice",
  createdAt: "2026-06-18T12:00:00.000Z",
};

function fakeFetch(
  handler: (url: string, init?: RequestInit) => {
    status: number;
    body: string | Buffer | Uint8Array | ArrayBuffer;
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

class FakePlayer extends EventEmitter {
  played: unknown = null;
  stoppedWithForce: boolean | undefined;

  play(resource: unknown): void {
    this.played = resource;
    queueMicrotask(() => this.emit(AudioPlayerStatus.Idle));
  }

  stop(force?: boolean): boolean {
    this.stoppedWithForce = force;
    return true;
  }
}

describe("HttpTtsProvider", () => {
  it("posts the speech job and returns binary audio", async () => {
    let captured: { url?: string; body?: Record<string, unknown>; auth?: string | null } = {};
    const provider = new HttpTtsProvider({
      endpointUrl: "http://tts.local/speak",
      apiKey: "secret",
      voice: "irene-fast",
      format: "ogg-opus",
      fetchImpl: fakeFetch((url, init) => {
        captured = {
          url,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          auth: new Headers(init?.headers).get("authorization"),
        };
        return { status: 200, body: new Uint8Array([1, 2, 3]), contentType: "audio/ogg" };
      }),
    });

    const audio = await provider.synthesize(job);

    expect(captured.url).toBe("http://tts.local/speak");
    expect(captured.auth).toBe("Bearer secret");
    expect(captured.body).toMatchObject({
      text: "hello voice",
      voice: "irene-fast",
      format: "ogg-opus",
      metadata: { jobId: "speech-1", guildId: "guild-1", channelId: "voice-1" },
    });
    expect([...audio.data]).toEqual([1, 2, 3]);
    expect(audio.contentType).toBe("audio/ogg");
  });

  it("accepts JSON audioBase64 responses", async () => {
    const provider = new HttpTtsProvider({
      endpointUrl: "http://tts.local/speak",
      fetchImpl: fakeFetch(() => ({
        status: 200,
        body: JSON.stringify({ audioBase64: Buffer.from("audio").toString("base64") }),
        contentType: "application/json",
      })),
    });

    const audio = await provider.synthesize(job);

    expect(audio.data.toString("utf8")).toBe("audio");
  });

  it("throws on TTS endpoint failure", async () => {
    const provider = new HttpTtsProvider({
      endpointUrl: "http://tts.local/speak",
      fetchImpl: fakeFetch(() => ({ status: 500, body: "down", contentType: "text/plain" })),
    });

    await expect(provider.synthesize(job)).rejects.toThrow(/HTTP 500/);
  });
});

describe("DiscordVoiceSpeechPlayer", () => {
  it("synthesizes audio and plays it through the active voice connection", async () => {
    const fakePlayer = new FakePlayer();
    let subscribedPlayer: unknown = null;
    let resourceOptions: { inputType?: StreamType; metadata?: VoiceSpeechJob } | null = null;
    const tts: TtsProvider = {
      synthesize: async () => ({ data: Buffer.from("audio"), contentType: "audio/ogg" }),
    };
    const player = new DiscordVoiceSpeechPlayer({
      tts,
      streamType: "ogg/opus",
      getConnection: () =>
        ({
          subscribe: (audioPlayer: unknown) => {
            subscribedPlayer = audioPlayer;
            return null;
          },
        }) as never,
      createPlayer: () => fakePlayer as unknown as AudioPlayer,
      createResource: (_input, options) => {
        resourceOptions = options;
        return { metadata: options.metadata } as AudioResource<VoiceSpeechJob>;
      },
    });

    await player.play(job);

    expect(subscribedPlayer).toBe(fakePlayer);
    expect(fakePlayer.played).toMatchObject({ metadata: job });
    expect(resourceOptions).toMatchObject({ inputType: StreamType.OggOpus, metadata: job });
  });

  it("stops the active guild player", async () => {
    const fakePlayer = new FakePlayer();
    const player = new DiscordVoiceSpeechPlayer({
      tts: { synthesize: async () => ({ data: Buffer.from("audio"), contentType: "audio/ogg" }) },
      getConnection: () => ({ subscribe: () => null }) as never,
      createPlayer: () => fakePlayer as unknown as AudioPlayer,
      createResource: (_input, options) => ({ metadata: options.metadata }) as AudioResource<VoiceSpeechJob>,
    });

    await player.play(job);
    player.stopGuild("guild-1");

    expect(fakePlayer.stoppedWithForce).toBe(true);
  });

  it("fails clearly without an active voice connection", async () => {
    const player = new DiscordVoiceSpeechPlayer({
      tts: { synthesize: async () => ({ data: Buffer.from("audio"), contentType: "audio/ogg" }) },
      getConnection: () => undefined,
    });

    await expect(player.play(job)).rejects.toThrow(/not connected/);
  });
});
