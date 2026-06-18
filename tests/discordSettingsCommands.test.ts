import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleCommand, type CommandServices } from "../src/discord/commands";
import type { GuildSettings } from "../src/database/repositories/GuildRepository";
import type { BotMessageContext } from "../src/types/discord";
import { defineTool, toolOk } from "../src/tools/ToolDefinition";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { testLogger } from "./helpers";

function ctx(content: string, permissions: string[] = ["MANAGE_GUILD"]): BotMessageContext {
  return {
    guildId: "guild-1",
    guildName: "Guild One",
    channelId: "12345",
    channelName: "general",
    userId: "user-1",
    username: "tester",
    displayName: "Tester",
    messageId: "message-1",
    content,
    isDM: false,
    mentionsBot: false,
    memberPermissions: permissions,
  };
}

function makeServices(initial: GuildSettings = {}): { services: CommandServices; read: () => GuildSettings } {
  let settings = initial;
  const registry = new ToolRegistry();
  registry.registerTool(
    defineTool({
      name: "ping",
      category: "utility",
      description: "Ping the bot",
      riskLevel: "low",
      requiresConfirmation: false,
      argsSchema: z.object({}),
      execute: async () => toolOk({ pong: true }),
    }),
  );

  return {
    services: {
      registry,
      executor: null as never,
      buildToolContext: null as never,
      settingsStore: {
        getSettings: async () => settings,
        updateSettings: async (_guildId, next) => {
          settings = next;
        },
      },
      logger: testLogger,
    },
    read: () => settings,
  };
}

describe("settings commands", () => {
  it("shows current text and tool policy", async () => {
    const { services } = makeServices({ allowChannels: ["12345"], disabledTools: ["ping"] });

    const reply = await handleCommand(ctx("settings show"), services);

    expect(reply).toContain("Irene server settings");
    expect(reply).toContain("<#12345>");
    expect(reply).toContain("`ping`");
  });

  it("adds, removes, and clears text allowlist channels", async () => {
    const state = makeServices({ allowChannels: ["99999"] });

    await expect(handleCommand(ctx("settings allow-channel add current"), state.services)).resolves.toContain(
      "<#12345>",
    );
    expect(state.read().allowChannels).toEqual(["99999", "12345"]);

    await expect(handleCommand(ctx("settings allow-channel remove 99999"), state.services)).resolves.toContain(
      "<#99999>",
    );
    expect(state.read().allowChannels).toEqual(["12345"]);

    await expect(handleCommand(ctx("settings allow-channel clear"), state.services)).resolves.toContain("cleared");
    expect(state.read().allowChannels).toEqual([]);
  });

  it("disables and enables known tools", async () => {
    const state = makeServices();

    await expect(handleCommand(ctx("settings disable-tool ping"), state.services)).resolves.toContain("disabled");
    expect(state.read().disabledTools).toEqual(["ping"]);

    await expect(handleCommand(ctx("settings enable-tool ping"), state.services)).resolves.toContain("enabled");
    expect(state.read().disabledTools).toEqual([]);
  });

  it("requires a server manager and persistent settings store", async () => {
    await expect(handleCommand(ctx("settings show", []), makeServices().services)).resolves.toContain(
      "Only administrators",
    );

    const withoutStore = { ...makeServices().services, settingsStore: null };
    await expect(handleCommand(ctx("settings show"), withoutStore)).resolves.toContain("persistence is unavailable");
  });

  it("rejects unknown tool names", async () => {
    await expect(handleCommand(ctx("settings disable-tool made_up_tool"), makeServices().services)).resolves.toBe(
      "No tool named `made_up_tool`.",
    );
  });
});
