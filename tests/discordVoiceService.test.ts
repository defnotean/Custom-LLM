import { describe, expect, it } from "vitest";
import type { GuildSettings } from "../src/database/repositories/GuildRepository";
import { DiscordVoiceService } from "../src/discord/voice/DiscordVoiceService";
import { VoiceSessionRegistry } from "../src/discord/voice/VoiceSessionPolicy";
import { VoiceSpeechQueue, type VoiceSpeechJob } from "../src/discord/voice/VoiceSpeechQueue";
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
});
