import { describe, expect, it } from "vitest";
import type { GuildSettings } from "../src/database/repositories/GuildRepository";
import { DiscordVoiceService } from "../src/discord/voice/DiscordVoiceService";
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
});
