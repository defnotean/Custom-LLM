import { z } from "zod";
import { ChannelType } from "discord.js";
import type { RegisteredTool } from "../ToolDefinition";
import { defineTool, toolFail, toolOk } from "../ToolDefinition";
import { nowIso, unixSeconds } from "../../utils/time";

/** utility — low-risk informational tools. */

const ping = defineTool({
  name: "ping",
  category: "utility",
  description: "Check whether the bot is alive and responsive. Returns pong with a timestamp.",
  examples: ["ping", "are you alive?", "check if the bot is up"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 2,
  argsSchema: z.object({}),
  execute: async () => toolOk({ pong: true, time: nowIso() }),
});

const serverInfo = defineTool({
  name: "server_info",
  category: "utility",
  description:
    "Get information about the current Discord server (guild): name, id, member count, channel count, creation date, boost level.",
  examples: ["what server is this?", "show server info", "how many members does this server have?"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 5,
  argsSchema: z.object({}),
  execute: async (_args, ctx) => {
    const guild = ctx.message?.guild;
    if (!guild) return toolFail("Not in a server — server_info only works inside a guild.");
    return toolOk({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
      channelCount: guild.channels.cache.size,
      roleCount: guild.roles.cache.size,
      createdAt: guild.createdAt.toISOString(),
      premiumTier: guild.premiumTier,
      ownerId: guild.ownerId,
    });
  },
});

const channelInfo = defineTool({
  name: "channel_info",
  category: "utility",
  description:
    "Get information about a Discord channel (current channel by default): name, id, type, topic, creation date.",
  examples: ["what channel is this?", "show channel info", "channel topic?"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 5,
  argsSchema: z.object({
    channelId: z.string().optional(),
  }),
  execute: async (args, ctx) => {
    const client = ctx.discordClient ?? ctx.message?.client;
    if (!client) return toolFail("Discord client unavailable in this context.");
    const id = args.channelId ?? ctx.channelId;
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel) return toolFail(`Channel ${id} not found or not accessible.`);
    const base = {
      id: channel.id,
      type: ChannelType[channel.type] ?? String(channel.type),
      createdAt: channel.createdAt ? channel.createdAt.toISOString() : null,
    };
    if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
      return toolOk({ ...base, name: channel.name, topic: channel.topic ?? null, nsfw: channel.nsfw });
    }
    if ("name" in channel && typeof channel.name === "string") {
      return toolOk({ ...base, name: channel.name });
    }
    return toolOk(base);
  },
});

const currentTime = defineTool({
  name: "current_time",
  category: "utility",
  description:
    "Get the current date and time. Optionally pass an IANA timezone like 'America/New_York' or 'Europe/Berlin'.",
  examples: ["what time is it?", "current time in Tokyo", "what's today's date"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 2,
  argsSchema: z.object({
    timezone: z.string().optional(),
  }),
  execute: async (args) => {
    const tz = args.timezone;
    try {
      const formatted = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        ...(tz ? { timeZone: tz } : {}),
      }).format(new Date());
      return toolOk({ iso: nowIso(), unix: unixSeconds(), formatted, timezone: tz ?? "UTC (server default)" });
    } catch {
      return toolFail(`Unknown timezone "${tz ?? ""}" — use an IANA name like "Europe/Berlin".`);
    }
  },
});

export const utilityTools: RegisteredTool[] = [ping, serverInfo, channelInfo, currentTime];
