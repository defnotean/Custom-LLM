import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { EndBehaviorType, type AudioReceiveStreamOptions } from "@discordjs/voice";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceReceiveBridge,
  type VoiceReceiveBridgeConnection,
} from "../src/discord/voice/VoiceReceiveBridge";
import { resolveVoicePolicy, type VoiceSession } from "../src/discord/voice/VoiceSessionPolicy";

function makeSession(options: { canTranscribe?: boolean; canSpeak?: boolean } = {}): VoiceSession {
  const settings = {
    enabled: true,
    allowChannels: ["voice-1"],
    ttsEnabled: options.canSpeak ?? true,
    listenEnabled: options.canTranscribe ?? true,
    transcriptionEnabled: options.canTranscribe ?? true,
  };
  return {
    guildId: "guild-1",
    channelId: "voice-1",
    startedByUserId: "owner-1",
    startedAt: "2026-06-18T00:00:00.000Z",
    policy: resolveVoicePolicy({
      guildId: "guild-1",
      channelId: "voice-1",
      settings,
      requestedMode: "join",
    }),
  };
}

function makeConnection() {
  const speaking = new EventEmitter();
  const streams = new Map<string, PassThrough>();
  let lastOptions: Partial<AudioReceiveStreamOptions> | undefined;
  const subscribe = vi.fn((userId: string, options?: Partial<AudioReceiveStreamOptions>) => {
    const stream = new PassThrough();
    streams.set(userId, stream);
    lastOptions = options;
    return stream;
  });
  const connection = {
    receiver: {
      speaking,
      subscribe,
    },
  } as unknown as VoiceReceiveBridgeConnection;
  return {
    connection,
    speaking,
    streams,
    subscribe,
    getLastOptions: () => lastOptions,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("VoiceReceiveBridge", () => {
  it("buffers Discord receive audio, transcribes it, routes the transcript, and queues a voice reply", async () => {
    const fake = makeConnection();
    const transcribeBufferedAudio = vi.fn(async () => ({
      ok: true,
      message: "transcribed",
      transcript: { text: "hello Irene", confidence: 0.91 },
    }));
    const agent = {
      handleDiscordMessage: vi.fn(async (ctx) => ({
        content: `heard: ${ctx.content}`,
        trace: {} as never,
      })),
    };
    const speechQueue = {
      enqueue: vi.fn(() => ({
        ok: true as const,
        job: {
          id: "speech-1",
          guildId: "guild-1",
          channelId: "voice-1",
          requestedByUserId: "speaker-1",
          text: "heard: hello Irene",
          createdAt: "2026-06-18T00:00:01.000Z",
        },
        position: 1,
      })),
    };
    let tick = 0;
    const bridge = new VoiceReceiveBridge({
      transcribeBufferedAudio,
      agent,
      speechQueue,
      getGuildSettings: async () => ({ voice: { enabled: true } }),
      receiveFormat: "discord-opus-packets",
      minAudioBytes: 1,
      now: () => new Date(1_000 + tick++ * 100),
    });

    bridge.attach({
      guildId: "guild-1",
      channelId: "voice-1",
      connection: fake.connection,
      session: makeSession(),
    });
    fake.speaking.emit("start", "speaker-1");
    fake.streams.get("speaker-1")?.end(Buffer.concat([Buffer.from("opus-a"), Buffer.from("opus-b")]));
    await vi.waitFor(() => expect(agent.handleDiscordMessage).toHaveBeenCalledTimes(1));

    expect(fake.subscribe).toHaveBeenCalledWith("speaker-1", {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
    });
    expect(fake.getLastOptions()?.end?.behavior).toBe(EndBehaviorType.AfterSilence);
    expect(transcribeBufferedAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "speaker-1",
        content: "",
      }),
      expect.objectContaining({
        audio: Buffer.from("opus-aopus-b"),
        format: "discord-opus-packets",
        speakerUserId: "speaker-1",
      }),
    );
    expect(agent.handleDiscordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "hello Irene",
        userId: "speaker-1",
        guildSettings: { voice: { enabled: true } },
      }),
      { transcript: "[voice:speaker-1] hello Irene" },
    );
    expect(speechQueue.enqueue).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "voice-1",
      requestedByUserId: "speaker-1",
      text: "heard: hello Irene",
    });
  });

  it("does not attach when the session policy does not allow transcription", () => {
    const fake = makeConnection();
    const bridge = new VoiceReceiveBridge({
      transcribeBufferedAudio: vi.fn(async () => ({ ok: false, message: "unused" })),
      agent: { handleDiscordMessage: vi.fn(async () => ({ content: "", trace: {} as never })) },
    });

    bridge.attach({
      guildId: "guild-1",
      channelId: "voice-1",
      connection: fake.connection,
      session: makeSession({ canTranscribe: false }),
    });
    fake.speaking.emit("start", "speaker-1");

    expect(bridge.isAttached("guild-1")).toBe(false);
    expect(fake.subscribe).not.toHaveBeenCalled();
  });

  it("skips tiny buffers and ignores the bot user's own audio", async () => {
    const fake = makeConnection();
    const transcribeBufferedAudio = vi.fn(async () => ({ ok: false, message: "unused" }));
    const bridge = new VoiceReceiveBridge({
      transcribeBufferedAudio,
      agent: { handleDiscordMessage: vi.fn(async () => ({ content: "", trace: {} as never })) },
      minAudioBytes: 8,
      client: { user: { id: "bot-1" } } as never,
    });

    bridge.attach({
      guildId: "guild-1",
      channelId: "voice-1",
      connection: fake.connection,
      session: makeSession(),
    });
    fake.speaking.emit("start", "bot-1");
    fake.speaking.emit("start", "speaker-1");
    fake.streams.get("speaker-1")?.end(Buffer.from("tiny"));
    await flushAsyncWork();

    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.subscribe).toHaveBeenCalledWith("speaker-1", expect.any(Object));
    expect(transcribeBufferedAudio).not.toHaveBeenCalled();
  });
});
