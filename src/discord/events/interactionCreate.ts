import type { ChatInputCommandInteraction, Interaction } from "discord.js";
import type { Logger } from "pino";
import type { AgentController } from "../../ai/orchestration/AgentController";
import type { GuildRepository, GuildSettings } from "../../database/repositories/GuildRepository";
import { isTextChannelAllowed } from "../../guild/GuildPolicy";
import type { BotMessageContext } from "../../types/discord";
import { toErrorMessage } from "../../utils/errors";
import { handleCommand, type CommandServices } from "../commands";
import { AI_SLASH_COMMAND_NAME, AI_SLASH_INPUT_OPTION } from "../slashCommands";
import { splitMessage } from "../utils/messageSplitter";
import { permissionNames } from "../utils/permissions";

export interface InteractionHandlerOptions {
  agent: AgentController;
  commandServices: CommandServices;
  settingsStore?: Pick<GuildRepository, "getSettings"> | null;
  logger: Logger;
}

const COMMAND_NAMES = new Set([
  "",
  "help",
  "ping",
  "tools",
  "tool",
  "memory",
  "settings",
  "voice",
  "export-training",
  "stats",
  "health",
]);

export function createInteractionHandler(options: InteractionHandlerOptions) {
  const { agent, commandServices, logger } = options;

  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== AI_SLASH_COMMAND_NAME) return;

    try {
      await interaction.deferReply();
      const input = interaction.options.getString(AI_SLASH_INPUT_OPTION, true).trim();
      if (!input) {
        await interaction.editReply({
          content: "Usage: `/ai input: ping` or `/ai input: hello Irene`.",
          allowedMentions: { parse: [] },
        });
        return;
      }

      const ctx = buildInteractionContext(interaction, input);
      const guildSettings = await readGuildSettings(options.settingsStore ?? null, ctx.guildId, logger);
      if (guildSettings) ctx.guildSettings = guildSettings;

      const allowedByTextPolicy = isTextChannelAllowed({ ...ctx, settings: guildSettings });
      if (!allowedByTextPolicy && !isSettingsRecoveryCommand(ctx)) {
        await interaction.editReply({
          content: "Irene is not enabled in this text channel. Ask a server manager to update `!ai settings show`.",
          allowedMentions: { parse: [] },
        });
        return;
      }

      const reply = isCommandInput(input)
        ? await handleCommand(ctx, commandServices)
        : (
            await agent.handleDiscordMessage(ctx, {
              transcript: null,
            })
          ).content;

      await sendInteractionChunks(interaction, reply);
    } catch (err) {
      logger.error({ err: toErrorMessage(err) }, "interactionCreate handler failed");
      await safeInteractionError(interaction);
    }
  };
}

function buildInteractionContext(interaction: ChatInputCommandInteraction, content: string): BotMessageContext {
  return {
    guildId: interaction.guildId,
    guildName: interaction.guild?.name ?? null,
    channelId: interaction.channelId,
    channelName:
      interaction.channel && "name" in interaction.channel && typeof interaction.channel.name === "string"
        ? interaction.channel.name
        : null,
    userId: interaction.user.id,
    username: interaction.user.username,
    displayName: memberDisplayName(interaction.member),
    messageId: interaction.id,
    content,
    isDM: !interaction.inGuild(),
    mentionsBot: false,
    memberPermissions: interaction.inGuild() ? permissionNames(interaction.memberPermissions) : ["SEND_MESSAGES"],
  };
}

function memberDisplayName(member: ChatInputCommandInteraction["member"]): string | null {
  if (!member || typeof member !== "object") return null;
  if ("displayName" in member && typeof member.displayName === "string") return member.displayName;
  if ("nick" in member && typeof member.nick === "string") return member.nick;
  return null;
}

function isCommandInput(input: string): boolean {
  const command = input.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return COMMAND_NAMES.has(command);
}

function isSettingsRecoveryCommand(ctx: BotMessageContext): boolean {
  if (!ctx.content.toLowerCase().startsWith("settings")) return false;
  return ctx.memberPermissions.some((permission) => ["ADMINISTRATOR", "MANAGE_GUILD"].includes(permission));
}

async function readGuildSettings(
  store: Pick<GuildRepository, "getSettings"> | null,
  guildId: string | null,
  logger: Logger,
): Promise<GuildSettings | null> {
  if (!store || !guildId) return null;
  try {
    return await store.getSettings(guildId);
  } catch (err) {
    logger.warn({ guildId, err: toErrorMessage(err) }, "failed to read guild settings for interaction; continuing without");
    return null;
  }
}

async function sendInteractionChunks(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const chunks = splitMessage(content);
  const first = chunks[0] ?? "";
  await interaction.editReply({ content: first, allowedMentions: { parse: [] } });
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } });
  }
}

async function safeInteractionError(interaction: ChatInputCommandInteraction): Promise<void> {
  const message = "Something broke on my end while handling that slash command.";
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: message, allowedMentions: { parse: [] } }).catch(() => undefined);
  } else {
    await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
  }
}
