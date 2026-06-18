import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleCommand, type CommandServices } from "../src/discord/commands";
import type { BotMessageContext } from "../src/types/discord";
import { defineTool, toolOk } from "../src/tools/ToolDefinition";
import { ToolCooldownService } from "../src/tools/ToolCooldownService";
import { ToolExecutor } from "../src/tools/ToolExecutor";
import { ToolPermissionService } from "../src/tools/ToolPermissionService";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { testLogger, testToolContext } from "./helpers";

function ctx(content: string, disabledTools: string[] = []): BotMessageContext {
  return {
    guildId: "guild-1",
    guildName: "Guild One",
    channelId: "text-1",
    channelName: "general",
    userId: "user-1",
    username: "tester",
    displayName: "Tester",
    messageId: "message-1",
    content,
    isDM: false,
    mentionsBot: false,
    memberPermissions: ["ADMINISTRATOR"],
    guildSettings: { disabledTools },
  };
}

function services(): CommandServices {
  const registry = new ToolRegistry();
  registry.registerTool(
    defineTool({
      name: "ping",
      category: "utility",
      description: "Ping the bot",
      examples: ["ping"],
      riskLevel: "low",
      requiresConfirmation: false,
      argsSchema: z.object({}),
      execute: async () => toolOk({ pong: true }),
    }),
  );
  registry.registerTool(
    defineTool({
      name: "server_info",
      category: "utility",
      description: "Read server info",
      examples: ["server info"],
      riskLevel: "low",
      requiresConfirmation: false,
      argsSchema: z.object({}),
      execute: async () => toolOk({ server: true }),
    }),
  );
  const executor = new ToolExecutor({
    registry,
    permissions: new ToolPermissionService(),
    cooldowns: new ToolCooldownService(),
    logger: testLogger,
  });
  return {
    registry,
    executor,
    buildToolContext: (input) => testToolContext({ disabledTools: input.guildSettings?.disabledTools }),
    logger: testLogger,
  };
}

describe("tool policy commands", () => {
  it("hides guild-disabled tools from the tools command", async () => {
    const reply = await handleCommand(ctx("tools", ["ping"]), services());

    expect(reply).not.toContain("`ping`");
    expect(reply).toContain("`server_info`");
  });

  it("reports a specific disabled tool as unavailable", async () => {
    await expect(handleCommand(ctx("tool ping", ["ping"]), services())).resolves.toBe(
      "`ping` is disabled on this server.",
    );
  });

  it("denies command-triggered execution for guild-disabled tools", async () => {
    const reply = await handleCommand(ctx("ping", ["ping"]), services());

    expect(reply).toContain("ping failed");
    expect(reply).toContain("disabled in this server");
  });
});
