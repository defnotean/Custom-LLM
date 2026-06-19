import { ActivityType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildPresenceData,
  buildVoiceListeningPresenceData,
  VoiceListeningPresenceIndicator,
} from "../src/discord/presence";

describe("discord presence", () => {
  it("builds Irene's configured status and activity", () => {
    const presence = buildPresenceData({
      status: "online",
      activityType: "Listening",
      activityName: "for tool calls",
    });

    expect(presence.status).toBe("online");
    expect(presence.activities).toEqual([{ name: "for tool calls", type: ActivityType.Listening }]);
  });

  it("uses Discord custom status state when requested", () => {
    const presence = buildPresenceData({
      status: "idle",
      activityType: "Custom",
      activityName: "learning live skills",
    });

    expect(presence.activities).toEqual([
      { name: "Custom Status", state: "learning live skills", type: ActivityType.Custom },
    ]);
  });

  it("builds a visible opt-in voice listening activity", () => {
    const presence = buildVoiceListeningPresenceData(
      {
        status: "online",
        activityType: "Playing",
        activityName: "tool chess",
      },
      2,
    );

    expect(presence.status).toBe("online");
    expect(presence.activities).toEqual([{ name: "to opt-in voice in 2 servers", type: ActivityType.Listening }]);
  });

  it("tracks active listening sessions and restores the configured base presence", () => {
    const setPresence = vi.fn();
    const indicator = new VoiceListeningPresenceIndicator({
      client: { user: { setPresence } } as never,
      basePresence: {
        status: "idle",
        activityType: "Watching",
        activityName: "tool gates",
      },
    });

    const active = indicator.showListening({ guildId: "guild-1", channelId: "voice-1" });
    const restored = indicator.clearListening("guild-1");

    expect(active?.activities).toEqual([{ name: "to opt-in voice in 1 server", type: ActivityType.Listening }]);
    expect(restored?.activities).toEqual([{ name: "tool gates", type: ActivityType.Watching }]);
    expect(setPresence).toHaveBeenCalledTimes(2);
    expect(indicator.activeCount()).toBe(0);
  });
});
