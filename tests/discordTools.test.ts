import type { PrismaClient } from "@prisma/client";
import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";
import { discordTools } from "../src/tools/categories/discordTools";
import type { ToolExecutionContext, ToolResultEnvelope } from "../src/tools/ToolDefinition";
import { testLogger } from "./helpers";

describe("discordTools", () => {
  it("adds Irene-observed activity metrics to guild stats when the database is available", async () => {
    const { tool, ctx } = makeStatsContext({
      db: {
        conversation: {
          count: async ({ where }: { where: unknown }) => {
            expect(where).toMatchObject({ guildId: "guild-1" });
            return 3;
          },
          findMany: async ({ where, take }: { where: unknown; take: number }) => {
            expect(where).toMatchObject({ guildId: "guild-1" });
            expect(take).toBe(5_000);
            return [
              { userId: "user-1", channelId: "channel-1", createdAt: new Date("2026-06-19T12:03:00.000Z") },
              { userId: "user-2", channelId: "channel-1", createdAt: new Date("2026-06-19T12:02:00.000Z") },
              { userId: "user-1", channelId: "channel-2", createdAt: new Date("2026-06-19T12:01:00.000Z") },
            ];
          },
        },
      } as unknown as PrismaClient,
    });

    const result = await executeTool(tool, {}, ctx);

    expect(result).toMatchObject({
      ok: true,
      data: {
        name: "Test Guild",
        members: 42,
        observedActivity: {
          available: true,
          source: "conversation_log",
          windowHours: 24,
          observedConversations: 3,
          observedConversationsPerDay: 3,
          activeUsers: 2,
          activeChannels: 2,
          sampledConversationRows: 3,
          lastObservedAt: "2026-06-19T12:03:00.000Z",
        },
      },
    });
  });

  it("reports guild activity as unavailable when persistence is disabled", async () => {
    const { tool, ctx } = makeStatsContext({ db: null });

    const result = await executeTool(tool, {}, ctx);

    expect(result).toMatchObject({
      ok: true,
      data: {
        observedActivity: {
          available: false,
          source: "conversation_log",
          reason: expect.stringContaining("database unavailable"),
        },
      },
    });
  });
});

function makeStatsContext(options: { db: PrismaClient | null }): {
  tool: (typeof discordTools)[number];
  ctx: ToolExecutionContext;
} {
  const tool = discordTools.find((item) => item.name === "get_guild_stats");
  if (!tool) throw new Error("get_guild_stats tool missing");

  const guild = {
    id: "guild-1",
    name: "Test Guild",
    memberCount: 42,
    channels: { cache: { size: 7 } },
    roles: { cache: { size: 5 } },
    emojis: { cache: { size: 3 } },
    premiumSubscriptionCount: 2,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
  };

  return {
    tool,
    ctx: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      memberPermissions: [],
      logger: testLogger,
      db: options.db,
      message: { guild } as unknown as Message,
    },
  };
}

async function executeTool(
  tool: (typeof discordTools)[number],
  args: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResultEnvelope> {
  const execute = tool.execute as (input: unknown, context: ToolExecutionContext) => Promise<ToolResultEnvelope>;
  return execute(args, ctx);
}
