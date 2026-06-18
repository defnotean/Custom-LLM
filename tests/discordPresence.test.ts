import { ActivityType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildPresenceData } from "../src/discord/presence";

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
});
