import { describe, expect, it, vi } from "vitest";
import type { GuildSettings } from "../src/database/repositories/GuildRepository";
import { DiscordVoiceService } from "../src/discord/voice/DiscordVoiceService";
import { VoiceSessionRegistry } from "../src/discord/voice/VoiceSessionPolicy";
import { VoiceSpeechQueue, type VoiceSpeechJob } from "../src/discord/voice/VoiceSpeechQueue";
import type { VoiceTranscriptionRequest } from "../src/discord/voice/VoiceSttTranscription";
import type { BotMessageContext } from "../src/types/discord";

function makeCtx(overrides?: Partial<BotMessageContext>): BotMessageContext {
  return {
    guildId: "guild-1",
    guildName: "Guild One",
    channelId: "text-1",
    channelName: "general",
    userId: "user-1",
    username: "tester",
    displayName: "Tester",
    messageId: "message-1",
    content: "!ai voice",
    isDM: false,
    mentionsBot: false,
    memberPermissions: ["ADMINISTRATOR"],
    raw: {
      member: {
        voice: {
          channel: {
            id: "voice-1",
            guild: { voiceAdapterCreator: {} },
          },
        },
      },
    } as never,
    ...overrides,
  };
}

function makeSettingsStore(initial: GuildSettings = {}) {
  let settings = initial;
  return {
    store: {
      getSettings: async () => settings,
      updateSettings: async (_guildId: string, next: GuildSettings) => {
        settings = next;
      },
    },
    read: () => settings,
  };
}

describe("DiscordVoiceService", () => {
  it("enables only the caller's current voice channel and leaves listening off", async () => {
    const settings = makeSettingsStore();
    const service = new DiscordVoiceService({ settingsStore: settings.store });

    const result = await service.enableCurrentChannel(makeCtx());

    expect(result.ok).toBe(true);
    expect(settings.read().voice).toMatchObject({
      enabled: true,
      allowChannels: ["voice-1"],
      ttsEnabled: true,
      listenEnabled: false,
      transcriptionEnabled: false,
      retainTranscripts: false,
      allowTrainingUse: false,
    });
    expect(result.policy?.rawAudioRetention).toBe("transient");
  });

  it("requires a manager permission to change voice policy", async () => {
    const settings = makeSettingsStore();
    const service = new DiscordVoiceService({ settingsStore: settings.store });

    const result = await service.enableCurrentChannel(makeCtx({ memberPermissions: ["SEND_MESSAGES"] }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Only server managers");
    expect(settings.read()).toEqual({});
  });

  it("reports blocked policy until voice is explicitly enabled", async () => {
    const service = new DiscordVoiceService({ settingsStore: makeSettingsStore().store });

    const result = await service.describeCurrentPolicy(makeCtx());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("blocked (voice-disabled)");
    expect(result.message).toContain("rawAudio=transient");
  });

  it("rejects join before policy enablement without touching Discord voice", async () => {
    const service = new DiscordVoiceService({ settingsStore: makeSettingsStore().store });

    const result = await service.joinCurrentChannel(makeCtx());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("voice-disabled");
  });

  it("keeps speech unavailable until a TTS backend is configured", async () => {
    const registry = new VoiceSessionRegistry();
    registry.start({
      guildId: "guild-1",
      channelId: "voice-1",
      startedByUserId: "user-1",
      settings: { enabled: true, allowChannels: ["voice-1"] },
    });
    const service = new DiscordVoiceService({
      settingsStore: makeSettingsStore({ voice: { enabled: true, allowChannels: ["voice-1"] } }).store,
      registry,
    });

    const result = await service.say(makeCtx(), "hello voice");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("TTS playback is not configured");
  });

  it("queues speech only after voice policy allows speaking", async () => {
    const registry = new VoiceSessionRegistry();
    registry.start({
      guildId: "guild-1",
      channelId: "voice-1",
      startedByUserId: "user-1",
      settings: { enabled: true, allowChannels: ["voice-1"] },
    });
    const played: VoiceSpeechJob[] = [];
    const speechQueue = new VoiceSpeechQueue(
      {
        play: async (job) => {
          played.push(job);
        },
      },
      { cooldownMs: 0, makeId: () => "speech-1" },
    );
    const service = new DiscordVoiceService({
      settingsStore: makeSettingsStore({ voice: { enabled: true, allowChannels: ["voice-1"], ttsEnabled: true } }).store,
      registry,
      speechQueue,
    });

    const result = await service.say(makeCtx(), "green build");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Queued voice speech #speech-1");
    await Promise.resolve();
    expect(played).toMatchObject([{ text: "green build", guildId: "guild-1", channelId: "voice-1" }]);
  });

  it("stops queued speech through the speech queue", async () => {
    const stopped: string[] = [];
    const service = new DiscordVoiceService({
      speechQueue: new VoiceSpeechQueue({
        play: async () => undefined,
        stopGuild: (guildId) => {
          stopped.push(guildId);
        },
      }),
    });

    const result = await service.stopSpeaking(makeCtx());

    expect(result.ok).toBe(true);
    expect(stopped).toEqual(["guild-1"]);
  });

  it("requires an STT backend before enabling listening", async () => {
    const settings = makeSettingsStore({ voice: { enabled: true, allowChannels: ["voice-1"] } });
    const service = new DiscordVoiceService({ settingsStore: settings.store });

    const result = await service.configureListening(makeCtx(), true);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("VOICE_STT_ENDPOINT");
    expect(settings.read().voice?.listenEnabled).toBeUndefined();
    expect(settings.read().voice?.transcriptionEnabled).toBeUndefined();
  });

  it("enables listening and transcription without enabling transcript retention or training use", async () => {
    const settings = makeSettingsStore();
    const service = new DiscordVoiceService({
      settingsStore: settings.store,
      sttProvider: { transcribe: async () => ({ text: "hello voice" }) },
    });

    const result = await service.configureListening(makeCtx(), true);

    expect(result.ok).toBe(true);
    expect(settings.read().voice).toMatchObject({
      enabled: true,
      allowChannels: ["voice-1"],
      listenEnabled: true,
      transcriptionEnabled: true,
      retainTranscripts: false,
      allowTrainingUse: false,
      visibleIndicator: true,
    });
    expect(result.message).toContain("Raw audio remains transient");
  });

  it("detaches the receive bridge when listening is disabled", async () => {
    const settings = makeSettingsStore({
      voice: { enabled: true, allowChannels: ["voice-1"], listenEnabled: true, transcriptionEnabled: true },
    });
    const service = new DiscordVoiceService({
      settingsStore: settings.store,
      sttProvider: { transcribe: async () => ({ text: "ok" }) },
    });
    const receiveBridge = { attach: vi.fn(), detach: vi.fn() };
    service.setReceiveBridge(receiveBridge);

    const result = await service.configureListening(makeCtx(), false);

    expect(result.ok).toBe(true);
    expect(receiveBridge.detach).toHaveBeenCalledWith("guild-1");
    expect(settings.read().voice).toMatchObject({
      listenEnabled: false,
      transcriptionEnabled: false,
      retainSummaries: false,
    });
  });

  it("transcribes buffered audio only after policy allows transcription", async () => {
    const captured: VoiceTranscriptionRequest[] = [];
    const registry = new VoiceSessionRegistry();
    registry.start({
      guildId: "guild-1",
      channelId: "voice-1",
      startedByUserId: "user-1",
      settings: { enabled: true, allowChannels: ["voice-1"], listenEnabled: true, transcriptionEnabled: true },
    });
    const service = new DiscordVoiceService({
      settingsStore: makeSettingsStore({
        voice: { enabled: true, allowChannels: ["voice-1"], listenEnabled: true, transcriptionEnabled: true },
      }).store,
      registry,
      sttProvider: {
        transcribe: async (request) => {
          captured.push(request);
          return { text: "Irene heard the call", confidence: 0.9 };
        },
      },
    });

    const result = await service.transcribeBufferedAudio(makeCtx(), {
      audio: Buffer.from("voice"),
      format: "ogg-opus",
      speakerUserId: "speaker-1",
      durationMs: 800,
      metadata: { voiceReceive: { rawFormat: "discord-opus-packets", processedFormat: "ogg-opus" } },
    });

    expect(result.ok).toBe(true);
    expect(result.transcript?.text).toBe("Irene heard the call");
    expect(result.message).toContain("rawAudio=transient");
    expect(captured).toMatchObject([
      {
        guildId: "guild-1",
        channelId: "voice-1",
        speakerUserId: "speaker-1",
        requestedByUserId: "user-1",
        format: "ogg-opus",
        metadata: {
          voiceReceive: { rawFormat: "discord-opus-packets", processedFormat: "ogg-opus" },
          durationMs: 800,
          retention: { rawAudio: "transient", transcript: false, summary: false, trainingReviewQueue: false },
        },
      },
    ]);
  });

  it("reports voice listen status with backend and retention state", async () => {
    const service = new DiscordVoiceService({
      settingsStore: makeSettingsStore({
        voice: { enabled: true, allowChannels: ["voice-1"], listenEnabled: true, transcriptionEnabled: true },
      }).store,
      sttProvider: { transcribe: async () => ({ text: "ok" }) },
    });

    const result = await service.listenStatus(makeCtx());

    expect(result.ok).toBe(true);
    expect(result.message).toContain("transcription enabled");
    expect(result.message).toContain("STT backend: configured");
    expect(result.message).toContain("rawAudio=transient");
  });
});
