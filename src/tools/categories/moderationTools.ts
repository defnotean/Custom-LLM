import { z } from "zod";
import type { RegisteredTool } from "../ToolDefinition";
import { defineTool, toolFail, toolOk } from "../ToolDefinition";
import { toErrorMessage } from "../../utils/errors";

/**
 * Moderation tools that act on members/messages. Member permission checks are
 * enforced by ToolPermissionService before execution; bot Discord permissions
 * are validated at call time. High-risk tools require executor confirmation.
 */

const timeoutUser = defineTool({
  name: "timeout_user",
  category: "moderation",
  description:
    "Temporarily timeout (mute) a Discord user in this server for a number of minutes, with a reason. The user cannot send messages until the timeout expires.",
  examples: [
    "timeout @user for 10 minutes for spamming",
    "mute that user for an hour",
    "give them a 30 minute timeout",
  ],
  riskLevel: "high",
  requiresConfirmation: true,
  requiredDiscordPermissions: ["MODERATE_MEMBERS"],
  cooldownSeconds: 10,
  argsSchema: z.object({
    userId: z.string().min(5).describe("Discord user id to timeout"),
    durationMinutes: z.number().int().min(1).max(40320),
    reason: z.string().max(400).default("No reason provided"),
  }),
  execute: async (args, ctx) => {
    const guild = ctx.message?.guild;
    if (!guild) return toolFail("timeout_user only works inside a server.");
    try {
      const member = await guild.members.fetch(args.userId);
      if (!member.moderatable) {
        return toolFail(`I can't timeout ${member.user.username} - their role is above mine or they're the owner.`);
      }
      await member.timeout(args.durationMinutes * 60_000, args.reason);
      return toolOk({
        userId: args.userId,
        username: member.user.username,
        durationMinutes: args.durationMinutes,
        reason: args.reason,
        until: new Date(Date.now() + args.durationMinutes * 60_000).toISOString(),
      });
    } catch (err) {
      return toolFail(`Timeout failed: ${toErrorMessage(err)}`);
    }
  },
});

const warnUser = defineTool({
  name: "warn_user",
  category: "moderation",
  description:
    "Issue a formal warning to a user: the warning is recorded in the dedicated moderation warning ledger and the bot attempts to DM the user the warning text.",
  examples: ["warn @user for breaking rule 3", "give them a warning for spamming links"],
  riskLevel: "medium",
  requiresConfirmation: false,
  requiredDiscordPermissions: ["MODERATE_MEMBERS"],
  cooldownSeconds: 10,
  argsSchema: z.object({
    userId: z.string().min(5),
    reason: z.string().min(3).max(400),
  }),
  execute: async (args, ctx) => {
    const guild = ctx.message?.guild;
    if (!guild) return toolFail("warn_user only works inside a server.");
    if (!ctx.db) {
      return toolFail("warn_user requires database persistence so warnings stay recoverable.");
    }

    try {
      const member = await guild.members.fetch(args.userId);
      const warning = await ctx.db.moderationWarning.create({
        data: {
          guildId: guild.id,
          channelId: ctx.channelId,
          moderatorUserId: ctx.userId,
          warnedUserId: args.userId,
          warnedUsername: member.user.username,
          reason: args.reason,
          moderatorMessageId: ctx.message?.id ?? null,
          metadataJson: { source: "warn_user_tool" },
        },
      });

      let dmDelivered = false;
      try {
        await member.send(`You received a warning in **${guild.name}**: ${args.reason}`);
        dmDelivered = true;
      } catch {
        // DMs can be closed; the moderation ledger remains the source of truth.
      }

      if (dmDelivered) {
        await ctx.db.moderationWarning.update({
          where: { id: warning.id },
          data: { dmDelivered: true },
        });
      }

      return toolOk({
        warningId: warning.id,
        recorded: true,
        userId: args.userId,
        username: member.user.username,
        reason: args.reason,
        dmDelivered,
        note: "Warning recorded in the dedicated moderation warning ledger.",
      });
    } catch (err) {
      return toolFail(`Warn failed: ${toErrorMessage(err)}`);
    }
  },
});

const deleteMessage = defineTool({
  name: "delete_message",
  category: "moderation",
  description: "Delete a single message by id (in the current channel unless channelId is given).",
  examples: ["delete that message", "remove message 123456789"],
  riskLevel: "medium",
  requiresConfirmation: false,
  requiredDiscordPermissions: ["MANAGE_MESSAGES"],
  cooldownSeconds: 5,
  argsSchema: z.object({
    messageId: z.string().min(5),
    channelId: z.string().optional(),
  }),
  execute: async (args, ctx) => {
    const client = ctx.discordClient ?? ctx.message?.client;
    if (!client) return toolFail("Discord client unavailable in this context.");
    try {
      const channelId = args.channelId ?? ctx.channelId;
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        return toolFail(`Channel ${channelId} is not a text channel I can access.`);
      }
      const message = await channel.messages.fetch(args.messageId);
      await message.delete();
      return toolOk({
        deleted: true,
        messageId: args.messageId,
        channelId,
        author: message.author.username,
      });
    } catch (err) {
      return toolFail(`Delete failed: ${toErrorMessage(err)}`);
    }
  },
});

const getUserInfo = defineTool({
  name: "get_user_info",
  category: "moderation",
  description:
    "Look up information about a server member: username, display name, account creation date, server join date, roles, and current timeout status.",
  examples: ["who is @user?", "get info on that user", "when did they join the server?"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 5,
  argsSchema: z.object({
    userId: z.string().min(5),
  }),
  execute: async (args, ctx) => {
    const guild = ctx.message?.guild;
    if (!guild) return toolFail("get_user_info only works inside a server.");
    try {
      const member = await guild.members.fetch(args.userId);
      return toolOk({
        id: member.id,
        username: member.user.username,
        displayName: member.displayName,
        bot: member.user.bot,
        accountCreatedAt: member.user.createdAt.toISOString(),
        joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
        roles: member.roles.cache
          .filter((role) => role.name !== "@everyone")
          .map((role) => role.name)
          .slice(0, 15),
        timedOutUntil: member.communicationDisabledUntil
          ? member.communicationDisabledUntil.toISOString()
          : null,
      });
    } catch (err) {
      return toolFail(`Lookup failed: ${toErrorMessage(err)}`);
    }
  },
});

export const moderationTools: RegisteredTool[] = [timeoutUser, warnUser, deleteMessage, getUserInfo];
