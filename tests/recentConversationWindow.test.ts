import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRecentConversationWindow,
  RedisRecentConversationWindow,
  makeRecentTurn,
  type RecentConversationTurn,
} from "../src/state/RecentConversationWindow";
import type { RedisRuntimeClient } from "../src/state/RedisRuntimeState";
import { buildRecentTranscript, recordHandledConversationTurn } from "../src/discord/utils/discordContext";

describe("RecentConversationWindow", () => {
  it("keeps a capped in-memory user/assistant transcript", async () => {
    const window = new InMemoryRecentConversationWindow({ maxTurns: 3 });

    await window.append("channel-1", [
      turn("old", "user", "Old", "this should be trimmed"),
      turn("user-1", "user", "Alex", "remember SubQ routing"),
      turn("assistant-1", "assistant", "Irene", "I will keep the sparse path."),
      turn("user-2", "user", "Blair", "also preserve tool-call context"),
    ]);

    expect(await window.read("channel-1", 10)).toHaveLength(3);
    expect(await window.transcript("channel-1", 8)).toBe(
      [
        "[Alex]: remember SubQ routing",
        "[you (the assistant)]: I will keep the sparse path.",
        "[Blair]: also preserve tool-call context",
      ].join("\n"),
    );
  });

  it("stores and restores the window through Redis-compatible state", async () => {
    const redis = new FakeRedis();
    const first = new RedisRecentConversationWindow(redis, { keyPrefix: "test", maxTurns: 4 });
    const second = new RedisRecentConversationWindow(redis, { keyPrefix: "test", maxTurns: 4 });

    await first.append("channel-1", [
      turn("user-1", "user", "Alex", "what did we decide?"),
      turn("assistant-1", "assistant", "Irene", "SubQ stays mandatory for long context."),
    ]);

    expect(redis.rawKeys()).toEqual(["test:recent-conversation:channel-1"]);
    expect(await second.transcript("channel-1", 4)).toContain(
      "[you (the assistant)]: SubQ stays mandatory for long context.",
    );
  });

  it("drops corrupt Redis window payloads instead of leaking bad context", async () => {
    const redis = new FakeRedis();
    await redis.set("test:recent-conversation:channel-1", "{not json");
    const window = new RedisRecentConversationWindow(redis, { keyPrefix: "test" });

    expect(await window.read("channel-1")).toEqual([]);
    expect(redis.rawKeys()).toEqual([]);
  });

  it("records handled Discord turns into the window", async () => {
    const window = new InMemoryRecentConversationWindow();
    await recordHandledConversationTurn(
      {
        guildId: "guild-1",
        guildName: "Guild",
        channelId: "channel-1",
        channelName: "general",
        userId: "user-1",
        username: "Alex",
        displayName: null,
        messageId: "message-1",
        content: "hello Irene",
        isDM: false,
        mentionsBot: false,
        memberPermissions: [],
      },
      "hi Alex",
      window,
    );

    expect(await window.transcript("channel-1", 4)).toBe(
      ["[Alex]: hello Irene", "[you (the assistant)]: hi Alex"].join("\n"),
    );
  });

  it("does not throw when recording to the runtime window fails", async () => {
    await expect(
      recordHandledConversationTurn(
        {
          guildId: "guild-1",
          guildName: "Guild",
          channelId: "channel-1",
          channelName: "general",
          userId: "user-1",
          username: "Alex",
          displayName: null,
          messageId: "message-1",
          content: "hello Irene",
          isDM: false,
          mentionsBot: false,
          memberPermissions: [],
        },
        "hi Alex",
        {
          append: async () => {
            throw new Error("Redis unavailable");
          },
          read: async () => [],
          transcript: async () => null,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("prefers the runtime window before fetching Discord channel history", async () => {
    const window = new InMemoryRecentConversationWindow();
    await window.append("channel-1", [turn("user-1", "user", "Alex", "window context wins")]);
    const fetch = vi.fn();
    const message = {
      id: "message-current",
      channelId: "channel-1",
      channel: {
        isTextBased: () => true,
        messages: { fetch },
      },
    };

    const transcript = await buildRecentTranscript(message as never, { user: { id: "bot-1" } } as never, { window });

    expect(transcript).toBe("[Alex]: window context wins");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function turn(
  id: string,
  role: RecentConversationTurn["role"],
  username: string,
  content: string,
): RecentConversationTurn {
  return makeRecentTurn({
    id,
    role,
    channelId: "channel-1",
    username,
    content,
    createdAt: new Date("2026-06-19T00:00:00.000Z"),
  });
}

class FakeRedis implements RedisRuntimeClient {
  private readonly strings = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, _options?: { PX?: number }): Promise<unknown> {
    this.strings.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async eval(_script: string, _options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    throw new Error("not needed");
  }

  rawKeys(): string[] {
    return [...this.strings.keys()].sort();
  }
}
