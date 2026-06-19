import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInteractionHandler } from "../src/discord/events/interactionCreate";
import {
  AI_SLASH_COMMAND_NAME,
  AI_SLASH_INPUT_OPTION,
  buildDiscordSlashCommands,
  registerDiscordSlashCommands,
} from "../src/discord/slashCommands";
import { InMemoryRecentConversationWindow, makeRecentTurn } from "../src/state/RecentConversationWindow";
import { defineTool, toolOk } from "../src/tools/ToolDefinition";
import { ToolCooldownService } from "../src/tools/ToolCooldownService";
import { ToolExecutor } from "../src/tools/ToolExecutor";
import { ToolPermissionService } from "../src/tools/ToolPermissionService";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { testLogger, testToolContext } from "./helpers";

function makeInteraction(input: string, options?: { channelId?: string; permissions?: string[] }) {
  const deferred = { value: false };
  const replied = { value: false };
  const interaction = {
    id: "interaction-1",
    commandName: AI_SLASH_COMMAND_NAME,
    guildId: "guild-1",
    guild: { name: "Guild One" },
    channelId: options?.channelId ?? "channel-1",
    channel: { name: "general" },
    user: { id: "user-1", username: "tester" },
    member: { displayName: "Tester" },
    memberPermissions: { toArray: () => options?.permissions ?? ["Administrator"] },
    isChatInputCommand: () => true,
    inGuild: () => true,
    options: {
      getString: (name: string) => {
        expect(name).toBe(AI_SLASH_INPUT_OPTION);
        return input;
      },
    },
    deferReply: vi.fn(async () => {
      deferred.value = true;
    }),
    editReply: vi.fn(async () => {
      replied.value = true;
    }),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      replied.value = true;
    }),
    get deferred() {
      return deferred.value;
    },
    get replied() {
      return replied.value;
    },
  };
  return interaction as unknown as ChatInputCommandInteraction & {
    deferReply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

function services() {
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
  const executor = new ToolExecutor({
    registry,
    permissions: new ToolPermissionService(),
    cooldowns: new ToolCooldownService(),
    logger: testLogger,
  });
  return {
    registry,
    executor,
    buildToolContext: () => testToolContext({ memberPermissions: ["ADMINISTRATOR"] }),
    logger: testLogger,
  };
}

describe("slash command registration", () => {
  it("defines the /ai input command", () => {
    const [command] = buildDiscordSlashCommands() as Array<{ name: string; options: Array<{ name: string }> }>;

    expect(command?.name).toBe(AI_SLASH_COMMAND_NAME);
    expect(command?.options.map((option) => option.name)).toContain(AI_SLASH_INPUT_OPTION);
  });

  it("registers commands against guild scope when DISCORD_GUILD_ID is provided", async () => {
    const put = vi.fn(async () => undefined);

    const result = await registerDiscordSlashCommands({
      token: "token",
      clientId: "client-1",
      guildId: "guild-1",
      rest: { put } as never,
    });

    expect(result).toMatchObject({ scope: "guild", commandCount: 1 });
    expect(put).toHaveBeenCalledWith(expect.stringContaining("guild-1"), expect.objectContaining({ body: expect.any(Array) }));
  });
});

describe("slash command interactions", () => {
  it("routes deterministic command input through handleCommand", async () => {
    const interaction = makeInteraction("ping");
    const handler = createInteractionHandler({
      agent: { handleDiscordMessage: vi.fn() } as never,
      commandServices: services(),
      logger: testLogger,
    });

    await handler(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("pong") }),
    );
  });

  it("routes non-command input through the agent", async () => {
    const interaction = makeInteraction("hello Irene");
    const agent = {
      handleDiscordMessage: vi.fn(async (ctx) => ({
        content: `agent saw ${ctx.content}`,
        trace: {},
      })),
    };
    const handler = createInteractionHandler({
      agent: agent as never,
      commandServices: services(),
      logger: testLogger,
    });

    await handler(interaction);

    expect(agent.handleDiscordMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "hello Irene" }), {
      transcript: null,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "agent saw hello Irene" }));
  });

  it("passes slash-command recent context through the runtime conversation window", async () => {
    const interaction = makeInteraction("continue that thought");
    const recentConversationWindow = new InMemoryRecentConversationWindow();
    await recentConversationWindow.append("channel-1", [
      makeRecentTurn({
        id: "previous-user",
        role: "user",
        channelId: "channel-1",
        userId: "user-2",
        username: "Alex",
        content: "SubQ stays mandatory for long context.",
      }),
    ]);
    const agent = {
      handleDiscordMessage: vi.fn(async () => ({
        content: "agent used recent context",
        trace: {},
      })),
    };
    const handler = createInteractionHandler({
      agent: agent as never,
      commandServices: services(),
      recentConversationWindow,
      logger: testLogger,
    });

    await handler(interaction);

    expect(agent.handleDiscordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "continue that thought" }),
      { transcript: "[Alex]: SubQ stays mandatory for long context." },
    );
    expect(await recentConversationWindow.transcript("channel-1", 4)).toContain(
      "[you (the assistant)]: agent used recent context",
    );
  });

  it("blocks slash input outside the text allowlist before calling the agent", async () => {
    const interaction = makeInteraction("hello Irene", { channelId: "blocked-channel" });
    const agent = { handleDiscordMessage: vi.fn() };
    const handler = createInteractionHandler({
      agent: agent as never,
      commandServices: services(),
      settingsStore: { getSettings: async () => ({ allowChannels: ["allowed-channel"] }) },
      logger: testLogger,
    });

    await handler(interaction);

    expect(agent.handleDiscordMessage).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("not enabled") }),
    );
  });

  it("allows settings slash input through a blocked channel for admin recovery", async () => {
    const interaction = makeInteraction("settings show", { channelId: "blocked-channel" });
    const settingsStore = {
      getSettings: async () => ({ allowChannels: ["allowed-channel"] }),
      updateSettings: async () => undefined,
    };
    const handler = createInteractionHandler({
      agent: { handleDiscordMessage: vi.fn() } as never,
      commandServices: { ...services(), settingsStore },
      settingsStore,
      logger: testLogger,
    });

    await handler(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Irene server settings") }),
    );
  });
});
