import { ChannelType, type Client, type Message } from "discord.js";
import type { Logger } from "pino";
import type { AgentController } from "../../ai/orchestration/AgentController";
import type { GuildRepository, GuildSettings } from "../../database/repositories/GuildRepository";
import { isTextChannelAllowed } from "../../guild/GuildPolicy";
import { toErrorMessage } from "../../utils/errors";
import { buildMessageContext, buildRecentTranscript } from "../utils/discordContext";
import { splitMessage } from "../utils/messageSplitter";
import { handleCommand, type CommandServices } from "../commands";

export interface MessageHandlerOptions {
  client: Client;
  agent: AgentController;
  commandServices: CommandServices;
  commandPrefix: string; // e.g. "!ai"
  settingsStore?: Pick<GuildRepository, "getSettings"> | null;
  logger: Logger;
}

/**
 * messageCreate handler.
 *
 * Engagement policy (spam/cost control): the bot responds to
 *  - `!ai ...` prefix commands,
 *  - direct messages,
 *  - messages that @mention it,
 *  - replies to its own messages.
 * Per-guild channel allowlists live in GuildProfile.settingsJson and are
 * enforced before typing, command execution, LLM calls, or training capture.
 */
export function createMessageHandler(options: MessageHandlerOptions) {
  const { client, agent, commandServices, commandPrefix, logger } = options;

  return async function onMessageCreate(message: Message): Promise<void> {
    try {
      // Ignore bots (including ourselves) and empty/system messages.
      if (message.author.bot) return;
      const content = message.content.trim();
      if (content.length === 0) return;

      const isDM = message.channel.type === ChannelType.DM;
      const isCommand = content.toLowerCase().startsWith(commandPrefix.toLowerCase());
      const mentionsBot = client.user ? message.mentions.users.has(client.user.id) : false;
      const isReplyToBot = await isReplyToOurMessage(message, client);

      if (!isCommand && !isDM && !mentionsBot && !isReplyToBot) return;

      // Strip the prefix / leading mention for downstream processing.
      let stripped = content;
      if (isCommand) {
        stripped = content.slice(commandPrefix.length).trim();
      } else if (mentionsBot && client.user) {
        stripped = content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
        if (stripped.length === 0) stripped = "hey";
      }

      const ctx = buildMessageContext(message, stripped);
      const guildSettings = await readGuildSettings(options.settingsStore ?? null, ctx.guildId, logger);
      if (guildSettings) ctx.guildSettings = guildSettings;
      if (!isTextChannelAllowed({ ...ctx, settings: guildSettings })) {
        logger.debug(
          { guildId: ctx.guildId, channelId: ctx.channelId, allowChannels: guildSettings?.allowChannels ?? [] },
          "message ignored by guild channel allowlist",
        );
        return;
      }

      await withTyping(message, async () => {
        const reply = isCommand
          ? await handleCommand(ctx, commandServices)
          : (
              await agent.handleDiscordMessage(ctx, {
                transcript: await buildRecentTranscript(message, client),
              })
            ).content;

        await sendChunked(message, reply);
      });
    } catch (err) {
      logger.error({ err: toErrorMessage(err) }, "messageCreate handler failed");
      await message
        .reply("Something broke on my end — try again in a bit.")
        .catch(() => undefined);
    }
  };
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
    logger.warn({ guildId, err: toErrorMessage(err) }, "failed to read guild settings; continuing without");
    return null;
  }
}

/** Keep the typing indicator alive while the handler runs (refresh ~8s). */
async function withTyping(message: Message, fn: () => Promise<void>): Promise<void> {
  const channel = message.channel;
  const canType = "sendTyping" in channel;
  if (canType) await channel.sendTyping().catch(() => undefined);
  const interval = canType
    ? setInterval(() => void channel.sendTyping().catch(() => undefined), 8000)
    : null;
  try {
    await fn();
  } finally {
    if (interval) clearInterval(interval);
  }
}

async function sendChunked(message: Message, content: string): Promise<void> {
  const chunks = splitMessage(content);
  const first = chunks[0];
  if (first === undefined) return;
  await message.reply({ content: first, allowedMentions: { repliedUser: true, parse: [] } });
  for (const chunk of chunks.slice(1)) {
    if ("send" in message.channel) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }
}

async function isReplyToOurMessage(message: Message, client: Client): Promise<boolean> {
  if (!message.reference?.messageId || !client.user) return false;
  try {
    const referenced = await message.fetchReference();
    return referenced.author.id === client.user.id;
  } catch {
    return false;
  }
}
