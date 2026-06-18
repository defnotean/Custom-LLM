import { describe, expect, it } from "vitest";
import {
  filterGuildDisabledTools,
  isTextChannelAllowed,
  isToolDisabledByGuild,
  normalizeStringList,
} from "../src/guild/GuildPolicy";

describe("GuildPolicy", () => {
  it("allows DMs and guilds without a text allowlist", () => {
    expect(isTextChannelAllowed({ guildId: null, channelId: "dm-1", isDM: true })).toBe(true);
    expect(isTextChannelAllowed({ guildId: "guild-1", channelId: "general", isDM: false, settings: {} })).toBe(true);
  });

  it("rejects guild text channels outside the allowlist", () => {
    expect(
      isTextChannelAllowed({
        guildId: "guild-1",
        channelId: "off-topic",
        isDM: false,
        settings: { allowChannels: ["general"] },
      }),
    ).toBe(false);
  });

  it("normalizes string lists from loose JSON-like settings", () => {
    expect(normalizeStringList([" ping ", "", "ping", 42, "time"])).toEqual(["ping", "time"]);
  });

  it("matches disabled tool names case-insensitively", () => {
    expect(isToolDisabledByGuild("ping", ["PING"])).toBe(true);
    expect(isToolDisabledByGuild("server_info", ["ping"])).toBe(false);
  });

  it("filters disabled tools from candidate lists", () => {
    const tools = [{ name: "ping" }, { name: "server_info" }, { name: "remember_fact" }];
    expect(filterGuildDisabledTools(tools, ["server_info"])).toEqual([{ name: "ping" }, { name: "remember_fact" }]);
  });
});
