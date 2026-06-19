import { describe, expect, it, vi } from "vitest";
import {
  runDiscordVoiceSessionSmoke,
  type DiscordVoicePermissionName,
  type DiscordVoiceSessionConnector,
  type DiscordVoiceSessionSmokeChannel,
  type DiscordVoiceSessionSmokeClient,
} from "../src/discord/voice/DiscordVoiceSessionSmoke";

describe("runDiscordVoiceSessionSmoke", () => {
  it("passes preflight without joining when guild, channel, and permissions are valid", async () => {
    const client = makeClient();

    const report = await runDiscordVoiceSessionSmoke({
      token: "bot-token",
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      client,
    });

    expect(report.status).toBe("pass");
    expect(report.checks.map((check) => check.id)).toContain("discord-voice-join");
    expect(report.checks.find((check) => check.id === "discord-voice-join")).toMatchObject({
      status: "pass",
      summary: "Join execution skipped; preflight checks only",
    });
    expect(client.login).toHaveBeenCalledWith("bot-token");
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when required voice permissions are missing", async () => {
    const client = makeClient({
      channel: makeChannel({ permissions: ["ViewChannel", "Connect"] }),
    });

    const report = await runDiscordVoiceSessionSmoke({
      token: "bot-token",
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      client,
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "discord-voice-permissions")).toMatchObject({
      status: "fail",
      details: { missing: ["Speak", "UseVAD"] },
    });
  });

  it("executes join and leave when explicitly requested", async () => {
    const client = makeClient();
    const connector: DiscordVoiceSessionConnector = {
      join: vi.fn(async () => undefined),
    };

    const report = await runDiscordVoiceSessionSmoke({
      token: "bot-token",
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      client,
      connector,
      executeJoin: true,
      readyTimeoutMs: 250,
    });

    expect(report.status).toBe("pass");
    expect(connector.join).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "voice-1",
        readyTimeoutMs: 250,
      }),
    );
    expect(report.checks.find((check) => check.id === "discord-voice-join")).toMatchObject({
      status: "pass",
      summary: "Discord voice join/ready/leave smoke succeeded",
    });
  });

  it("does not join when preflight failed", async () => {
    const client = makeClient({
      channel: makeChannel({ joinable: false }),
    });
    const connector: DiscordVoiceSessionConnector = {
      join: vi.fn(async () => undefined),
    };

    const report = await runDiscordVoiceSessionSmoke({
      token: "bot-token",
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      client,
      connector,
      executeJoin: true,
    });

    expect(report.status).toBe("fail");
    expect(connector.join).not.toHaveBeenCalled();
    expect(report.checks.find((check) => check.id === "discord-voice-join")).toMatchObject({
      status: "fail",
      summary: "Join execution skipped because preflight checks failed",
    });
  });

  it("fails without attempting login when required config is missing", async () => {
    const client = makeClient();

    const report = await runDiscordVoiceSessionSmoke({
      token: "",
      guildId: "guild-1",
      voiceChannelId: "",
      client,
    });

    expect(report.status).toBe("fail");
    expect(client.login).not.toHaveBeenCalled();
    expect(report.checks).toEqual([
      {
        id: "discord-voice-session-config",
        status: "fail",
        summary: "Discord voice session smoke is missing required config",
        details: { missingConfig: ["DISCORD_TOKEN", "voiceChannelId"] },
      },
    ]);
  });
});

function makeClient(options: { channel?: DiscordVoiceSessionSmokeChannel | null } = {}): DiscordVoiceSessionSmokeClient {
  const channel = options.channel === undefined ? makeChannel() : options.channel;
  return {
    login: vi.fn(async () => undefined),
    destroy: vi.fn(() => undefined),
    getSelfUserId: vi.fn(() => "bot-1"),
    fetchGuild: vi.fn(async () => ({ id: "guild-1", name: "Guild One" })),
    fetchSelfMember: vi.fn(async () => ({ id: "bot-1", displayName: "Irene" })),
    fetchVoiceChannel: vi.fn(async () => channel),
  };
}

function makeChannel(
  options: {
    kind?: DiscordVoiceSessionSmokeChannel["kind"];
    permissions?: DiscordVoicePermissionName[];
    joinable?: boolean;
    speakable?: boolean;
    viewable?: boolean;
    full?: boolean;
  } = {},
): DiscordVoiceSessionSmokeChannel {
  const permissions = new Set(options.permissions ?? ["ViewChannel", "Connect", "Speak", "UseVAD"]);
  return {
    id: "voice-1",
    name: "General Voice",
    kind: options.kind ?? "voice",
    joinable: options.joinable ?? true,
    speakable: options.speakable ?? true,
    viewable: options.viewable ?? true,
    full: options.full ?? false,
    adapterCreator: {},
    permissionsFor: () => ({
      has: (permission) => permissions.has(permission),
    }),
  };
}
