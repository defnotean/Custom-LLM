import type { PrismaClient } from "@prisma/client";
import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";
import { moderationTools } from "../src/tools/categories/moderationTools";
import type { ToolExecutionContext, ToolResultEnvelope } from "../src/tools/ToolDefinition";
import { testLogger } from "./helpers";

describe("moderationTools", () => {
  it("records warn_user in the moderation warning ledger before DM delivery", async () => {
    const writes: unknown[] = [];
    const updates: unknown[] = [];
    const sentMessages: string[] = [];
    const { tool, ctx } = makeWarnContext({
      db: {
        moderationWarning: {
          create: async (input: unknown) => {
            writes.push(input);
            return { id: "warning-1" };
          },
          update: async (input: unknown) => {
            updates.push(input);
            return { id: "warning-1" };
          },
        },
      } as unknown as PrismaClient,
      send: async (content: string) => {
        sentMessages.push(content);
      },
    });

    const result = await executeTool(tool, { userId: "target-123", reason: "posting invite spam" }, ctx);

    expect(result).toMatchObject({
      ok: true,
      data: {
        warningId: "warning-1",
        recorded: true,
        userId: "target-123",
        username: "TargetUser",
        reason: "posting invite spam",
        dmDelivered: true,
        note: "Warning recorded in the dedicated moderation warning ledger.",
      },
    });
    expect(writes).toEqual([
      {
        data: {
          guildId: "guild-1",
          channelId: "channel-1",
          moderatorUserId: "moderator-1",
          warnedUserId: "target-123",
          warnedUsername: "TargetUser",
          reason: "posting invite spam",
          moderatorMessageId: "message-1",
          metadataJson: { source: "warn_user_tool" },
        },
      },
    ]);
    expect(updates).toEqual([{ where: { id: "warning-1" }, data: { dmDelivered: true } }]);
    expect(sentMessages).toEqual(["You received a warning in **Test Guild**: posting invite spam"]);
  });

  it("refuses warn_user when persistence is unavailable", async () => {
    let fetchCalled = false;
    const { tool, ctx } = makeWarnContext({
      db: null,
      fetch: async () => {
        fetchCalled = true;
        throw new Error("should not fetch without persistence");
      },
    });

    const result = await executeTool(tool, { userId: "target-123", reason: "posting invite spam" }, ctx);

    expect(result).toEqual({
      ok: false,
      error: "warn_user requires database persistence so warnings stay recoverable.",
    });
    expect(fetchCalled).toBe(false);
  });

  it("keeps the warning recorded when the user cannot be DMed", async () => {
    const updates: unknown[] = [];
    const { tool, ctx } = makeWarnContext({
      db: {
        moderationWarning: {
          create: async () => ({ id: "warning-2" }),
          update: async (input: unknown) => {
            updates.push(input);
            return { id: "warning-2" };
          },
        },
      } as unknown as PrismaClient,
      send: async () => {
        throw new Error("DMs closed");
      },
    });

    const result = await executeTool(tool, { userId: "target-123", reason: "posting invite spam" }, ctx);

    expect(result).toMatchObject({
      ok: true,
      data: {
        warningId: "warning-2",
        recorded: true,
        dmDelivered: false,
      },
    });
    expect(updates).toEqual([]);
  });
});

function makeWarnContext(options: {
  db: PrismaClient | null;
  fetch?: (userId: string) => Promise<unknown>;
  send?: (content: string) => Promise<void>;
}): {
  tool: (typeof moderationTools)[number];
  ctx: ToolExecutionContext;
} {
  const tool = moderationTools.find((item) => item.name === "warn_user");
  if (!tool) throw new Error("warn_user tool missing");

  const member = {
    id: "target-123",
    user: {
      username: "TargetUser",
      bot: false,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
    displayName: "Target User",
    joinedAt: new Date("2021-01-01T00:00:00.000Z"),
    roles: { cache: new Map() },
    send: options.send ?? (async () => undefined),
  };

  const guild = {
    id: "guild-1",
    name: "Test Guild",
    members: {
      fetch: options.fetch ?? (async () => member),
    },
  };

  return {
    tool,
    ctx: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "moderator-1",
      memberPermissions: ["MODERATE_MEMBERS"],
      logger: testLogger,
      db: options.db,
      message: { id: "message-1", guild } as unknown as Message,
    },
  };
}

async function executeTool(
  tool: (typeof moderationTools)[number],
  args: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResultEnvelope> {
  const execute = tool.execute as (input: unknown, context: ToolExecutionContext) => Promise<ToolResultEnvelope>;
  return execute(args, ctx);
}
