import { z } from "zod";
import type { RegisteredTool } from "../ToolDefinition";
import { defineTool, toolFail, toolOk } from "../ToolDefinition";
import { toErrorMessage } from "../../utils/errors";

/** discord — tools that interact with Discord beyond the current reply. */

const sendMessage = defineTool({
  name: "send_message",
  category: "discord",
  description:
    "Send a message to a channel (current channel by default). Use for announcements or posting to another channel the user names.",
  examples: ["post 'meeting at 5' in #general", "send a message to the announcements channel"],
  riskLevel: "medium",
  requiresConfirmation: false,
  requiredDiscordPermissions: ["SEND_MESSAGES"],
  cooldownSeconds: 5,
  argsSchema: z.object({
    content: z.string().min(1).max(1800),
    channelId: z.string().optional(),
  }),
  execute: async (args, ctx) => {
    const client = ctx.discordClient ?? ctx.message?.client;
    if (!client) return toolFail("Discord client unavailable in this context.");
    try {
      const channelId = args.channelId ?? ctx.channelId;
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        return toolFail(`Channel ${channelId} is not a sendable text channel.`);
      }
      const sent = await channel.send(args.content);
      return toolOk({ sent: true, messageId: sent.id, channelId });
    } catch (err) {
      return toolFail(`Send failed: ${toErrorMessage(err)}`);
    }
  },
});

const summarizeChannelRecentMessages = defineTool({
  name: "summarize_channel_recent_messages",
  category: "discord",
  description:
    "Fetch the recent messages of a channel and return a transcript for summarization. NOTE: currently returns the raw transcript (the agent's follow-up LLM turn produces the summary); a dedicated summarization pass is a documented TODO.",
  examples: ["summarize the last 20 messages", "what did I miss in this channel?", "catch me up"],
  riskLevel: "low",
  requiresConfirmation: false,
  requiredDiscordPermissions: ["READ_MESSAGE_HISTORY"],
  cooldownSeconds: 15,
  argsSchema: z.object({
    channelId: z.string().optional(),
    limit: z.number().int().min(5).max(50).default(20),
  }),
  execute: async (args, ctx) => {
    const client = ctx.discordClient ?? ctx.message?.client;
    if (!client) return toolFail("Discord client unavailable in this context.");
    try {
      const channelId = args.channelId ?? ctx.channelId;
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        return toolFail(`Channel ${channelId} is not a readable text channel.`);
      }
      const messages = await channel.messages.fetch({ limit: args.limit });
      const transcript = [...messages.values()]
        .reverse()
        .filter((m) => m.content.trim().length > 0)
        .map((m) => `[${m.author.username}]: ${m.content.slice(0, 300)}`)
        .join("\n");
      return toolOk({
        channelId,
        messageCount: messages.size,
        transcript: transcript.slice(0, 6000),
        note: "Raw transcript — summarize it for the user in your reply.",
      });
    } catch (err) {
      return toolFail(`Fetch failed: ${toErrorMessage(err)}`);
    }
  },
});

const getGuildStats = defineTool({
  name: "get_guild_stats",
  category: "discord",
  description:
    "Get basic statistics for the current server: members, channels, roles, emojis, boost count. NOTE: activity-based stats (messages/day, active users) are a documented TODO pending the analytics pipeline.",
  examples: ["server stats", "how active is this server?", "guild statistics"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 15,
  argsSchema: z.object({}),
  execute: async (_args, ctx) => {
    const guild = ctx.message?.guild;
    if (!guild) return toolFail("get_guild_stats only works inside a server.");
    return toolOk({
      name: guild.name,
      members: guild.memberCount,
      channels: guild.channels.cache.size,
      roles: guild.roles.cache.size,
      emojis: guild.emojis.cache.size,
      boosts: guild.premiumSubscriptionCount ?? 0,
      createdAt: guild.createdAt.toISOString(),
      note: "Activity metrics (messages/day, active users) not yet implemented.",
    });
  },
});

export const discordTools: RegisteredTool[] = [
  sendMessage,
  summarizeChannelRecentMessages,
  getGuildStats,
];
