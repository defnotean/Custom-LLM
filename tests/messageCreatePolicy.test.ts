import { ChannelType, type Client, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createMessageHandler } from "../src/discord/events/messageCreate";
import { testLogger } from "./helpers";

function makeMessage(content = "!ai ping"): {
  message: Message;
  reply: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  const sendTyping = vi.fn(async () => undefined);
  const client = { user: { id: "bot-1" } } as Client;
  const message = {
    id: "message-1",
    content,
    author: { bot: false, id: "user-1", username: "tester", displayName: "Tester" },
    channelId: "blocked-channel",
    guildId: "guild-1",
    guild: { name: "Guild One" },
    channel: {
      type: ChannelType.GuildText,
      name: "blocked",
      sendTyping,
      send: vi.fn(async () => undefined),
      isTextBased: () => true,
      messages: { fetch: vi.fn() },
    },
    client,
    member: {
      displayName: "Tester",
      permissions: { toArray: () => ["Administrator"] },
    },
    mentions: {
      users: { has: () => false },
      has: () => false,
    },
    reference: null,
    reply,
  } as unknown as Message;
  return { message, reply, sendTyping };
}

describe("messageCreate guild policy", () => {
  it("ignores guild messages outside the configured text allowlist before typing or replying", async () => {
    const { message, reply, sendTyping } = makeMessage();
    const agent = { handleDiscordMessage: vi.fn() };
    const handler = createMessageHandler({
      client: { user: { id: "bot-1" } } as Client,
      agent: agent as never,
      commandServices: null as never,
      commandPrefix: "!ai",
      settingsStore: {
        getSettings: async () => ({ allowChannels: ["allowed-channel"] }),
      },
      logger: testLogger,
    });

    await handler(message);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(agent.handleDiscordMessage).not.toHaveBeenCalled();
  });

  it("allows administrator settings commands through the text allowlist for recovery", async () => {
    const { message, reply, sendTyping } = makeMessage("!ai settings show");
    const settingsStore = {
      getSettings: async () => ({ allowChannels: ["allowed-channel"], disabledTools: ["ping"] }),
      updateSettings: async () => undefined,
    };
    const handler = createMessageHandler({
      client: { user: { id: "bot-1" } } as Client,
      agent: { handleDiscordMessage: vi.fn() } as never,
      commandServices: {
        registry: null as never,
        executor: null as never,
        buildToolContext: null as never,
        settingsStore,
        logger: testLogger,
      },
      commandPrefix: "!ai",
      settingsStore,
      logger: testLogger,
    });

    await handler(message);

    expect(sendTyping).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("Irene server settings"),
    });
  });
});
